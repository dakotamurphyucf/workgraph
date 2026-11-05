open Core

module Kind = struct
  type t =
    | Method
    | Helper
    | Workflow
  [@@deriving sexp, equal]

  let to_string = function
    | Method -> "method"
    | Helper -> "helper"
    | Workflow -> "workflow"
  ;;

  let of_string = function
    | "method" -> Ok Method
    | "helper" -> Ok Helper
    | "workflow" -> Ok Workflow
    | _ ->
      Error (Problem.create Invalid_argument "kind must be method, helper or workflow")
  ;;
end

module Entry = struct
  type t =
    { name : string
    ; kind : Kind.t
    ; summary : string
    ; use_when : string
    ; search_terms : string list
    ; capability : string
    ; effect_summary : string option
    ; tier : string option
    ; related : string list
    ; reference : string
    ; steps : string list
    }
end

let strings xs = `Array (List.map xs ~f:Json.string)
let optional_string = Option.value_map ~default:`Null ~f:Json.string
let group_id name = List.hd_exn (String.split name ~on:'.')
let group name = List.find Discovery_content.groups ~f:(fun g -> String.equal g.id name)

let capability_for name =
  List.find_exn Discovery_content.capabilities ~f:(fun c ->
    List.mem c.groups name ~equal:String.equal)
;;

let entries =
  lazy
    (let methods =
       List.map Api_catalog.methods ~f:(fun (Api_method.Packed.Pack method_) ->
         let name = Api_method.name method_ in
         let info = Discovery_content.find_method name |> Option.value_exn in
         let family = group (group_id name) |> Option.value_exn in
         let capability = capability_for family.id in
         let effect_summary =
           match Api_method.mode method_ with
           | Read -> "read"
           | Write -> "write"
           | Mutation -> "mutation"
         in
         let tier =
           match Api_method.tier method_ with
           | Core -> "core"
           | Advanced -> "advanced"
         in
         { Entry.name
         ; kind = Method
         ; summary = Api_method.summary method_
         ; use_when = info.use_when
         ; search_terms = info.search_terms
         ; capability = capability.id
         ; effect_summary = Some effect_summary
         ; tier = Some tier
         ; related = info.related
         ; reference = "references/api/" ^ name ^ ".md"
         ; steps = []
         })
     in
     let helpers =
       List.map Discovery_content.helpers ~f:(fun h ->
         { Entry.name = h.name
         ; kind = Helper
         ; summary = h.summary
         ; use_when = h.use_when
         ; search_terms = h.search_terms
         ; capability = h.capability
         ; effect_summary = Some h.effect_summary
         ; tier = None
         ; related = []
         ; reference = h.reference
         ; steps = []
         })
     in
     let workflows =
       List.map Discovery_content.workflows ~f:(fun w ->
         { Entry.name = "workflow." ^ w.id
         ; kind = Workflow
         ; summary = w.summary
         ; use_when = w.use_when
         ; search_terms = w.title :: w.search_terms
         ; capability = w.capability
         ; effect_summary = None
         ; tier = None
         ; related = w.methods
         ; reference = w.reference
         ; steps = w.steps
         })
     in
     List.sort
       (methods @ helpers @ workflows)
       ~compare:(fun a b -> String.compare a.name b.name))
;;

let entry_json (e : Entry.t) ~full =
  Json.obj
    ([ "name", Json.string e.name
     ; "kind", Json.string (Kind.to_string e.kind)
     ; "summary", Json.string e.summary
     ; "use_when", Json.string e.use_when
     ; "capability", Json.string e.capability
     ; "effect", optional_string e.effect_summary
     ; "next", Json.string ("workgraph help " ^ e.name)
     ; "reference", Json.string e.reference
     ]
     @
     if full
     then
       [ "tier", optional_string e.tier
       ; "related", strings e.related
       ; "search_terms", strings e.search_terms
       ; "steps", strings e.steps
       ]
     else [])
;;

let capability_json (c : Discovery_content.Capability.t) =
  Json.obj
    [ "id", Json.string c.id
    ; "title", Json.string c.title
    ; "summary", Json.string c.summary
    ; "groups", strings c.groups
    ; "reference", Json.string c.reference
    ]
;;

let group_json (g : Discovery_content.Group.t) =
  Json.obj
    [ "id", Json.string g.id
    ; "summary", Json.string g.summary
    ; "use_when", Json.string g.use_when
    ; "distinction", Json.string g.distinction
    ; "start_with", strings g.start_with
    ; "reference", Json.string g.reference
    ]
