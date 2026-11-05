open Core
open Planning_state
module D = Reservation_contention
module A = Reservation_contention_api
module W = Coordination_wire

let unwrap = function
  | Ok x -> x
  | Error p -> raise (Json.Decode_error p)
;;

let read t request ~now_unix_ms =
  Json.decode (fun () ->
    let target = A.Request.target request in
    let filter =
      Json.obj
        [ "view", Json.string "reservation.contention"
        ; "target", W.encode_exn D.Target.codec target
        ; ( "include_inactive"
          , if A.Request.include_inactive request then `True else `False )
        ]
    in
    let captured =
      Attention_cursor.capture
        ~workspace:t.workspace
        ~revision:t.revision
        ~activity:t.activity
        ~filter
        ~after:None
        ~cursor:(A.Request.cursor request)
        ~now_unix_ms
      |> unwrap
    in
    if captured.through <> t.revision
    then Json.fail Conflict "contention capture changed; rescan required";
    let clock = captured.clock in
    let state = Agent_run.contention t.agent_runs in
    let rows = ref [] in
    let add key row = rows := (key, row) :: !rows in
    let note target (holder : Reservation.Holder.t) =
      Option.bind (D.holder_note state ~target ~run:holder.run) ~f:(fun note ->
        if
          Int.equal note.token holder.token
          && Id.Actor.equal note.actor holder.actor
          && Option.exists note.contents ~f:(fun c -> Int64.(clock < c.expires_unix_ms))
        then Some note
        else None)
    in
    let holder actual holder =
      if D.Target.overlaps target actual
      then (
        let note = note actual holder in
        let note_clock_regressed =
          Option.exists note ~f:(fun n -> Int64.(clock < n.updated_unix_ms))
        in
        let row = A.Row.Holder { target = actual; holder; note; note_clock_regressed } in
        add (A.Row.order_key row) row)
    in
    List.iter (Agent_run.reservations t.agent_runs) ~f:(fun r ->
      List.iter r.Reservation.holders ~f:(holder (D.Target.Named r.name)));
    List.iter (Agent_run.path_reservations t.agent_runs) ~f:(fun r ->
      List.iter r.Path_reservation.holders ~f:(holder (D.Target.Path r.target)));
    List.iter (D.waiters state) ~f:(fun record ->
      if D.Target.overlaps target record.target
      then (
        let run =
          match Agent_run.get_run t.agent_runs record.run with
          | Some r -> r
          | None -> Json.fail Corrupt_store "contention waiter run missing"
        in
        let row = A.Row.waiter record ~run_status:run.status ~now_unix_ms:clock in
        match row with
        | Waiter { phase = (Waiting | Closed | Expired | Run_terminal) as phase; _ } ->
          if A.Request.include_inactive request || A.Row.equal_phase phase Waiting
          then add (A.Row.order_key row) row
        | Holder _ -> assert false));
    let rows =
      List.sort !rows ~compare:(fun (a, _) (b, _) -> String.compare a b)
      |> List.map ~f:(fun (_, r) -> W.encode_exn A.Row.codec r)
    in
    let result =
      Attention_cursor.current_page
        ~workspace:t.workspace
        ~revision:t.revision
        ~activity:t.activity
        ~filter
        ~cursor:(A.Request.cursor request)
        ~now_unix_ms
        ~rows
        ~limit:(A.Request.limit request)
        ~max_bytes:(A.Request.max_bytes request)
      |> unwrap
    in
    ignore
      (Api_codec.decode A.read_response_codec (Json.field result "data") |> unwrap
       : Jsonaf.t);
    result)
;;
