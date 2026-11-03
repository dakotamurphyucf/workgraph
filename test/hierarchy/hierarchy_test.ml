open Core
open Workgraph

let ok = function
  | Ok value -> value
  | Error problem -> failwith problem.Problem.message
;;

let id value = Id.Ticket.of_string value |> ok
let json value = Json.parse value |> ok
let encode codec value = Api_codec.encode codec value |> ok |> Json.canonical

let report = function
  | Ok _ -> print_endline "ok"
  | Error problem -> print_endline (Problem.wire_name problem.Problem.kind)
;;

let policy : Hierarchy_policy.t =
  { descendant_prerequisites = Inherit; child_completion = Done_or_canceled }
;;

let definition ?(revision = 1) ?(reason = "Explicit parent policy") () =
  Hierarchy_policy.Definition.create ~ticket:(id "parent") ~revision ~policy ~reason
;;

let%expect_test
    "policy constructors public stored and sexp codecs share explicit invariants"
  =
  let value = definition () |> ok in
  print_endline (encode Hierarchy_policy.Definition.codec value);
  let stored = Hierarchy_policy.Definition.jsonaf_of_t value in
  printf
    "stored=%b sexp=%b\n"
    (Hierarchy_policy.Definition.equal
       value
       (Hierarchy_policy.Definition.t_of_jsonaf stored))
    (Hierarchy_policy.Definition.equal
       value
       (Hierarchy_policy.Definition.t_of_sexp
          (Hierarchy_policy.Definition.sexp_of_t value)));
  report (definition ~revision:0 ());
  report (definition ~reason:"  " ());
  report (definition ~reason:(String.make 65_537 'x') ());
  report (definition ~reason:"\255" ());
  let malformed =
    {|((ticket parent)(revision 0)(policy((descendant_prerequisites Inherit)(child_completion Done_or_canceled)))(reason audit))|}
  in
  printf
    "invalid-sexp=%b\n"
    (Result.is_error
       (Or_error.try_with (fun () ->
          Hierarchy_policy.Definition.t_of_sexp (Sexp.of_string malformed))));
  [%expect
    {|
    {"child_completion":"done_or_canceled","descendant_prerequisites":"inherit","reason":"Explicit parent policy","revision":"1","ticket_id":"parent"}
    stored=true sexp=true
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    invalid-sexp=true
  |}]
;;

let%expect_test
    "public policy writes require both enums explicit revision and exact audit reason"
  =
  let valid =
    json
      {|{"ticket_id":"parent","expected_revision":"0","descendant_prerequisites":"inherit","child_completion":"all_done","reason":"Deliberate scheduling"}|}
  in
  print_endline
    (encode
       Hierarchy_api.Put.codec
       (Api_codec.decode Hierarchy_api.Put.codec valid |> ok));
  List.iter
    [ {|{"ticket_id":"parent","expected_revision":"0","descendant_prerequisites":"inherit","reason":"Audit"}|}
    ; {|{"ticket_id":"parent","expected_revision":"0","descendant_prerequisites":"inherit","child_completion":"terminal","reason":"Audit"}|}
    ; {|{"ticket_id":"parent","expected_revision":"-1","descendant_prerequisites":"inherit","child_completion":"all_done","reason":"Audit"}|}
    ; {|{"ticket_id":"parent","expected_revision":"0","descendant_prerequisites":"inherit","child_completion":"all_done","reason":" "}|}
    ; {|{"ticket_id":"parent","expected_revision":"0","descendant_prerequisites":"inherit","child_completion":"all_done","reason":"Audit","extra":true}|}
    ]
    ~f:(fun text -> report (Api_codec.decode Hierarchy_api.Put.codec (json text)));
  let absent = Hierarchy_api.Snapshot.create ~ticket:(id "parent") ~policy:None |> ok in
  print_endline (encode Hierarchy_api.Snapshot.codec absent);
  let explicit =
    Hierarchy_policy.Definition.create
      ~ticket:(id "parent")
      ~revision:1
      ~policy:Hierarchy_policy.default
      ~reason:"Explicit defaults"
    |> ok
  in
  let snapshot =
    Hierarchy_api.Snapshot.create ~ticket:(id "parent") ~policy:(Some explicit) |> ok
  in
  printf
    "same-effective=%b different-storage=%b\n"
    (Hierarchy_policy.equal
       (Hierarchy_api.Snapshot.effective absent)
       (Hierarchy_api.Snapshot.effective snapshot))
    (Bool.equal
       (Option.is_none (Hierarchy_api.Snapshot.stored absent))
       (Option.is_some (Hierarchy_api.Snapshot.stored snapshot)));
  report (Hierarchy_api.Snapshot.create ~ticket:(id "other") ~policy:(Some explicit));
  report
    (Api_codec.decode
       Hierarchy_api.Snapshot.codec
       (json
          {|{"ticket_id":"parent","policy":null,"effective":{"descendant_prerequisites":"inherit","child_completion":"all_done"}}|}));
  [%expect
    {|
    {"child_completion":"all_done","descendant_prerequisites":"inherit","expected_revision":"0","reason":"Deliberate scheduling","ticket_id":"parent"}
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    {"effective":{"child_completion":"all_done","descendant_prerequisites":"independent"},"policy":null,"ticket_id":"parent"}
    same-effective=true different-storage=true
    Invalid_argument
    Invalid_argument
  |}]
