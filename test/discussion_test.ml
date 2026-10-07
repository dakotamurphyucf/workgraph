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
