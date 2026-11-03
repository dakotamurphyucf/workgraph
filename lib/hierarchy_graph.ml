open Core

module Node = struct
  type t =
    { ticket : Id.Ticket.t
    ; parent : Id.Ticket.t option
    ; prerequisites : Id.Ticket.t list
    ; waived : Id.Ticket.t list
    ; done_ : bool
    ; descendant_prerequisites : Hierarchy_policy.Descendant_prerequisites.t
    }
end

module Blocker = struct
  type t =
    { prerequisite : Id.Ticket.t
    ; ancestor : Id.Ticket.t option
    }
  [@@deriving sexp, equal]
end

type t = { find : Id.Ticket.t -> Node.t option }

let create ~find = { find }
let require condition kind message = if not condition then Json.fail kind message

let find_exn t ticket =
  match t.find ticket with
  | None -> Json.fail Not_found "Hierarchy ticket not found"
  | Some node ->
    require
      (Id.Ticket.equal node.Node.ticket ticket)
      Invalid_argument
      "Hierarchy lookup identity differs";
    node
;;

let inherits (node : Node.t) =
  Hierarchy_policy.Descendant_prerequisites.equal node.descendant_prerequisites Inherit
;;

let is_waived (node : Node.t) id = List.mem node.waived id ~equal:Id.Ticket.equal

let blockers t ~ticket =
  Json.decode (fun () ->
    let node = find_exn t ticket in
    let add_owner blockers (owner : Node.t) ~ancestor =
      List.fold owner.prerequisites ~init:blockers ~f:(fun blockers prerequisite ->
        let target = find_exn t prerequisite in
        if Map.mem blockers prerequisite || is_waived owner prerequisite || target.done_
        then blockers
        else Map.set blockers ~key:prerequisite ~data:{ Blocker.prerequisite; ancestor })
    in
    let direct = add_owner Id.Ticket.Map.empty node ~ancestor:None in
    let rec ancestors blockers visited = function
      | None -> Map.data blockers
      | Some parent ->
        require (not (Set.mem visited parent)) Dependency_cycle "Hierarchy parent cycle";
        let owner = find_exn t parent in
        let blockers =
          if inherits owner
          then add_owner blockers owner ~ancestor:(Some parent)
          else blockers
        in
        ancestors blockers (Set.add visited parent) owner.parent
    in
    ancestors direct (Id.Ticket.Set.singleton ticket) node.parent)
;;

let add_dependent dependents ~prerequisite ~ticket =
  Map.update dependents prerequisite ~f:(fun existing ->
    Set.add (Option.value existing ~default:Id.Ticket.Set.empty) ticket)
;;

let validate t ~tickets =
  Json.decode (fun () ->
    require
      (not (List.contains_dup tickets ~compare:Id.Ticket.compare))
      Invalid_argument
      "Duplicate hierarchy ticket";
    let inventory = Id.Ticket.Set.of_list tickets in
    (* Capture the callback once per node. All subsequent validation operates on
       this immutable map, including when a caller supplied a mutable callback. *)
    let nodes =
      List.fold tickets ~init:Id.Ticket.Map.empty ~f:(fun nodes ticket ->
        Map.set nodes ~key:ticket ~data:(find_exn t ticket))
    in
    let check_reference id =
      require (Set.mem inventory id) Not_found "Hierarchy reference not found"
    in
    let children =
      Map.fold nodes ~init:Id.Ticket.Map.empty ~f:(fun ~key:ticket ~data:node children ->
        require
          (not (List.contains_dup node.Node.prerequisites ~compare:Id.Ticket.compare))
          Invalid_argument
          "Duplicate hierarchy prerequisite";
        require
          (not (List.contains_dup node.waived ~compare:Id.Ticket.compare))
          Invalid_argument
          "Duplicate hierarchy waiver";
        List.iter node.prerequisites ~f:check_reference;
        List.iter node.waived ~f:(fun id ->
          require
            (List.mem node.prerequisites id ~equal:Id.Ticket.equal)
            Invalid_argument
            "Hierarchy waiver has no direct edge");
        match node.parent with
        | None -> children
        | Some parent ->
          check_reference parent;
          add_dependent children ~prerequisite:parent ~ticket)
    in
    let ready = Queue.create () in
    Map.iteri nodes ~f:(fun ~key ~data:node ->
      if Option.is_none node.Node.parent then Queue.enqueue ready key);
    let inherited = ref Id.Ticket.Map.empty in
    let effective = ref Id.Ticket.Map.empty in
    while not (Queue.is_empty ready) do
      let ticket = Queue.dequeue_exn ready in
      let node = Map.find_exn nodes ticket in
      let ancestor_edges =
        match node.parent with
        | None -> Id.Ticket.Set.empty
        | Some parent ->
          let parent_node = Map.find_exn nodes parent in
          let higher = Map.find_exn !inherited parent in
          if inherits parent_node
          then Set.union higher (Id.Ticket.Set.of_list parent_node.prerequisites)
          else higher
      in
      inherited := Map.set !inherited ~key:ticket ~data:ancestor_edges;
      effective
      := Map.set
           !effective
           ~key:ticket
           ~data:(Set.union ancestor_edges (Id.Ticket.Set.of_list node.prerequisites));
      Option.iter (Map.find children ticket) ~f:(fun ids ->
        Set.iter ids ~f:(Queue.enqueue ready))
    done;
    require
      (Map.length !effective = Map.length nodes)
      Dependency_cycle
      "Hierarchy parent cycle";
    let remaining = ref (Map.map !effective ~f:Set.length) in
    let dependents =
      Map.fold
        !effective
        ~init:Id.Ticket.Map.empty
        ~f:(fun ~key:ticket ~data:edges dependents ->
          Set.fold edges ~init:dependents ~f:(fun dependents prerequisite ->
            add_dependent dependents ~prerequisite ~ticket))
    in
    Map.iteri !remaining ~f:(fun ~key ~data:count ->
      if count = 0 then Queue.enqueue ready key);
    let visited = ref 0 in
    while not (Queue.is_empty ready) do
      let ticket = Queue.dequeue_exn ready in
      incr visited;
      Option.iter (Map.find dependents ticket) ~f:(fun ids ->
        Set.iter ids ~f:(fun dependent ->
          let count = Map.find_exn !remaining dependent - 1 in
          remaining := Map.set !remaining ~key:dependent ~data:count;
          if count = 0 then Queue.enqueue ready dependent))
    done;
    require
      (!visited = Map.length nodes)
      Dependency_cycle
      "Direct and inherited prerequisites form a cycle")
;;
