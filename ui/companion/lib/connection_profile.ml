open Core
open Workgraph
module Id = Workgraph.Id.Resource

module Generation = struct
  include Workgraph.Id.Resource

  let of_string value =
    let open Result.Let_syntax in
    let%bind generation = Json.decode (fun () -> Json.integer (Json.string value)) in
    if Int.(generation < 1)
    then Error (Problem.create Invalid_argument "connection generation must be positive")
    else Workgraph.Id.Resource.of_string value
  ;;

  let initial = Workgraph.Id.Resource.of_string "1" |> Disk.unwrap

  let next t =
    let value = Json.integer (jsonaf_of_t t) in
    if Int.equal value Int.max_value
    then Error (Problem.create Conflict "connection generation exhausted")
    else of_string (Int.to_string (Int.succ value))
  ;;

  let t_of_jsonaf value = of_string (Json.text value) |> Disk.unwrap

  let t_of_sexp sexp =
    match of_string (String.t_of_sexp sexp) with
    | Ok value -> value
    | Error error -> Sexplib.Conv.of_sexp_error error.message sexp
  ;;
end

type t =
  { id : Id.t
  ; generation : Generation.t
  ; label : string
  ; socket : string
  }

let id t = t.id
let generation t = t.generation
let label t = t.label
let socket t = t.socket

let create ~id ~generation ~label ~socket =
  Json.decode (fun () ->
    ignore (Platform.validate_socket_path socket |> Disk.unwrap : unit);
    let label = Json.bounded_text (Json.string label) ~max_bytes:512 in
    ignore
      (Json.canonical
         (Json.obj [ "label", Json.string label; "socket", Json.string socket ])
       : string);
    if String.is_empty (String.strip label)
    then Json.fail Invalid_argument "connection label is blank";
    { id; generation; label; socket })
;;

let to_json t =
  Json.obj
    [ "id", Id.jsonaf_of_t t.id
    ; "generation", Generation.jsonaf_of_t t.generation
    ; "label", Json.string t.label
    ; "socket", Json.string t.socket
    ]
;;

let of_json value =
  Json.decode (fun () ->
    Json.fields value ~allowed:[ "id"; "generation"; "label"; "socket" ];
    create
      ~id:(Id.t_of_jsonaf (Json.field value "id"))
      ~generation:(Generation.t_of_jsonaf (Json.field value "generation"))
      ~label:(Json.text (Json.field value "label"))
      ~socket:(Json.text (Json.field value "socket"))
    |> Disk.unwrap)
;;

module Store = struct
  type profile = t

  type t =
    { root : State_root.t
    ; mutex : Eio.Mutex.t
    ; mutable profiles : profile list
    ; mutable persistence_error : Problem.t option
    }

  let current profiles id =
    List.filter profiles ~f:(fun profile -> Id.equal profile.id id)
    |> List.max_elt ~compare:(fun a b ->
      Int.compare
        (Json.integer (Generation.jsonaf_of_t a.generation))
        (Json.integer (Generation.jsonaf_of_t b.generation)))
  ;;

  let list t =
    List.map t.profiles ~f:(fun profile -> profile.id)
    |> List.dedup_and_sort ~compare:Id.compare
    |> List.filter_map ~f:(current t.profiles)
  ;;

  let find t ~id ~generation =
    List.find t.profiles ~f:(fun profile ->
      Id.equal profile.id id && Generation.equal profile.generation generation)
  ;;

  let create root =
    let open Result.Let_syntax in
    let%bind document = State_root.read root ~name:"connections.json" in
    Json.decode (fun () ->
      let profiles =
        match document with
        | None -> []
        | Some value ->
          Json.fields value ~allowed:[ "format"; "profiles" ];
          if
            not
              (String.equal
                 (Json.text (Json.field value "format"))
                 "workgraph-ui-connections-1")
          then Json.fail Unsupported_version "unsupported companion connection storage";
          let profiles = Json.list (Json.field value "profiles") in
          if List.length profiles > 10000
          then Json.fail Corrupt_store "too many profile generations";
          List.map profiles ~f:(fun profile -> of_json profile |> Disk.unwrap)
      in
      let t =
        { root; mutex = Eio.Mutex.create (); profiles = []; persistence_error = None }
      in
      List.iter profiles ~f:(fun profile ->
        let expected =
          match current t.profiles profile.id with
          | None -> Generation.initial
          | Some previous -> Generation.next previous.generation |> Disk.unwrap
        in
        if not (Generation.equal expected profile.generation)
        then
          Json.fail
            Corrupt_store
            "profile generations must be unique, ordered and contiguous";
        t.profiles <- t.profiles @ [ profile ]);
      if List.length (list t) > 100
      then Json.fail Corrupt_store "too many connection profiles";
      t)
  ;;

  let put t profile ~expected_generation =
    Eio.Mutex.lock t.mutex;
    Exn.protect
      ~finally:(fun () -> Eio.Mutex.unlock t.mutex)
      ~f:(fun () ->
        Json.decode (fun () ->
          Option.iter t.persistence_error ~f:(fun error ->
            raise (Json.Decode_error error));
          let generation =
            match current t.profiles profile.id, expected_generation with
            | None, None ->
              if List.length (list t) >= 100
              then Json.fail Conflict "connection profile limit reached";
              Generation.initial
            | Some current, Some expected
              when Generation.equal current.generation expected ->
              Generation.next expected |> Disk.unwrap
            | None, Some _ | Some _, None | Some _, Some _ ->
              Json.fail Conflict "connection profile generation changed"
          in
          if not (Generation.equal profile.generation generation)
          then Json.fail Conflict "new connection generation must be the next generation";
          if List.length t.profiles >= 10000
          then Json.fail Conflict "profile generation limit reached";
          let profiles = t.profiles @ [ profile ] in
          (* Until replacement and its parent sync both succeed, a further update
             must not reuse the potentially installed immutable generation. This
             fence also survives cancellation in the persistence operation. *)
          t.persistence_error
          <- Some
               (Problem.create
                  Outcome_unknown
                  "connection update publication was interrupted; restart companion to \
                   inspect durable generations before another update");
          State_root.save
            t.root
            ~name:"connections.json"
            ~value:
              (Json.obj
                 [ "format", Json.string "workgraph-ui-connections-1"
                 ; "profiles", `Array (List.map profiles ~f:to_json)
                 ])
          |> Disk.unwrap;
          t.profiles <- profiles;
          t.persistence_error <- None))
  ;;
end