;;

let node
      ?parent
      ?(prerequisites = [])
      ?(waived = [])
      ?(done_ = false)
      ?(inherit_ = false)
      name
  : Hierarchy_graph.Node.t
  =
  { ticket = id name
  ; parent = Option.map parent ~f:id
  ; prerequisites = List.map prerequisites ~f:id
  ; waived = List.map waived ~f:id
  ; done_
  ; descendant_prerequisites = (if inherit_ then Inherit else Independent)
  }
;;

let capture nodes =
  let table =
    List.map nodes ~f:(fun node -> node.Hierarchy_graph.Node.ticket, node)
    |> Id.Ticket.Map.of_alist_exn
  in
  Hierarchy_graph.create ~find:(Map.find table)
;;

let validate nodes =
  Hierarchy_graph.validate
    (capture nodes)
    ~tickets:(List.map nodes ~f:(fun node -> node.Hierarchy_graph.Node.ticket))
;;

let blockers nodes ticket =
  Hierarchy_graph.blockers (capture nodes) ~ticket:(id ticket)
  |> ok
  |> List.iter ~f:(fun value ->
    printf
      "%s:%s "
      (Id.Ticket.to_string value.Hierarchy_graph.Blocker.prerequisite)
      (Option.value_map value.ancestor ~default:"direct" ~f:Id.Ticket.to_string));
  print_endline ""
;;

let%expect_test
    "nested opt-ins propagate only ancestor edges through independent intermediate \
     parents"
  =
  let base =
    [ node ~prerequisites:[ "p" ] ~inherit_:true ~done_:true "root"
    ; node ~parent:"root" ~prerequisites:[ "q" ] ~done_:true "middle"
    ; node ~parent:"middle" "leaf"
    ; node "p"
    ; node "q"
    ]
  in
  report (validate base);
  blockers base "leaf";
  let nested =
    List.map base ~f:(fun node ->
      if Id.Ticket.equal node.Hierarchy_graph.Node.ticket (id "middle")
      then { node with descendant_prerequisites = Inherit }
      else node)
  in
  blockers nested "leaf";
  blockers nested "middle";
  let completed =
    List.map nested ~f:(fun node ->
      if Id.Ticket.equal node.Hierarchy_graph.Node.ticket (id "p")
      then { node with done_ = true }
      else node)
  in
  blockers completed "leaf";
  [%expect
    {|
    ok
    p:root
    p:root q:middle
    p:root q:direct
    q:middle
  |}]
;;

let%expect_test "closest unwaived source and own direct condition win deterministically" =
  let base =
    [ node ~prerequisites:[ "p" ] ~inherit_:true "root"
    ; node ~parent:"root" ~prerequisites:[ "p" ] ~inherit_:true "middle"
    ; node ~parent:"middle" ~prerequisites:[ "p" ] "leaf"
    ; node "p"
    ]
  in
  blockers base "leaf";
  let waive nodes name =
    List.map nodes ~f:(fun node ->
      if Id.Ticket.equal node.Hierarchy_graph.Node.ticket (id name)
      then { node with waived = [ id "p" ] }
      else node)
  in
  let own_waived = waive base "leaf" in
  blockers own_waived "leaf";
  let middle_waived = waive own_waived "middle" in
  blockers middle_waived "leaf";
  printf
    "all-waived=%d\n"
    (List.length
       (Hierarchy_graph.blockers
          (capture (waive middle_waived "root"))
          ~ticket:(id "leaf")
        |> ok));
  [%expect
    {|
    p:direct
    p:middle
    p:root
    all-waived=0
  |}]
;;

let%expect_test
    "canceled-child policy changes only local child completion, not prerequisite success"
  =
  List.iter
    [ Workflow.Category.Done; Canceled; Todo; In_progress; Backlog ]
    ~f:(fun status ->
      printf
        "%b/%b "
        (Hierarchy_policy.Child_completion.satisfied All_done ~status)
        (Hierarchy_policy.Child_completion.satisfied Done_or_canceled ~status));
  print_endline "";
  blockers
    [ node ~prerequisites:[ "canceled" ] ~inherit_:true "parent"
    ; node ~parent:"parent" "child"
    ; node ~done_:false "canceled"
    ]
    "child";
  [%expect
    {|
    true/true false/true false/false false/false false/false
    canceled:parent
  |}]
