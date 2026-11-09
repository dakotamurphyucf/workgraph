open Core
open Workgraph

module Lane = struct
  type t =
    | Visible
    | History
    | Search
    | Wait
  [@@deriving equal, sexp]

  let to_string = function
    | Visible -> "visible"
    | History -> "history"
    | Search -> "search"
    | Wait -> "wait"
  ;;

  let of_string = function
    | "visible" -> Ok Visible
    | "history" -> Ok History
    | "search" -> Ok Search
    | "wait" -> Ok Wait
    | _ ->
      Error
        (Problem.create
           Invalid_argument
           "read lane must be visible, history, search or wait")
  ;;
end

type lane =
  { kind : Lane.t
  ; limit : int
  ; semaphore : Eio.Semaphore.t
  ; mutable active : int
  ; mutable queued : int
  }

type t = lane list

let create () =
  List.map
    [ Lane.Visible, 4; History, 2; Search, 1; Wait, 2 ]
    ~f:(fun (kind, limit) ->
      { kind; limit; semaphore = Eio.Semaphore.make limit; active = 0; queued = 0 })
;;

let run t ~lane ~f =
  let lane = List.find_exn t ~f:(fun candidate -> Lane.equal lane candidate.kind) in
  if Eio.Semaphore.get_value lane.semaphore <= 0 && lane.queued >= 32
  then
    Error
      (Problem.with_details
         (Problem.create Blocked "companion read queue is full")
         (Problem.Details.Capacity
            { meter = "ui-read-" ^ Lane.to_string lane.kind
            ; used = lane.queued
            ; limit = 32
            ; attempted = lane.queued + 1
            ; unit = "requests"
            ; operator_action =
                "Cancel obsolete reads or wait for this lane to drain before an explicit \
                 new read."
            }))
  else (
    let queued = Eio.Semaphore.get_value lane.semaphore <= 0 in
    if queued then lane.queued <- lane.queued + 1;
    Exn.protect
      ~finally:(fun () -> if queued then lane.queued <- lane.queued - 1)
      ~f:(fun () -> Eio.Semaphore.acquire lane.semaphore);
    lane.active <- lane.active + 1;
    Exn.protect ~f ~finally:(fun () ->
      lane.active <- lane.active - 1;
      Eio.Semaphore.release lane.semaphore))
;;

let to_json t =
  Json.obj
    [ ( "lanes"
      , `Array
          (List.map t ~f:(fun lane ->
             Json.obj
               [ "lane", Json.string (Lane.to_string lane.kind)
               ; "active", Json.int lane.active
               ; "queued", Json.int lane.queued
               ; "active_limit", Json.int lane.limit
               ; "queue_limit", Json.int 32
               ])) )
    ]
;;
