open Core
open Planning_state
module A = Activity_read_api
module W = Coordination_wire
module F = Api_codec.Fields

let ( ++ ) = F.both

let unwrap = function
  | Ok value -> value
  | Error p -> raise (Json.Decode_error p)
;;

module Cursor = struct
  type t =
    { capture : string
    ; filter : string
    ; byte_offset : int
    }

  let codec =
    Api_codec.object_
      (F.map
         (F.required "version" (Api_codec.literal "audit-1")
          ++ F.required "capture" (W.nonblank ~max_bytes:2048)
          ++ F.required "filter" (Api_codec.text ~max_bytes:64)
          ++ F.required "byte_offset" W.counter)
         ~decode:(fun ((((), capture), filter), byte_offset) ->
           { capture; filter; byte_offset })
         ~encode:(fun t -> (((), t.capture), t.filter), t.byte_offset))
  ;;

  let encode t = W.encode_exn codec t |> Json.canonical |> Base64.encode_string

  let decode value =
    match Base64.decode value with
    | Ok bytes when String.equal value (Base64.encode_string bytes) ->
      W.decode_exn codec (Json.parse bytes |> unwrap)
    | Ok _ | Error _ -> Json.fail Invalid_argument "invalid audit cursor encoding"
  ;;
end

let change : Event.t -> Planning_activity_wire.Change.t = function
  | Facts_changed v -> Facts_changed v
  | Communication_changed v -> Communication_changed v
  | Agent_run_changed v -> Agent_run_changed v
  | Hierarchy_policy_put v -> Hierarchy_policy_put v
  | Amendment_unchanged v -> Amendment_unchanged v
  | Amendment_changed v -> Amendment_changed v
  | Evidence_changed v -> Evidence_changed v
  | Policy_changed v -> Policy_changed v
  | Policy_unchanged v -> Policy_unchanged v
  | Allocation_empty { run; attempt } ->
    Allocation_empty { run_id = run; attempt_id = attempt }
  | Ticket_recovered v -> Ticket_recovered v
  | Signal_receipt v -> Signal_receipt v
  | Settings_changed v -> Settings_changed v
  | Workspace_updated v -> Workspace_updated (workspace_settings_view v)
  | Project_put v -> Project_put (project_view v)
  | Milestone_put v -> Milestone_put (milestone_view v)
  | Ticket_put v -> Ticket_put (ticket_view v)
  | Comment_changed v -> Comment_changed v
  | Handoff_put v -> Handoff_put (handoff_view v)
  | Resource_changed v -> Resource_changed v
;;