;;

let catalog () =
  Json.obj
    [ "capabilities", `Array (List.map Discovery_content.capabilities ~f:capability_json)
    ; "groups", `Array (List.map Discovery_content.groups ~f:group_json)
    ; "entries", `Array (List.map (Lazy.force entries) ~f:(entry_json ~full:true))
    ]
;;

let validate () =
  let errors = ref [] in
  let check condition message = if not condition then errors := message :: !errors in
  let unique label names =
    check (not (List.contains_dup names ~compare:String.compare)) ("duplicate " ^ label)
  in
  let method_names =
    List.map Api_catalog.methods ~f:(fun (Api_method.Packed.Pack m) -> Api_method.name m)
  in
  let described = List.map Discovery_content.methods ~f:(fun m -> m.name) in
  let group_names = List.map Discovery_content.groups ~f:(fun g -> g.id) in
  let capability_names = List.map Discovery_content.capabilities ~f:(fun c -> c.id) in
  let helpers = List.map Discovery_content.helpers ~f:(fun h -> h.name) in
  let targets = method_names @ helpers in
  let member xs x = List.mem xs x ~equal:String.equal in
  let same xs ys = Set.equal (String.Set.of_list xs) (String.Set.of_list ys) in
  unique "method description" described;
  unique "group" group_names;
  unique "capability" capability_names;
  unique
    "discovery target"
    (targets @ List.map Discovery_content.workflows ~f:(fun w -> "workflow." ^ w.id));
  check
    (same method_names described)
    "method descriptions must exactly cover executable methods";
  check
    (same (List.map method_names ~f:group_id) group_names)
    "groups must exactly cover executable namespaces";
  let assigned = List.concat_map Discovery_content.capabilities ~f:(fun c -> c.groups) in
  unique "capability group assignment" assigned;
  check (same assigned group_names) "capabilities must cover each group once";
  let text label s =
    check
      ((not (String.is_empty (String.strip s))) && String.length s <= 2048)
      ("empty or oversized " ^ label)
  in
  List.iter Discovery_content.methods ~f:(fun m ->
    text (m.name ^ " summary") m.summary;
    text (m.name ^ " use_when") m.use_when;
    List.iter m.related ~f:(fun name ->
      check (member targets name) (m.name ^ " dangling related " ^ name)));
  List.iter Discovery_content.groups ~f:(fun g ->
    text (g.id ^ " summary") g.summary;
    text (g.id ^ " use_when") g.use_when;
    text (g.id ^ " distinction") g.distinction;
    check (not (List.is_empty g.start_with)) (g.id ^ " missing starting operations");
    List.iter g.start_with ~f:(fun name ->
      check (member targets name) (g.id ^ " dangling start " ^ name)));
  List.iter Discovery_content.helpers ~f:(fun h ->
    check (member capability_names h.capability) (h.name ^ " unknown capability");
    text (h.name ^ " summary") h.summary;
    text (h.name ^ " use_when") h.use_when);
  List.iter Discovery_content.workflows ~f:(fun w ->
    check (member capability_names w.capability) (w.id ^ " unknown capability");
    text (w.id ^ " summary") w.summary;
    text (w.id ^ " use_when") w.use_when;
    check (not (List.is_empty w.steps)) (w.id ^ " missing steps");
    List.iter w.steps ~f:(text (w.id ^ " step"));
    List.iter w.methods ~f:(fun name ->
      check (member targets name) (w.id ^ " dangling operation " ^ name)));
  if List.is_empty !errors then Ok () else Error (List.rev !errors)
;;

let stopwords =
  String.Set.of_list
    [ "a"
    ; "an"
    ; "and"
    ; "are"
    ; "as"
    ; "at"
    ; "be"
    ; "by"
    ; "can"
    ; "do"
    ; "for"
    ; "from"
    ; "how"
    ; "i"
    ; "in"
    ; "is"
    ; "it"
    ; "me"
    ; "my"
    ; "of"
    ; "on"
    ; "or"
    ; "that"
    ; "the"
    ; "this"
    ; "to"
    ; "use"
    ; "want"
    ; "with"
    ; "workgraph"
    ; "before"
    ; "after"
    ; "when"
    ; "am"
    ; "need"
    ; "please"
    ; "would"
    ; "could"
    ; "should"
    ; "two"
    ; "same"
    ]
;;

let normalize_word = function
  | "saving" | "saved" | "remember" | "persist" | "store" | "storing" -> "save"
  | "asking" | "asked" -> "ask"
  | "atomically" -> "atomic"
  | "task" | "tasks" | "issue" | "issues" -> "ticket"
  | "developer" | "developers" | "worker" | "workers" | "agents" -> "agent"
  | "keep" | "stop" -> "prevent"
  | "losing" | "lost" -> "loss"
  | "editing" | "edits" | "edited" -> "edit"
  | "avoiding" | "avoid" | "preventing" -> "prevent"
  | "simultaneously" | "concurrently" | "concurrent" -> "simultaneous"
  | "acknowledge" | "acknowledgement" | "acknowledgment" -> "ack"
  | word ->
    if
      String.length word > 3
      && String.is_suffix word ~suffix:"s"
      && not (String.is_suffix word ~suffix:"ss")
    then String.drop_suffix word 1
    else word
;;

let rec combine_phrases = function
  | "set" :: "up" :: rest | "get" :: "started" :: rest | "getting" :: "started" :: rest ->
    "setup" :: combine_phrases rest
  | word :: rest -> word :: combine_phrases rest
  | [] -> []
;;

let tokens text =
  String.lowercase text
  |> String.map ~f:(fun c ->
    if Char.is_alphanum c || Char.to_int c >= 128 then c else ' ')
  |> String.split ~on:' '
  |> List.filter ~f:(fun s -> not (String.is_empty s))
  |> combine_phrases
  |> List.filter ~f:(fun s -> (not (String.is_empty s)) && not (Set.mem stopwords s))
  |> List.map ~f:normalize_word
  |> String.Set.of_list
;;

module Indexed = struct
  type t =
    { entry : Entry.t
    ; fields : (int * String.Set.t) list
    ; all : String.Set.t
    }
end

let index =
  lazy
    (List.map (Lazy.force entries) ~f:(fun entry ->
       let fields =
         [ 12, tokens entry.name
         ; 6, tokens entry.summary
         ; 4, tokens entry.use_when
         ; 8, tokens (String.concat ~sep:" " entry.search_terms)
         ]
       in
       let all =
         List.fold fields ~init:String.Set.empty ~f:(fun acc (_, words) ->
           Set.union acc words)
       in
       { Indexed.entry; fields; all }))
;;

let search ?capability ?kind ?(limit = 5) ~query () =
  Json.decode (fun () ->
    let query =
      match Api_codec.decode (Api_codec.text ~max_bytes:1024) (Json.string query) with
      | Ok query -> String.strip query
      | Error problem -> raise (Json.Decode_error problem)
    in
    let words = tokens query in
    if String.is_empty query || Set.is_empty words
    then
      Json.fail
        Invalid_argument
        "discovery requires a nonblank query with searchable words (at most 1024 UTF-8 \
         bytes)";
    if limit < 1 || limit > 20
    then Json.fail Invalid_argument "discovery limit must be 1..20";
    Option.iter capability ~f:(fun name ->
      if
        not
          (List.exists Discovery_content.capabilities ~f:(fun c -> String.equal c.id name))
      then Json.fail Invalid_argument "unknown capability; use workgraph capabilities");
    let all = Lazy.force index in
    let weights =
      Set.to_list words
      |> List.map ~f:(fun word ->
        let frequency = List.count all ~f:(fun row -> Set.mem row.all word) in
        word, Int.min 32 ((List.length all + 1) / (frequency + 1)))
    in
    let ranked =
      List.filter_map all ~f:(fun row ->
        let e = row.entry in
        if
          (not (Option.for_all capability ~f:(String.equal e.capability)))
          || not (Option.for_all kind ~f:(Kind.equal e.kind))
        then None
        else (
          let score =
            List.sum
              (module Int)
              weights
              ~f:(fun (word, rarity) ->
                let weight =
                  List.fold row.fields ~init:0 ~f:(fun acc (weight, terms) ->
                    if Set.mem terms word then Int.max acc weight else acc)
                in
                weight * rarity)
          in
          let coverage = Set.length (Set.inter words row.all) in
          let score = score + (64 * coverage * coverage) in
          let score =
            if
              String.Caseless.equal query e.name
              || (String.contains query '.'
                  && List.exists e.search_terms ~f:(String.Caseless.equal query))
            then score + 1000000
            else score
          in
          if score = 0 then None else Some (score, e)))
      |> List.sort ~compare:(fun (a, x) (b, y) ->
        let order = Int.compare b a in
        if order = 0 then String.compare x.name y.name else order)
    in
    let results =
      List.take ranked limit |> List.map ~f:(fun (_, e) -> entry_json e ~full:false)
    in
    Json.obj
      [ "query", Json.string query
      ; "capability", optional_string capability
      ; ( "kind"
        , Option.value_map kind ~default:`Null ~f:(fun k ->
            Json.string (Kind.to_string k)) )
      ; "matched_count", Json.int (List.length ranked)
      ; "returned_count", Json.int (List.length results)
      ; ("has_more", if List.length ranked > limit then `True else `False)
      ; "results", `Array results
      ; ( "guidance"
        , Json.string
            "Matches are ranked keywords, not an execution plan. Read the selected help \
             for prerequisites; narrow the query or capability if needed." )
      ])
;;

let render_search value =
  let results = Json.field value "results" |> Json.list in
  let text row field = Json.field row field |> Json.text in
  let heading =
    if List.is_empty results
    then "No matching capabilities found. Try another phrase or workgraph capabilities."
    else
      "Showing "
      ^ Int.to_string (List.length results)
      ^ " of "
      ^ Int.to_string (Json.field value "matched_count" |> Json.integer)
      ^ " keyword matches:"
  in
  String.concat
    ~sep:"\n"
    ([ heading ]
     @ List.concat_map results ~f:(fun row ->
       [ text row "name" ^ " [" ^ text row "kind" ^ "] — " ^ text row "summary"
       ; "  Use when: " ^ text row "use_when"
       ; ("  Effect: "
          ^
          match Json.field row "effect" with
          | `Null -> "recipe; consult each step"
          | value -> Json.text value)
       ; "  Next: " ^ text row "next"
       ])
     @ [ text value "guidance" ])