;;

let%expect_test
    "inherited cycles reject even completed or waived, including late reparenting"
  =
  let base =
    [ node ~prerequisites:[ "leaf" ] ~waived:[ "leaf" ] ~done_:true "parent"
    ; node ~parent:"parent" ~done_:true "leaf"
    ]
  in
  report (validate base);
  report
    (validate
       (List.map base ~f:(fun node ->
          if Id.Ticket.equal node.Hierarchy_graph.Node.ticket (id "parent")
          then { node with descendant_prerequisites = Inherit }
          else node)));
  let before = [ node ~prerequisites:[ "leaf" ] ~inherit_:true "parent"; node "leaf" ] in
  report (validate before);
  report (validate [ List.hd_exn before; node ~parent:"parent" "leaf" ]);
  report (validate [ node ~prerequisites:[ "b" ] "a"; node ~prerequisites:[ "a" ] "b" ]);
  report (validate [ node ~parent:"b" "a"; node ~parent:"a" "b" ]);
  [%expect
    {|
    ok
    Dependency_cycle
    ok
    Dependency_cycle
    Dependency_cycle
    Dependency_cycle
  |}]
;;

let%expect_test
    "graph validates references and waivers and preserves unexpected callback failures"
  =
  List.iter
    [ [ node ~parent:"missing" "a" ]
    ; [ node ~prerequisites:[ "missing" ] "a" ]
    ; [ node ~waived:[ "a" ] "a" ]
    ; [ node ~prerequisites:[ "b"; "b" ] "a"; node "b" ]
    ]
    ~f:(fun nodes -> report (validate nodes));
  report (Hierarchy_graph.blockers (capture []) ~ticket:(id "unknown"));
  let graph =
    Hierarchy_graph.create ~find:(fun _ -> failwith "unexpected lookup failure")
  in
  (match
     Or_error.try_with (fun () -> Hierarchy_graph.blockers graph ~ticket:(id "a"))
   with
   | Error _ -> print_endline "unexpected propagated"
   | Ok _ -> failwith "callback failure disguised");
  [%expect
    {|
    Not_found
    Not_found
    Invalid_argument
    Invalid_argument
    Not_found
    unexpected propagated
  |}]
;;

let%expect_test
    "union cycle validation agrees with independent bounded reachability model"
  =
  Quickcheck.test
    (List.gen_with_length 6 (Int.gen_incl 0 127))
    ~trials:100
    ~f:(fun masks ->
      let ids = List.init 6 ~f:(fun index -> id ("n" ^ Int.to_string index)) in
      let nodes =
        List.mapi masks ~f:(fun index mask ->
          let prerequisites =
            List.filteri ids ~f:(fun bit _ -> mask land (1 lsl bit) <> 0)
          in
          { Hierarchy_graph.Node.ticket = List.nth_exn ids index
          ; parent = (if index = 0 then None else Some (List.nth_exn ids (index - 1)))
          ; prerequisites
          ; waived = (if index mod 2 = 0 then prerequisites else [])
          ; done_ = index mod 2 = 0
          ; descendant_prerequisites = (if mask land 64 = 0 then Independent else Inherit)
          })
      in
      let table =
        List.map nodes ~f:(fun node -> node.Hierarchy_graph.Node.ticket, node)
        |> Id.Ticket.Map.of_alist_exn
      in
      let edges ticket =
        let node = Map.find_exn table ticket in
        let rec ancestors edges = function
          | None -> edges
          | Some parent ->
            let owner = Map.find_exn table parent in
            let edges =
              if
                Hierarchy_policy.Descendant_prerequisites.equal
                  owner.descendant_prerequisites
                  Inherit
              then owner.prerequisites @ edges
              else edges
            in
            ancestors edges owner.parent
        in
        ancestors node.prerequisites node.parent
      in
      let rec cyclic path ticket =
        Set.mem path ticket
        || List.exists (edges ticket) ~f:(cyclic (Set.add path ticket))
      in
      let expected_cycle = List.exists ids ~f:(cyclic Id.Ticket.Set.empty) in
      assert (Bool.equal expected_cycle (Result.is_error (validate nodes))));
  print_endline "100 generated union graphs agree";
  [%expect {|100 generated union graphs agree|}]
;;