let read t request =
  Json.decode (fun () ->
    Option.iter (A.Request.target request) ~f:(validate_target t);
    let filter =
      Json.obj
        [ ( "target"
          , Option.value_map
              (A.Request.target request)
              ~default:`Null
              ~f:Entity_ref.jsonaf_of_t )
        ; ( "actor"
          , Option.value_map
              (A.Request.actor request)
              ~default:`Null
              ~f:Id.Actor.jsonaf_of_t )
        ]
      |> Json.canonical
      |> Json.hash
    in
    let position, byte_offset, through =
      match A.Request.cursor request with
      | None ->
        let after = Option.value (A.Request.after request) ~default:0 in
        if after > t.revision
        then Json.fail Conflict "audit position exceeds current snapshot";
        unwrap (Digest_cursor.Position.after_revision after), 0, t.revision
      | Some value ->
        let cursor = Cursor.decode value in
        if not (String.equal filter cursor.filter)
        then Json.fail Conflict "audit cursor selectors changed";
        let capture = Digest_cursor.decode cursor.capture |> unwrap in
        Digest_cursor.validate
          capture
          ~workspace:t.workspace
          ~scope:Resume_api.Scope.Workspace
          ~activity:t.activity
        |> unwrap;
        Digest_cursor.position capture, cursor.byte_offset, Digest_cursor.through capture
    in
    let lineage = Planning_lineage.of_activity t.activity ~through |> unwrap in
    let cursor position byte_offset =
      let capture =
        Digest_cursor.create
          ~workspace:t.workspace
          ~scope:Resume_api.Scope.Workspace
          ~position
          ~lineage
        |> unwrap
        |> Digest_cursor.encode
      in
      Cursor.encode { capture; filter; byte_offset }
    in
    let source =
      List.rev t.activity
      |> List.filter ~f:(fun event ->
        Json.integer (Json.field event "revision") <= through
        && Option.for_all (A.Request.target request) ~f:(fun target ->
          Json.list (Json.field event "targets")
          |> List.exists ~f:(fun v -> Entity_ref.equal target (Entity_ref.t_of_jsonaf v)))
        && Option.for_all (A.Request.actor request) ~f:(fun actor ->
          Id.Actor.equal actor (Id.Actor.t_of_jsonaf (Json.field event "actor"))))
      |> List.concat_map ~f:(fun event ->
        let revision = Json.integer (Json.field event "revision") in
        let changes = Json.list (Json.field event "changes") in
        List.filter_mapi changes ~f:(fun change_index raw ->
          if Digest_cursor.Position.follows position ~revision ~change_index
          then Some (event, revision, change_index, List.length changes, raw)
          else None))
    in
    if byte_offset > 0 && List.is_empty source
    then Json.fail Conflict "audit chunk source unavailable";
    let max_bytes = A.Request.max_bytes request in
    let finish items remaining position byte_offset =
      let page : A.Page.t =
        { through
        ; lineage = Planning_lineage.digest lineage
        ; items
        ; cursor = (if remaining = 0 then None else Some (cursor position byte_offset))
        ; remaining_changes = remaining
        }
      in
      let data = W.encode_exn A.Page.codec page in
      let omitted =
        Int.min remaining (Int.max 0 (A.Request.limit request - List.length items))
      in
      let budget bytes =
        Json.obj
          [ "max_bytes", Json.int max_bytes
          ; "returned_bytes", Json.int bytes
          ; ("truncated", if omitted > 0 then `True else `False)
          ; "omitted_fields", Json.int 0
          ; "omitted_items", Json.int omitted
          ; ( "details"
            , if omitted = 0
              then `Array []
              else
                `Array
                  [ Json.obj
                      [ "path", Json.string "/data/items"
                      ; "kind", Json.string "items"
                      ; "omitted", Json.int omitted
                      ]
                  ] )
          ; "details_complete", `True
          ]
      in
      let rec size bytes =
        let result =
          Json.obj
            [ "workspace_revision", Json.int t.revision
            ; "data", data
            ; "budget", budget bytes
            ]
        in
        let actual = Api_response.encoded_size Planning_read result in
        if actual = bytes then result, actual else size actual
      in
      size 0
    in
    let rec take source position byte_offset selected count =
      match source with
      | [] -> fst (finish (List.rev selected) 0 position 0)
      | (event, revision, change_index, change_count, raw) :: rest ->
        if count = A.Request.limit request
        then fst (finish (List.rev selected) (List.length source) position byte_offset)
        else (
          let record : Planning_activity_wire.Activity.t =
            { revision
            ; actor_id = Id.Actor.t_of_jsonaf (Json.field event "actor")
            ; run_id =
                Option.bind (Json.optional event "run_id") ~f:(function
                  | `Null -> None
                  | value -> Some (Id.Run.t_of_jsonaf value))
            ; timestamp = Json.text (Json.field event "timestamp")
            ; targets =
                Json.list (Json.field event "targets")
                |> List.map ~f:Entity_ref.t_of_jsonaf
            ; changes = [ change (Event.t_of_jsonaf raw) ]
            }
          in
          let bytes =
            W.encode_exn Planning_activity_wire.Activity.codec record |> Json.canonical
          in
          if
            byte_offset >= String.length bytes
            || not (byte_offset = 0 || Char.to_int bytes.[byte_offset] land 0xc0 <> 0x80)
          then Json.fail Conflict "audit chunk offset outside source or UTF8 boundary";
          let completed =
            Digest_cursor.Position.create ~revision ~change_index |> unwrap
          in
          let row payload : A.Row.t =
            { revision
            ; change_index
            ; change_count
            ; byte_offset
            ; total_bytes = String.length bytes
            ; digest = Json.hash bytes
            ; payload
            }
          in
          let whole = row (Change record) in
          let fits candidate remaining next_position next_offset =
            snd
              (finish
                 (List.rev (candidate :: selected))
                 remaining
                 next_position
                 next_offset)
            <= max_bytes
          in
          if byte_offset = 0 && fits whole (List.length rest) completed 0
          then take rest completed 0 (whole :: selected) (count + 1)
          else if not (List.is_empty selected)
          then fst (finish (List.rev selected) (List.length source) position byte_offset)
          else (
            let available = String.drop_prefix bytes byte_offset in
            let make length =
              let text = Query_budget.prefix available ~max_bytes:length in
              let next_offset = byte_offset + String.length text in
              let complete = next_offset = String.length bytes in
              let remaining = if complete then List.length rest else List.length source in
              let next_position, next_offset =
                if complete then completed, 0 else position, next_offset
              in
              let candidate = row (Chunk text) in
              candidate, remaining, next_position, next_offset
            in
            let rec search low high best =
              if low > high
              then best
              else (
                let middle = low + ((high - low) / 2) in
                let candidate, remaining, next_position, next_offset = make middle in
                let nonempty =
                  match candidate.payload with
                  | Chunk value -> not (String.is_empty value)
                  | Change _ -> true
                in
                if nonempty && fits candidate remaining next_position next_offset
                then
                  search
                    (middle + 1)
                    high
                    (Some (candidate, remaining, next_position, next_offset))
                else search low (middle - 1) best)
            in
            match search 1 (Int.min (String.length available) max_bytes) None with
            | None ->
              Json.fail Invalid_argument "audit continuation metadata exceeds max_bytes"
            | Some (candidate, remaining, next_position, next_offset) ->
              fst (finish [ candidate ] remaining next_position next_offset)))
    in
    take source position byte_offset [] 0)
;;
