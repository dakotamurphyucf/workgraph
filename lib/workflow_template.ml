open Core

module Instance_id = struct
  module T = struct
    type t = string [@@deriving sexp_of, compare, equal]

    let of_string s = Result.map (Id.Run.of_string s) ~f:Id.Run.to_string

    let t_of_sexp sexp =
      match of_string (String.t_of_sexp sexp) with
      | Ok s -> s
      | Error e -> Sexplib.Conv.of_sexp_error e.message sexp
    ;;
  end

  include T
  include Comparable.Make (T)

  let to_string t = t
  let jsonaf_of_t = Json.string

  let t_of_jsonaf j =
    match of_string (Json.text j) with
    | Ok t -> t
    | Error e -> raise (Json.Decode_error e)
  ;;
end

let require condition kind message = if not condition then Json.fail kind message

let checked = function
  | Ok t -> t
  | Error e -> raise (Json.Decode_error e)
;;

let bounded text max =
  require (String.length text <= max) Invalid_argument "Workflow text exceeds byte limit"
;;

let nonempty text max =
  bounded text max;
  require
    (not (String.is_empty (String.strip text)))
    Invalid_argument
    "Workflow text is empty"
;;

let name text = ignore (checked (Id.Run.of_string text) : Id.Run.t)

let optional json f =
  match json with
  | `Null -> None
  | j -> Some (f j)
;;

module Node = struct
  type t =
    { alias : string
    ; title : string
    ; description : string
    ; depends_on : string list
    ; parent : string option
    ; capabilities : string list
    ; reviewers : Id.Actor.t list
    ; separate_actor : bool
    }
  [@@deriving sexp, equal]

  let to_json t =
    Json.obj
      [ "alias", Json.string t.alias
      ; "title", Json.string t.title
      ; "description", Json.string t.description
      ; "depends_on", `Array (List.map t.depends_on ~f:Json.string)
      ; "parent", Option.value_map t.parent ~default:`Null ~f:Json.string
      ; "capabilities", `Array (List.map t.capabilities ~f:Json.string)
      ; "reviewers", `Array (List.map t.reviewers ~f:Id.Actor.jsonaf_of_t)
      ; ("separate_actor", if t.separate_actor then `True else `False)
      ]
  ;;

  let of_json json =
    Json.fields
      json
      ~allowed:
        [ "alias"
        ; "title"
        ; "description"
        ; "depends_on"
        ; "parent"
        ; "capabilities"
        ; "reviewers"
        ; "separate_actor"
        ];
    let get = Json.field json in
    { alias = Json.text (get "alias")
    ; title = Json.text (get "title")
    ; description = Json.text (get "description")
    ; depends_on = List.map (Json.list (get "depends_on")) ~f:Json.text
    ; parent = optional (get "parent") Json.text
    ; capabilities = List.map (Json.list (get "capabilities")) ~f:Json.text
    ; reviewers = List.map (Json.list (get "reviewers")) ~f:Id.Actor.t_of_jsonaf
    ; separate_actor =
        (match get "separate_actor" with
         | `True -> true
         | `False -> false
         | _ -> Json.fail Invalid_argument "Expected boolean")
    }
  ;;
end

module Spec = struct
  type t =
    { parameters : string list
    ; nodes : Node.t list
    }
  [@@deriving sexp, equal]

  let validate_exn t =
    require
      (List.length t.parameters <= 32
       && not (List.contains_dup t.parameters ~compare:String.compare))
      Invalid_argument
      "Invalid workflow parameters";
    List.iter t.parameters ~f:name;
    require
      ((not (List.is_empty t.nodes)) && List.length t.nodes <= 31)
      Invalid_argument
      "Workflow requires 1..31 nodes";
    let aliases = List.map t.nodes ~f:(fun n -> n.Node.alias) in
    require
      (not (List.contains_dup aliases ~compare:String.compare))
      Invalid_argument
      "Duplicate workflow alias";
    List.iter t.nodes ~f:(fun n ->
      name n.Node.alias;
      nonempty n.title 512;
      bounded n.description 65536;
      require
        (List.length n.capabilities <= 100
         && List.length n.reviewers <= 100
         && List.length n.depends_on <= 31)
        Invalid_argument
        "Workflow node links exceed limit";
      List.iter n.capabilities ~f:(fun c -> nonempty c 96);
      require
        ((not (List.contains_dup n.capabilities ~compare:String.compare))
         && (not (List.contains_dup n.reviewers ~compare:Id.Actor.compare))
         && not (List.contains_dup n.depends_on ~compare:String.compare))
        Invalid_argument
        "Duplicate workflow node link";
      List.iter
        (n.depends_on @ Option.to_list n.parent)
        ~f:(fun alias ->
          require
            (List.mem aliases alias ~equal:String.equal)
            Not_found
            "Workflow alias does not exist"));
    let visited = ref String.Set.empty in
    let rec visit path alias =
      require
        (not (Set.mem path alias))
        Dependency_cycle
        "Workflow dependency or parent cycle";
      if not (Set.mem !visited alias)
      then (
        let n = List.find_exn t.nodes ~f:(fun n -> String.equal n.Node.alias alias) in
        List.iter (n.depends_on @ Option.to_list n.parent) ~f:(visit (Set.add path alias));
        visited := Set.add !visited alias)
    in
    List.iter aliases ~f:(visit String.Set.empty);
    let operations =
      1
      + List.sum
          (module Int)
          t.nodes
          ~f:(fun n ->
            1
            + List.length n.Node.depends_on
            + (if List.is_empty n.capabilities then 0 else 1)
            + if List.is_empty n.reviewers then 0 else 1)
    in
    require
      (operations <= 32)
      Invalid_argument
      "Workflow requires more than 32 atomic mutations"
  ;;

  let validate t = Json.decode (fun () -> validate_exn t)

  let to_json t =
    Json.obj
      [ "parameters", `Array (List.map t.parameters ~f:Json.string)
      ; "nodes", `Array (List.map t.nodes ~f:Node.to_json)
      ]
  ;;

  let of_json json =
    Json.decode (fun () ->
      Json.fields json ~allowed:[ "parameters"; "nodes" ];
      let t =
        { parameters = List.map (Json.list (Json.field json "parameters")) ~f:Json.text
        ; nodes = List.map (Json.list (Json.field json "nodes")) ~f:Node.of_json
        }
      in
      validate_exn t;
      t)
  ;;
end

type t =
  { resource : Id.Resource.t
  ; resource_revision : int
  ; digest : string
  ; spec : Spec.t
  }
[@@deriving sexp, equal]

module Planned_ticket = struct
  type t =
    { alias : string
    ; ticket : Id.Ticket.t
    ; title : string
    ; description : string
    ; dependencies : Id.Ticket.t list
    ; parent : Id.Ticket.t option
    ; capabilities : string list
    ; reviewers : Id.Actor.t list
    ; separate_actor : bool
    }
  [@@deriving sexp, equal]

  let to_json t =
    Json.obj
      [ "alias", Json.string t.alias
      ; "ticket", Id.Ticket.jsonaf_of_t t.ticket
      ; "title", Json.string t.title
      ; "description", Json.string t.description
      ; "dependencies", `Array (List.map t.dependencies ~f:Id.Ticket.jsonaf_of_t)
      ; "parent", Option.value_map t.parent ~default:`Null ~f:Id.Ticket.jsonaf_of_t
      ; "capabilities", `Array (List.map t.capabilities ~f:Json.string)
      ; "reviewers", `Array (List.map t.reviewers ~f:Id.Actor.jsonaf_of_t)
      ; ("separate_actor", if t.separate_actor then `True else `False)
      ]
  ;;

  let of_json json =
    Json.fields
      json
      ~allowed:
        [ "alias"
        ; "ticket"
        ; "title"
        ; "description"
        ; "dependencies"
        ; "parent"
        ; "capabilities"
        ; "reviewers"
        ; "separate_actor"
        ];
    let get = Json.field json in
    { alias = Json.text (get "alias")
    ; ticket = Id.Ticket.t_of_jsonaf (get "ticket")
    ; title = Json.text (get "title")
    ; description = Json.text (get "description")
    ; dependencies = List.map (Json.list (get "dependencies")) ~f:Id.Ticket.t_of_jsonaf
    ; parent = optional (get "parent") Id.Ticket.t_of_jsonaf
    ; capabilities = List.map (Json.list (get "capabilities")) ~f:Json.text
    ; reviewers = List.map (Json.list (get "reviewers")) ~f:Id.Actor.t_of_jsonaf
    ; separate_actor =
        (match get "separate_actor" with
         | `True -> true
         | `False -> false
         | _ -> Json.fail Invalid_argument "Expected boolean")
    }
  ;;
end

module Instance = struct
  type t =
    { id : Instance_id.t
    ; template : Id.Resource.t
    ; template_revision : int
    ; parameters : (string * string) list
    ; tickets : Planned_ticket.t list
    }
  [@@deriving sexp, equal]

  let to_json t =
    Json.obj
      [ "id", Instance_id.jsonaf_of_t t.id
      ; "template", Id.Resource.jsonaf_of_t t.template
      ; "template_revision", Json.int t.template_revision
      ; "parameters", Json.obj (List.map t.parameters ~f:(fun (k, v) -> k, Json.string v))
      ; "tickets", `Array (List.map t.tickets ~f:Planned_ticket.to_json)
      ]
  ;;

  let of_json json =
    Json.decode (fun () ->
      Json.fields
        json
        ~allowed:[ "id"; "template"; "template_revision"; "parameters"; "tickets" ];
      let get = Json.field json in
      let parameters =
        match get "parameters" with
        | `Object fields ->
          Json.fields (get "parameters") ~allowed:(List.map fields ~f:fst);
          List.map fields ~f:(fun (k, v) -> k, Json.text v)
        | _ -> Json.fail Invalid_argument "Expected parameters object"
      in
      { id = Instance_id.t_of_jsonaf (get "id")
      ; template = Id.Resource.t_of_jsonaf (get "template")
      ; template_revision = Json.integer (get "template_revision")
      ; parameters
      ; tickets = List.map (Json.list (get "tickets")) ~f:Planned_ticket.of_json
      })
  ;;
end

let create ~resource ~resource_revision ~spec =
  Json.decode (fun () ->
    Spec.validate_exn spec;
    require
      (resource_revision > 0)
      Invalid_argument
      "Template resource revision must be positive";
    { resource
    ; resource_revision
    ; digest = Json.hash (Json.canonical (Spec.to_json spec))
    ; spec
    })
;;

let instantiate t ~id ~parameters =
  Json.decode (fun () ->
    Spec.validate_exn t.spec;
    require
      (not (List.contains_dup (List.map parameters ~f:fst) ~compare:String.compare))
      Invalid_argument
      "Duplicate workflow parameter";
    let keys = List.sort (List.map parameters ~f:fst) ~compare:String.compare in
    require
      (List.equal String.equal keys (List.sort t.spec.parameters ~compare:String.compare))
      Invalid_argument
      "Workflow parameters do not match template";
    List.iter parameters ~f:(fun (_, v) -> bounded v 16384);
    let substitute text ~max_bytes =
      let substitutions = String.Map.of_alist_exn parameters in
      let expanded = Buffer.create (String.length text) in
      let rec loop offset =
        if offset < String.length text
        then (
          let starts token = String.is_substring_at text ~pos:offset ~substring:token in
          if starts "{{"
          then (
            let closing =
              String.substr_index text ~pos:(offset + 2) ~pattern:"}}"
              |> Option.value_or_thunk ~default:(fun () ->
                Json.fail Invalid_argument "Unknown or malformed workflow placeholder")
            in
            let name = String.sub text ~pos:(offset + 2) ~len:(closing - offset - 2) in
            let value =
              Map.find substitutions name
              |> Option.value_or_thunk ~default:(fun () ->
                Json.fail Invalid_argument "Unknown or malformed workflow placeholder")
            in
            require
              (String.length value <= max_bytes - Buffer.length expanded)
              Invalid_argument
              "Workflow text exceeds byte limit";
            Buffer.add_string expanded value;
            loop (closing + 2))
          else if starts "}}"
          then Json.fail Invalid_argument "Unknown or malformed workflow placeholder"
          else (
            require
              (Buffer.length expanded < max_bytes)
              Invalid_argument
              "Workflow text exceeds byte limit";
            Buffer.add_char expanded text.[offset];
            loop (offset + 1)))
      in
      loop 0;
      Buffer.contents expanded
    in
    let ticket alias =
      checked
        (Id.Ticket.of_string
           ("wi_" ^ String.prefix (Json.hash (Instance_id.to_string id ^ ":" ^ alias)) 24))
    in
    let nodes =
      List.sort t.spec.nodes ~compare:(fun a b -> String.compare a.Node.alias b.alias)
    in
    let tickets =
      List.map nodes ~f:(fun n ->
        let title = substitute n.Node.title ~max_bytes:512 in
        nonempty title 512;
        let description = substitute n.description ~max_bytes:65536 in
        bounded description 65536;
        { Planned_ticket.alias = n.alias
        ; ticket = ticket n.alias
        ; title
        ; description
        ; dependencies = List.map n.depends_on ~f:ticket
        ; parent = Option.map n.parent ~f:ticket
        ; capabilities = n.capabilities
        ; reviewers = n.reviewers
        ; separate_actor = n.separate_actor
        })
    in
    { Instance.id
    ; template = t.resource
    ; template_revision = t.resource_revision
    ; parameters = List.sort parameters ~compare:(fun (a, _) (b, _) -> String.compare a b)
    ; tickets
    })
;;

let to_json t =
  Json.obj
    [ "resource", Id.Resource.jsonaf_of_t t.resource
    ; "resource_revision", Json.int t.resource_revision
    ; "digest", Json.string t.digest
    ; "spec", Spec.to_json t.spec
    ]
;;

let of_json json =
  Json.decode (fun () ->
    Json.fields json ~allowed:[ "resource"; "resource_revision"; "digest"; "spec" ];
    let t =
      checked
        (create
           ~resource:(Id.Resource.t_of_jsonaf (Json.field json "resource"))
           ~resource_revision:(Json.integer (Json.field json "resource_revision"))
           ~spec:(checked (Spec.of_json (Json.field json "spec"))))
    in
    require
      (String.equal t.digest (Json.text (Json.field json "digest")))
      Invalid_argument
      "Template digest does not match canonical spec";
    t)
;;