let%expect_test
    "stored current hierarchy definitions reject missing unknown and invalid fields"
  =
  let stored = Hierarchy_policy.Definition.jsonaf_of_t (definition () |> ok) in
  let edit field replacement =
    match stored with
    | `Object fields ->
      `Object
        (List.filter_map fields ~f:(fun (key, value) ->
           if String.equal key field
           then Option.map replacement ~f:(fun value -> key, value)
           else Some (key, value)))
    | _ -> failwith "stored object expected"
  in
  List.iter
    [ edit "revision" (Some (`String "0"))
    ; edit "child_completion" None
    ; edit "descendant_prerequisites" (Some (`String "automatic"))
    ; edit "reason" (Some (`String " "))
    ; edit "ticket" (Some (`String "bad id"))
    ; (match stored with
       | `Object fields -> `Object (("extra", `True) :: fields)
       | _ -> failwith "object")
    ]
    ~f:(fun value ->
      report (Json.decode (fun () -> Hierarchy_policy.Definition.t_of_jsonaf value)));
  report (Api_codec.decode Hierarchy_policy.Definition.codec stored);
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
    Invalid_argument
  |}]
;;

let%expect_test "deep ancestor validation and blocker resolution use iterative traversal" =
  let nodes =
    List.init 2_000 ~f:(fun index ->
      let name = "n" ^ Int.to_string index in
      if index = 0
      then node ~prerequisites:[ "p" ] ~inherit_:true name
      else node ~parent:("n" ^ Int.to_string (index - 1)) name)
    @ [ node "p" ]
  in
  report (validate nodes);
  blockers nodes "n1999";
  [%expect
    {|
    ok
    p:n0
  |}]
;;

let%expect_test "blocker provenance agrees with prerequisite-first reference selection" =
  Quickcheck.test
    (List.gen_with_length 6 (Int.gen_incl 0 127))
    ~trials:100
    ~f:(fun masks ->
      let ids = List.init 6 ~f:(fun index -> id ("n" ^ Int.to_string index)) in
      let nodes =
        List.mapi masks ~f:(fun index mask ->
          let prerequisites =
            List.filteri ids ~f:(fun bit _ -> bit < index && mask land (1 lsl bit) <> 0)
          in
          { Hierarchy_graph.Node.ticket = List.nth_exn ids index
          ; parent = (if index = 0 then None else Some (List.nth_exn ids (index - 1)))
          ; prerequisites
          ; waived = (if index mod 2 = 0 then prerequisites else [])
          ; done_ = index mod 3 = 0
          ; descendant_prerequisites = (if mask land 64 = 0 then Independent else Inherit)
          })
      in
      let table =
        List.map nodes ~f:(fun node -> node.Hierarchy_graph.Node.ticket, node)
        |> Id.Ticket.Map.of_alist_exn
      in
      let graph = capture nodes in
      assert (Result.is_ok (Hierarchy_graph.validate graph ~tickets:ids));
      List.iter ids ~f:(fun ticket ->
        let rec owners ticket =
          let node = Map.find_exn table ticket in
          node :: Option.value_map node.parent ~default:[] ~f:owners
        in
        let owners = owners ticket in
        let expected =
          List.filter_map ids ~f:(fun prerequisite ->
            if (Map.find_exn table prerequisite).done_
            then None
            else
              List.find_mapi owners ~f:(fun distance owner ->
                if
                  (distance = 0
                   || Hierarchy_policy.Descendant_prerequisites.equal
                        owner.descendant_prerequisites
                        Inherit)
                  && List.mem owner.prerequisites prerequisite ~equal:Id.Ticket.equal
                  && not (List.mem owner.waived prerequisite ~equal:Id.Ticket.equal)
                then
                  Some
                    { Hierarchy_graph.Blocker.prerequisite
                    ; ancestor = (if distance = 0 then None else Some owner.ticket)
                    }
                else None))
        in
        assert (
          List.equal
            Hierarchy_graph.Blocker.equal
            expected
            (Hierarchy_graph.blockers graph ~ticket |> ok))));
  List.iter
    [ [ node "a"; node "a" ]
    ; [ node ~prerequisites:[ "p" ] ~waived:[ "p"; "p" ] "a"; node "p" ]
    ]
    ~f:(fun nodes ->
      let graph =
        Hierarchy_graph.create ~find:(fun ticket ->
          List.find nodes ~f:(fun node ->
            Id.Ticket.equal ticket node.Hierarchy_graph.Node.ticket))
      in
      report
        (Hierarchy_graph.validate
           graph
           ~tickets:(List.map nodes ~f:(fun node -> node.Hierarchy_graph.Node.ticket))));
  print_endline "600 blocker projections agree";
  [%expect
    {|
    Invalid_argument
    Invalid_argument
    600 blocker projections agree
  |}]
;;
