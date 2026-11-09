open Core
open Workgraph

module Plan = struct
  type t =
    { workspace : Id.Workspace.t
    ; planning_cursor : string option
    ; history : bool
    ; history_cursor : string option
    ; runtime : bool
    ; runtime_signature : string option
    ; wait : bool
    }

  let of_json value =
    Json.decode (fun () ->
      Json.fields
        value
        ~allowed:
          [ "workspace_id"
          ; "planning_cursor"
          ; "history"
          ; "history_cursor"
          ; "wait"
          ; "runtime"
          ; "runtime_signature"
          ];
      let cursor name =
        match Json.field value name with
        | `Null -> None
        | value ->
          let cursor = Json.text value in
          if String.is_empty cursor || String.length cursor > 2048
          then Json.fail Invalid_argument "invalid live observation cursor";
          Some cursor
      in
      let planning_cursor = cursor "planning_cursor" in
      let history_cursor = cursor "history_cursor" in
      let history =
        Api_codec.decode Api_codec.boolean (Json.field value "history") |> Disk.unwrap
      in
      if (not history) && Option.is_some history_cursor
      then Json.fail Invalid_argument "history cursor requires history observation";
      let runtime =
        Api_codec.decode Api_codec.boolean (Json.field value "runtime") |> Disk.unwrap
      in
      let runtime_signature = cursor "runtime_signature" in
      Option.iter runtime_signature ~f:(fun hash ->
        if
          (not runtime)
          || String.length hash <> 64
          || not
               (String.for_all hash ~f:(fun c ->
                  Char.is_digit c || Char.between c ~low:'a' ~high:'f'))
        then Json.fail Invalid_argument "invalid runtime observation signature");
      { workspace = Id.Workspace.t_of_jsonaf (Json.field value "workspace_id")
      ; planning_cursor
      ; history
      ; history_cursor
      ; runtime
      ; runtime_signature
      ; wait = Api_codec.decode Api_codec.boolean (Json.field value "wait") |> Disk.unwrap
      })
  ;;
end

type t =
  { invoke : Connection_profile.t -> Plan.t -> (Jsonaf.t, Problem.t) Result.t
  ; mutable active : int
  }

let create ~net ~clock =
  let qualification = Daemon_qualification.create ~clock in
  let invoke connection plan =
    Json.decode (fun () ->
      let client =
        Client.create
          ~net
          ~clock
          ~socket:(Connection_profile.socket connection)
          ~timeout_seconds:35.
        |> Disk.unwrap
      in
      Daemon_qualification.check qualification client |> Disk.unwrap;
      let read source position ~wait =
        let method_ = if wait then "changes.wait" else "changes.read" in
        let request =
          Protocol.Request.create
            ~id:"ui-live"
            ~method_
            ~params:
              (Json.obj
                 ([ "workspace_id", Id.Workspace.jsonaf_of_t plan.Plan.workspace
                  ; ( "source"
                    , Api_codec.encode Change_feed_api.Source.codec source |> Disk.unwrap
                    )
                  ; "limit", Json.int 100
                  ; "max_bytes", Json.int 1048576
                  ]
                  @ position
                  @ if wait then [ "timeout_ms", Json.int 25000 ] else []))
          |> Disk.unwrap
        in
        let response =
          Client.invoke client request
          |> Disk.unwrap
          |> Api_response.of_json
          |> Disk.unwrap
        in
        let page =
          Api_codec.decode Change_feed_api.Response.codec (Api_response.data response)
          |> Disk.unwrap
        in
        if not (Change_feed_api.Source.equal source page.source)
        then Json.fail Invalid_argument "live observation returned the wrong feed";
        page
      in
      let bootstrap source cursor =
        match cursor with
        | Some cursor -> read source [ "cursor", Json.string cursor ] ~wait:false
        | None ->
          let head = read source [] ~wait:false in
          read source [ "after", Json.int head.through ] ~wait:false
      in
      let planning, history =
        Eio.Fiber.pair
          (fun () -> bootstrap Planning plan.planning_cursor)
          (fun () ->
             if plan.history then Some (bootstrap History plan.history_cursor) else None)
      in
      let changed page =
        (not (List.is_empty page.Change_feed_api.Response.items))
        || page.has_more
        || page.needs_larger_budget
      in
      let initial =
        Option.is_none plan.planning_cursor
        || (plan.history && Option.is_none plan.history_cursor)
      in
      let planning, history =
        if
          initial
          || (not plan.wait)
          || changed planning
          || Option.exists history ~f:changed
        then planning, history
        else (
          match history with
          | None ->
            read Planning [ "cursor", Json.string planning.cursor ] ~wait:true, None
          | Some history ->
            Eio.Fiber.first
              (fun () ->
                 ( read Planning [ "cursor", Json.string planning.cursor ] ~wait:true
                 , Some history ))
              (fun () ->
                 ( planning
                 , Some (read History [ "cursor", Json.string history.cursor ] ~wait:true)
                 )))
      in
      let runtime_signature =
        if not plan.runtime
        then None
        else (
          (* Only advisory warning state is clock-sensitive. Ages are display
             values, not changes: hashing them would recreate timer polling. *)
          let rec without_age = function
            | `Object fields ->
              Json.obj
                (List.filter_map fields ~f:(fun (key, value) ->
                   if String.equal key "observation_age_ms"
                   then None
                   else Some (key, without_age value)))
            | `Array values -> `Array (List.map values ~f:without_age)
            | value -> value
          in
          let rec collect cursor acc =
            let request =
              Protocol.Request.create
                ~id:"ui-live-runtime"
                ~method_:"coordinator.overview"
                ~params:
                  (Json.obj
                     ([ "workspace_id", Id.Workspace.jsonaf_of_t plan.workspace
                      ; ( "kinds"
                        , `Array
                            (List.map
                               [ "stale_run"; "stale_ownership"; "expired_ownership" ]
                               ~f:Json.string) )
                      ; "limit", Json.int 100
                      ; "max_bytes", Json.int 1048576
                      ]
                      @ Option.value_map cursor ~default:[] ~f:(fun cursor ->
                        [ "cursor", Json.string cursor ])))
              |> Disk.unwrap
            in
            let response =
              Client.invoke client request
              |> Disk.unwrap
              |> Api_response.of_json
              |> Disk.unwrap
            in
            let page =
              Api_codec.decode
                Coordinator_wire.Response.codec
                (Api_response.data response)
              |> Disk.unwrap
            in
            if not (Id.Workspace.equal page.workspace_id plan.workspace)
            then
              Json.fail
                Invalid_argument
                "runtime observation returned the wrong workspace";
            if page.needs_larger_budget
            then Json.fail Invalid_argument "runtime warning exceeds observation budget";
            let acc =
              List.fold page.items ~init:acc ~f:(fun acc item ->
                let encoded =
                  Api_codec.encode Coordinator_wire.Item.codec item
                  |> Disk.unwrap
                  |> without_age
                in
                encoded :: acc)
            in
            match page.next_cursor with
            | Some cursor -> collect (Some cursor) acc
            | None -> Some (Json.hash (Json.canonical (`Array (List.rev acc))))
          in
          collect None [])
      in
      let runtime_changed =
        not (Option.equal String.equal plan.runtime_signature runtime_signature)
      in
      Json.obj
        [ "workspace_id", Id.Workspace.jsonaf_of_t plan.workspace
        ; ( "runtime_signature"
          , Option.value_map runtime_signature ~default:`Null ~f:Json.string )
        ; ("runtime_changed", if runtime_changed then `True else `False)
        ; ( "planning"
          , Api_codec.encode Change_feed_api.Response.codec planning |> Disk.unwrap )
        ; ( "history"
          , Option.value_map history ~default:`Null ~f:(fun page ->
              Api_codec.encode Change_feed_api.Response.codec page |> Disk.unwrap) )
        ])
  in
  { invoke; active = 0 }
;;

let observe t ~connection plan =
  if t.active >= 16
  then
    Error
      (Problem.with_details
         (Problem.create Blocked "live observation capacity is full")
         (Problem.Details.Capacity
            { meter = "ui-live-observations"
            ; used = t.active
            ; limit = 16
            ; attempted = t.active + 1
            ; unit = "tabs"
            ; operator_action =
                "Close an unused tab; the UI retries observation automatically."
            }))
  else (
    t.active <- t.active + 1;
    Exn.protect
      ~f:(fun () -> t.invoke connection plan)
      ~finally:(fun () -> t.active <- t.active - 1))
;;
