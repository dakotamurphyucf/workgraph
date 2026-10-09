open Core
open Workgraph

let%expect_test "target index matches independent global-history filtering" =
  Quickcheck.test
    ~trials:100
    (Quickcheck.Generator.list_with_length 64 (Int.gen_incl 0 3))
    ~f:(fun targets ->
      let state = ref Discussion.empty in
      let actor = Id.Actor.of_string "actor" |> Disk.unwrap in
      let id n = Id.Comment.of_string (sprintf "c%03d" n) |> Disk.unwrap in
      let target n =
        Entity_ref.Ticket (Id.Ticket.of_string (sprintf "t%d" n) |> Disk.unwrap)
      in
      let version ~revision ~tombstone =
        let serial = Discussion.next_serial !state in
        { Discussion.Version.revision
        ; serial
        ; sequence = serial
        ; actor
        ; timestamp = "2026-10-07"
        ; body = (if tombstone then "" else Int.to_string serial)
        ; tombstone
        }
      in
      List.iteri targets ~f:(fun n selected ->
        let version = version ~revision:1 ~tombstone:false in
        state
        := Discussion.apply
             !state
             (Create
                { id = id n
                ; target = target selected
                ; reply_to = None
                ; kind = Progress
                ; origin = Authored
                ; version
                })
             ~sequence:version.sequence);
      for n = 0 to 31 do
        let id = id (n * 2) in
        let version =
          version ~revision:(Discussion.revision !state id + 1) ~tombstone:(n mod 4 = 0)
        in
        state
        := Discussion.apply !state (Revise { id; version }) ~sequence:version.sequence
      done;
      List.iter [ false; true ] ~f:(fun include_tombstones ->
        let global = Discussion.list !state ~target:None ~include_tombstones in
        for selected = 0 to 4 do
          let target = target selected in
          let belongs entry =
            Entity_ref.equal target (Entity_ref.t_of_jsonaf (Json.field entry "target"))
          in
          let expected = List.filter global ~f:belongs in
          let actual = Discussion.list !state ~target:(Some target) ~include_tombstones in
          if
            not
              (String.equal
                 (Json.canonical (`Array expected))
                 (Json.canonical (`Array actual)))
          then failwith "scoped list differs from global reference";
          if include_tombstones
          then
            List.iter [ 0; 32; 64; 80; 96 ] ~f:(fun after ->
              let expected =
                List.concat_map expected ~f:(fun entry ->
                  Discussion.history
                    !state
                    (Id.Comment.t_of_jsonaf (Json.field entry "comment_id")))
                |> List.filter ~f:(fun version ->
                  Json.integer (Json.field version "sequence") > after)
                |> List.sort ~compare:(fun a b ->
                  Int.compare
                    (Json.integer (Json.field a "serial"))
                    (Json.integer (Json.field b "serial")))
              in
              let actual = Discussion.since !state ~target ~after in
              if
                not
                  (String.equal
                     (Json.canonical (`Array expected))
                     (Json.canonical (`Array actual)))
              then failwith "scoped history differs from global reference")
        done));
  print_endline "100 target-index histories match global reference";
  [%expect {| 100 target-index histories match global reference |}]
;;

let%expect_test "resolved discussion changes enforce authorship and immutable origin" =
  let actor = Id.Actor.of_string "author" |> Disk.unwrap in
  let other = Id.Actor.of_string "other" |> Disk.unwrap in
  let id = Id.Comment.of_string "evidence" |> Disk.unwrap in
  let target = Entity_ref.Ticket (Id.Ticket.of_string "work" |> Disk.unwrap) in
  let version =
    { Discussion.Version.revision = 1
    ; serial = 1
    ; sequence = 1
    ; actor
    ; timestamp = "now"
    ; body = "original"
    ; tombstone = false
    }
  in
  let create origin target kind reply_to =
    Discussion.Change.Create { id; target; reply_to; kind; origin; version }
  in
  let report f =
    match Json.decode f with
    | Ok _ -> print_endline "ok"
    | Error problem -> print_s [%sexp (problem.kind : Problem.kind)]
  in
  let completed =
    Discussion.apply Discussion.empty (create Completion target Evidence None) ~sequence:1
  in
  let authored =
    Discussion.apply Discussion.empty (create Authored target Evidence None) ~sequence:1
  in
  List.iter [ completed; authored ] ~f:(fun state ->
    List.iter [ actor; other ] ~f:(fun actor ->
      List.iter [ false; true ] ~f:(fun tombstone ->
        report (fun () ->
          Discussion.apply
            state
            (Revise
               { id
               ; version =
                   { version with
                     revision = 2
                   ; serial = 2
                   ; sequence = 2
                   ; actor
                   ; body = (if tombstone then "" else "correction")
                   ; tombstone
                   }
               })
            ~sequence:2))));
  List.iter
    [ create Completion Workspace Evidence None
    ; create Completion target Progress None
    ; create Completion target Evidence (Some id)
    ]
    ~f:(fun change ->
      report (fun () -> Discussion.apply Discussion.empty change ~sequence:1));
  report (fun () -> Discussion.Origin.t_of_jsonaf (Json.string "unknown"));
  [%expect
    {|
    Conflict
    Conflict
    Conflict
    Conflict
    ok
    ok
    Conflict
    Conflict
    Corrupt_store
    Corrupt_store
    Corrupt_store
    Invalid_argument
  |}]
;;