;;

let capabilities name =
  let selected =
    match name with
    | None -> Discovery_content.capabilities
    | Some name ->
      List.filter Discovery_content.capabilities ~f:(fun c -> String.equal name c.id)
  in
  if List.is_empty selected
  then Error (Problem.create Not_found "unknown capability; use workgraph capabilities")
  else Ok (Json.obj [ "capabilities", `Array (List.map selected ~f:capability_json) ])
;;

let render_capabilities value =
  "Workgraph capabilities (offline; groups are API namespaces):\n"
  ^ (Json.field value "capabilities"
     |> Json.list
     |> List.map ~f:(fun c ->
       let get key = Json.field c key |> Json.text in
       get "id"
       ^ " — "
       ^ get "title"
       ^ "\n  "
       ^ get "summary"
       ^ "\n  Groups: "
       ^ (Json.field c "groups"
          |> Json.list
          |> List.map ~f:Json.text
          |> String.concat ~sep:", ")
       ^ "\n  Guide: "
       ^ get "reference")
     |> String.concat ~sep:"\n")
  ^ "\n\
     Next: workgraph help GROUP or workgraph discover \"your intent\". Groups and tiers \
     are not permissions."
;;

let group_help name =
  Option.map
    (group (group_id name))
    ~f:(fun g ->
      String.concat
        ~sep:"\n"
        [ g.id ^ " — " ^ g.summary
        ; "Use when: " ^ g.use_when
        ; "Distinction: " ^ g.distinction
        ; "Start with: " ^ String.concat ~sep:", " g.start_with
        ; "Guide: " ^ g.reference
        ])
;;

let workflow_help name =
  List.find Discovery_content.workflows ~f:(fun w ->
    String.equal ("workflow." ^ w.id) name)
  |> Option.map ~f:(fun w ->
    String.concat
      ~sep:"\n"
      ([ "workflow." ^ w.id ^ " [workflow recipe] — " ^ w.title
       ; w.summary
       ; "Use when: " ^ w.use_when
       ]
       @ List.mapi w.steps ~f:(fun i step -> Int.to_string (i + 1) ^ ". " ^ step)
       @ [ "Operations: " ^ String.concat ~sep:", " w.methods
         ; "Guide: " ^ w.reference
         ; "Read workgraph help METHOD for exact inputs. This recipe performs no \
            actions; the harness owns agent processes and external side effects."
         ]))
;;
