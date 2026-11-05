open Core

let help = function
  | "discover" ->
    Some
      {|discover [offline helper]
Usage: workgraph discover "intent or exact method name"
  [--limit 5] [--capability ID] [--kind method|helper|workflow] [--output text|json]
Returns at most 1..20 keyword-ranked matches (default 5), with purpose, effect
and the next help command. A query is one quoted nonblank UTF-8 argument, at most
1024 bytes. Zero matches is successful; inspect matched_count and has_more.
Use -- before a query beginning with a dash. This searches tool descriptions,
not workspace content; search.query searches stored work. No daemon is needed.
workgraph discover --catalog exports complete JSON discovery metadata for tooling
and documentation; it cannot be combined with a query or search filters.
Read workgraph help NAME before acting. A result is guidance, not authorization
or an automatically executable plan. Local helpers and recipes are labelled.|}
  | "capabilities" ->
    Some
      {|capabilities [offline helper]
Usage: workgraph capabilities [ID] [--output text|json]
Explain Workgraph's capabilities and the API groups that support them.
Then use workgraph help GROUP for a group card and its methods, or
workgraph discover "your intent" to locate methods, local helpers and recipes.
This command reads no context, workspace or daemon. Categories are discovery
guidance, not permissions. Full contracts remain in help METHOD and schema METHOD.|}
  | _ -> None
;;

let run arguments =
  Json.decode (fun () ->
    let unwrap = function
      | Ok value -> value
      | Error problem -> raise (Json.Decode_error problem)
    in
    let command, args =
      match arguments with
      | (("discover" | "capabilities") as command) :: rest -> command, rest
      | _ -> Json.fail Invalid_argument "expected discover or capabilities"
    in
    let rec parse seen positional options = function
      | [] -> List.rev positional, options
      | "--" :: rest -> List.rev positional @ rest, options
      | "--catalog" :: rest ->
        if Set.mem seen "--catalog" then Json.fail Invalid_argument "duplicate --catalog";
        parse
          (Set.add seen "--catalog")
          positional
          (("--catalog", "true") :: options)
          rest
      | (("--output" | "--limit" | "--capability" | "--kind") as flag) :: value :: rest ->
        if Set.mem seen flag then Json.fail Invalid_argument ("duplicate " ^ flag);
        parse (Set.add seen flag) positional ((flag, value) :: options) rest
      | word :: _ when String.is_prefix word ~prefix:"--" ->
        Json.fail
          Invalid_argument
          "unknown or incomplete discovery option; use workgraph help discover or help \
           capabilities"
      | word :: rest -> parse seen (word :: positional) options rest
    in
    let positional, options = parse String.Set.empty [] [] args in
    let get name = List.Assoc.find options name ~equal:String.equal in
    let json =
      match get "--output" with
      | None | Some "text" -> false
      | Some "json" -> true
      | Some _ -> Json.fail Invalid_argument "output must be text or json"
    in
    if String.equal command "capabilities"
    then (
      if List.exists options ~f:(fun (name, _) -> not (String.equal name "--output"))
      then
        Json.fail
          Invalid_argument
          "capabilities accepts only an ID and --output text|json";
      let name =
        match positional with
        | [] -> None
        | [ name ] -> Some name
        | _ -> Json.fail Invalid_argument "capabilities accepts at most one ID"
      in
      let value = Discovery.capabilities name |> unwrap in
      if json then Json.canonical value else Discovery.render_capabilities value)
    else if Option.is_some (get "--catalog")
    then (
      if
        (not (List.is_empty positional))
        || List.exists options ~f:(fun (name, _) ->
          not (List.mem [ "--catalog"; "--output" ] name ~equal:String.equal))
      then
        Json.fail
          Invalid_argument
          "discover --catalog cannot be combined with a query or search filters";
      if Option.equal String.equal (get "--output") (Some "text")
      then Json.fail Invalid_argument "discover --catalog emits JSON only";
      Discovery.catalog () |> Json.canonical)
    else (
      let query =
        match positional with
        | [ query ] -> query
        | _ ->
          Json.fail
            Invalid_argument
            "discover requires one quoted intent; use workgraph capabilities to browse"
      in
      let limit =
        Option.map (get "--limit") ~f:(fun value ->
          match Int.of_string_opt value with
          | Some value -> value
          | None -> Json.fail Invalid_argument "limit must be an integer in 1..20")
      in
      let kind =
        Option.map (get "--kind") ~f:(fun value ->
          Discovery.Kind.of_string value |> unwrap)
      in
      let value =
        Discovery.search ?capability:(get "--capability") ?kind ?limit ~query () |> unwrap
      in
      if json then Json.canonical value else Discovery.render_search value))
;;
