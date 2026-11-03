open Core

let page_size = 100
let preview_bytes = 4096

let blob_link label (blob : Session_event.Blob_ref.t) =
  "["
  ^ label
  ^ "](../../portable/blobs/"
  ^ blob.digest
  ^ ") ("
  ^ Int.to_string blob.size_bytes
  ^ " bytes)"
;;

let event_text event ~read_text =
  let ref_ = Session_event.ref_ event in
  let metadata =
    Json.obj
      [ "session_id", Json.string (Session_id.to_string ref_.session)
      ; "sequence", Json.int ref_.sequence
      ; "actor_id", Id.Actor.jsonaf_of_t (Session_event.actor event)
      ; ( "run_id"
        , Option.value_map (Session_event.run event) ~default:`Null ~f:Id.Run.jsonaf_of_t
        )
      ; "role", Json.string (Session_event.role event)
      ; "kind", Json.string (Session_event.kind event)
      ; "source_id", Json.string (Session_event.client_id event)
      ]
  in
  let text =
    match Session_event.searchable_text event with
    | None ->
      "_No readable text was supplied for this event; inspect its exact payload._\n"
    | Some blob ->
      (* Include lookahead so UTF-8 clipping can find the codepoint boundary. *)
      let prefix = read_text blob ~max_bytes:(preview_bytes + 4) in
      let prefix = Query_budget.prefix prefix ~max_bytes:preview_bytes in
      let omitted = blob.size_bytes - String.length prefix in
      Readable_markdown.literal prefix
      ^ (if omitted > 0
         then "\n_This preview omits " ^ Int.to_string omitted ^ " bytes._\n"
         else "")
      ^ "\n"
      ^ blob_link "Complete readable text" blob
      ^ "\n"
  in
  "\n## Event "
  ^ Int.to_string ref_.sequence
  ^ "\n\n"
  ^ Readable_markdown.literal (Json.pretty metadata)
  ^ "\n"
  ^ text
  ^ "\n"
  ^ blob_link "Exact payload" (Session_event.payload event)
  ^ "\n"
  ^ (List.mapi (Session_event.attachments event) ~f:(fun index blob ->
       "- " ^ blob_link ("Attachment " ^ Int.to_string (index + 1)) blob ^ "\n")
     |> String.concat)
;;

let files capture ~read_text =
  Session_store.Capture.sessions capture
  |> Sequence.of_list
  |> Sequence.concat_map ~f:(fun session ->
    let id = Session_id.to_string (Session.id session) in
    let events = Session_store.Capture.events capture ~session:(Session.id session) in
    let count = List.length events in
    let pages = (count + page_size - 1) / page_size in
    let page_name index = "page-" ^ Int.to_string (index + 1) ^ ".md" in
    let index =
      "# Session "
      ^ id
      ^ "\n"
      ^ Readable_markdown.section ~heading:"Title" (Session.title session)
      ^ "\nCaptured events: "
      ^ Int.to_string count
      ^ ". Text previews are bounded; every event links its complete captured bytes.\n\n"
      ^ (List.init pages ~f:(fun page ->
           "- [Events "
           ^ Int.to_string ((page * page_size) + 1)
           ^ "–"
           ^ Int.to_string (Int.min count ((page + 1) * page_size))
           ^ "]("
           ^ page_name page
           ^ ")\n")
         |> String.concat)
    in
    Sequence.append
      (Sequence.singleton ("history/" ^ id ^ "/index.md", index))
      (Sequence.of_list events
       |> fun events ->
       Sequence.chunks_exn events page_size
       |> Sequence.mapi ~f:(fun page events ->
         ( "history/" ^ id ^ "/" ^ page_name page
         , "# Session "
           ^ id
           ^ "\n\n[Session index](index.md)\n"
           ^ (List.map events ~f:(fun event -> event_text event ~read_text)
              |> String.concat) ))))
;;
