open Core
module W = Coordination_wire
module F = Api_codec.Fields
module Kind = Coordinator_wire.Kind

let ( ++ ) = F.both
let opt = F.optional

let bound low high =
  W.checked (Api_codec.decimal ~max:high) (fun n ->
    if n < low then Json.fail Invalid_argument "query bound too small")
;;

module Request = struct
  type t =
    { project : Id.Project.t option
    ; run : Id.Run.t option
    ; actor : Id.Actor.t option
    ; kinds : Kind.t list
    ; cursor : string option
    ; limit : int
    ; max_bytes : int
    ; stale_after_ms : int64
    ; dependency_path_to : Id.Ticket.t option
    }

  let codec =
    Api_codec.object_
      (F.map
         (opt "project_id" (W.id Id.Project.of_string Id.Project.to_string)
          ++ opt "run_id" W.run
          ++ opt "actor_id" W.actor
          ++ opt
               "kinds"
               (W.checked (Api_codec.list Kind.codec ~max_items:15) (fun kinds ->
                  if
                    List.contains_dup kinds ~compare:(fun a b ->
                      String.compare (Kind.to_string a) (Kind.to_string b))
                  then Json.fail Invalid_argument "duplicate coordinator kinds"))
          ++ opt "cursor" (W.nonblank ~max_bytes:2048)
          ++ opt "limit" (bound 1 100)
          ++ opt "max_bytes" (bound 4096 1048576)
          ++ opt
               "stale_after_ms"
               (W.checked (Api_codec.decimal64 ~max:Int64.max_value) (fun n ->
                  if Int64.(n <= zero)
                  then Json.fail Invalid_argument "staleness must be positive"))
          ++ opt "dependency_path_to" W.ticket)
         ~decode:
           (fun
             ( ( ((((((project, run), actor), kinds), cursor), limit), max_bytes)
               , stale_after_ms )
             , dependency_path_to ) ->
           { project
           ; run
           ; actor
           ; kinds = Option.value kinds ~default:Kind.all
           ; cursor
           ; limit = Option.value limit ~default:50
           ; max_bytes = Option.value max_bytes ~default:65536
           ; stale_after_ms = Option.value stale_after_ms ~default:300000L
           ; dependency_path_to
           })
         ~encode:(fun t ->
           ( ( ( (((((t.project, t.run), t.actor), Some t.kinds), t.cursor), Some t.limit)
               , Some t.max_bytes )
             , Some t.stale_after_ms )
           , t.dependency_path_to )))
  ;;

  let project t = t.project
  let run t = t.run
  let actor t = t.actor
  let kinds t = t.kinds
  let cursor t = t.cursor
  let limit t = t.limit
  let max_bytes t = t.max_bytes
  let stale_after_ms t = t.stale_after_ms
  let dependency_path_to t = t.dependency_path_to
end

let method_ =
  Api_method.create
    ~name:"coordinator.overview"
    ~summary:"Whole typed metadata across one current coordination capture."
    ~mode:Read
    ~request:Request.codec
    ~response:Coordinator_wire.Response.codec
;;

let methods = [ Api_method.Packed.Pack method_ ]
