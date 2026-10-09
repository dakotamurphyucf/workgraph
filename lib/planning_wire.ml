open Core
module Fields = Api_codec.Fields

let ( ++ ) = Fields.both

let id of_string to_string =
  Api_codec.map
    (Api_codec.text ~max_bytes:96)
    ~decode:of_string
    ~encode:to_string
    ~description:"Resolved public identity; no aliases."
;;

let positive =
  Api_codec.map
    (Api_codec.decimal ~max:Int.max_value)
    ~decode:(fun value ->
      if value > 0
      then Ok value
      else Error (Problem.create Invalid_argument "revision must be positive"))
    ~encode:Fn.id
    ~description:"Positive immutable entity revision."
;;

let decimal = Api_codec.decimal ~max:Int.max_value
let text = Api_codec.text ~max_bytes:65536

let name =
  Api_codec.map
    (Api_codec.text ~max_bytes:512)
    ~decode:(fun value ->
      if String.is_empty (String.strip value)
      then Error (Problem.create Invalid_argument "name/title must be nonblank")
      else Ok value)
    ~encode:Fn.id
    ~description:"Nonblank name/title, at most512 UTF-8 bytes; never clipped."
;;

let category =
  Api_codec.enum
    [ "backlog", Workflow.Category.Backlog
    ; "todo", Todo
    ; "in_progress", In_progress
    ; "done", Done
    ; "canceled", Canceled
    ]
    ~equal:Workflow.Category.equal
;;

let actor_kind =
  Api_codec.enum
    [ "person", Workflow.Actor.Person; "agent", Agent ]
    ~equal:Workflow.Actor.equal_kind
;;

let date =
  Api_codec.map
    (Api_codec.text ~max_bytes:10)
    ~decode:(fun value ->
      let valid =
        if
          String.length value <> 10
          || (not (Char.equal value.[4] '-'))
          || not (Char.equal value.[7] '-')
        then false
        else (
          match
            ( Int.of_string_opt (String.prefix value 4)
            , Int.of_string_opt (String.sub value ~pos:5 ~len:2)
            , Int.of_string_opt (String.suffix value 2) )
          with
          | Some year, Some month, Some day ->
            let digits =
              List.for_all
                [ String.prefix value 4
                ; String.sub value ~pos:5 ~len:2
                ; String.suffix value 2
                ]
                ~f:(String.for_all ~f:Char.is_digit)
            in
            let leap = year mod 4 = 0 && (year mod 100 <> 0 || year mod 400 = 0) in
            let days =
              match month with
              | 1 | 3 | 5 | 7 | 8 | 10 | 12 -> 31
              | 4 | 6 | 9 | 11 -> 30
              | 2 -> if leap then 29 else 28
              | _ -> 0
            in
            digits && day > 0 && day <= days
          | _ -> false)
      in
      if valid
      then Ok value
      else Error (Problem.create Invalid_argument "date must be a valid YYYY-MM-DD"))
    ~encode:Fn.id
    ~description:"Exact canonical Gregorian date YYYY-MM-DD; never clipped."
;;

module Project = struct
  type t =
    { project_id : Id.Project.t
    ; title : string
    ; description : string
    ; revision : int
    ; status : Workflow.Category.t
    ; priority : int
    ; summary : string
    ; acceptance_criteria : string
    ; archived : bool
    }

  let codec =
    Api_codec.object_
      (Fields.map
         (Fields.required "project_id" (id Id.Project.of_string Id.Project.to_string)
          ++ Fields.required "title" name
          ++ Fields.required "description" text
          ++ Fields.required "revision" positive
          ++ Fields.required "status" category
          ++ Fields.required "priority" (Api_codec.decimal ~max:4)
          ++ Fields.required "summary" text
          ++ Fields.required "acceptance_criteria" text
          ++ Fields.required "archived" Api_codec.boolean)
         ~decode:
           (fun
             ( ( ( (((((project_id, title), description), revision), status), priority)
                 , summary )
               , acceptance_criteria )
             , archived ) ->
           { project_id
           ; title
           ; description
           ; revision
           ; status
           ; priority
           ; summary
           ; acceptance_criteria
           ; archived
           })
         ~encode:
           (fun
             ({ project_id
              ; title
              ; description
              ; revision
              ; status
              ; priority
              ; summary
              ; acceptance_criteria
              ; archived
              } :
               t) ->
           ( ( ( (((((project_id, title), description), revision), status), priority)
               , summary )
             , acceptance_criteria )
           , archived )))
  ;;
end

module Milestone = struct
  type t =
    { milestone_id : Id.Milestone.t
    ; project_id : Id.Project.t
    ; title : string
    ; description : string
    ; target_date : string option
    ; status : Workflow.Category.t
    ; revision : int
    ; archived : bool
    }

  let codec =
    Api_codec.object_
      (Fields.map
         (Fields.required
            "milestone_id"
            (id Id.Milestone.of_string Id.Milestone.to_string)
          ++ Fields.required "project_id" (id Id.Project.of_string Id.Project.to_string)
          ++ Fields.required "title" name
          ++ Fields.required "description" text
          ++ Fields.required "target_date" (Api_codec.nullable date)
          ++ Fields.required "status" category
          ++ Fields.required "revision" positive
          ++ Fields.required "archived" Api_codec.boolean)
         ~decode:
           (fun
             ( ( ( ((((milestone_id, project_id), title), description), target_date)
                 , status )
               , revision )
             , archived ) ->
           { milestone_id
           ; project_id
           ; title
           ; description
           ; target_date
           ; status
           ; revision
           ; archived
           })
         ~encode:
           (fun
             ({ milestone_id
              ; project_id
              ; title
              ; description
              ; target_date
              ; status
              ; revision
              ; archived
              } :
               t) ->
           ( ( (((((milestone_id, project_id), title), description), target_date), status)
             , revision )
           , archived )))
  ;;
end

module Workspace_settings = struct
  type t =
    { description : string
    ; instructions : string
    ; summary : string
    ; revision : int
    ; name : string option
    ; archived : bool
    }

  let codec =
    Api_codec.object_
      (Fields.map
         (Fields.required "description" text
          ++ Fields.required "instructions" text
          ++ Fields.required "summary" text
          ++ Fields.required "revision" decimal
          ++ Fields.required "name" (Api_codec.nullable name)
          ++ Fields.required "archived" Api_codec.boolean)
         ~decode:
           (fun
             (((((description, instructions), summary), revision), name), archived) ->
           { description; instructions; summary; revision; name; archived })
         ~encode:
           (fun
             ({ description; instructions; summary; revision; name; archived } : t) ->
           ((((description, instructions), summary), revision), name), archived))
  ;;
end

module Workspace = struct
  type t =
    { name : string
    ; settings : Workspace_settings.t
    }

  let codec =
    Api_codec.object_
      (Fields.map
         (Fields.required "name" name
          ++ Fields.required "settings" Workspace_settings.codec)
         ~decode:(fun (name, settings) -> { name; settings })
         ~encode:(fun ({ name; settings } : t) -> name, settings))
  ;;
end

module Actor = struct
  type t =
    { actor_id : Id.Actor.t
    ; name : string
    ; kind : Workflow.Actor.kind
    ; revision : int
    ; archived : bool
    }

  let codec =
    Api_codec.object_
      (Fields.map
         (Fields.required "actor_id" (id Id.Actor.of_string Id.Actor.to_string)
          ++ Fields.required "name" name
          ++ Fields.required "kind" actor_kind
          ++ Fields.required "revision" positive
          ++ Fields.required "archived" Api_codec.boolean)
         ~decode:(fun ((((actor_id, name), kind), revision), archived) ->
           { actor_id; name; kind; revision; archived })
         ~encode:(fun ({ actor_id; name; kind; revision; archived } : t) ->
           (((actor_id, name), kind), revision), archived))
  ;;

  let of_domain ({ id; name; kind; revision; archived } : Workflow.Actor.t) =
    { actor_id = id; name; kind; revision; archived }
  ;;
end

module Label = struct
  type t =
    { label_id : Id.Label.t
    ; name : string
    ; description : string
    ; revision : int
    ; archived : bool
    }

  let codec =
    Api_codec.object_
      (Fields.map
         (Fields.required "label_id" (id Id.Label.of_string Id.Label.to_string)
          ++ Fields.required "name" name
          ++ Fields.required "description" text
          ++ Fields.required "revision" positive
          ++ Fields.required "archived" Api_codec.boolean)
         ~decode:(fun ((((label_id, name), description), revision), archived) ->
           { label_id; name; description; revision; archived })
         ~encode:(fun ({ label_id; name; description; revision; archived } : t) ->
           (((label_id, name), description), revision), archived))
  ;;

  let of_domain ({ id; name; description; revision; archived } : Workflow.Label.t) =
    { label_id = id; name; description; revision; archived }
  ;;
end

module Status = struct
  type t =
    { status_id : Id.Status.t
    ; name : string
    ; category : Workflow.Category.t
    ; revision : int
    ; archived : bool
    }

  let codec =
    Api_codec.object_
      (Fields.map
         (Fields.required "status_id" (id Id.Status.of_string Id.Status.to_string)
          ++ Fields.required "name" name
          ++ Fields.required "category" category
          ++ Fields.required "revision" positive
          ++ Fields.required "archived" Api_codec.boolean)
         ~decode:(fun ((((status_id, name), category), revision), archived) ->
           { status_id; name; category; revision; archived })
         ~encode:(fun ({ status_id; name; category; revision; archived } : t) ->
           (((status_id, name), category), revision), archived))
  ;;

  let of_domain ({ id; name; category; revision; archived } : Workflow.Status.t) =
    { status_id = id; name; category; revision; archived }
  ;;
end

module Progress = struct
  type t =
    { total : int
    ; done_ : int
    ; blocked : int
    }

  let codec =
    Api_codec.object_
      (Fields.map
         (Fields.required "total" decimal
          ++ Fields.required "done" decimal
          ++ Fields.required "blocked" decimal)
         ~decode:(fun ((total, done_), blocked) -> { total; done_; blocked })
         ~encode:(fun ({ total; done_; blocked } : t) -> (total, done_), blocked))
    |> Api_codec.map
         ~decode:(fun t ->
           if t.done_ <= t.total && t.blocked <= t.total
           then Ok t
           else Error (Problem.create Invalid_argument "progress counts exceed total"))
         ~encode:Fn.id
         ~description:"Exact progress counts; done and blocked each at most total."
  ;;
end

module Page = struct
  type 'a t =
    { items : 'a list
    ; offset : int
    ; remaining : int
    ; next_offset : int option
    }

  let codec item =
    Api_codec.object_
      (Fields.map
         (Fields.required "items" (Api_codec.list item ~max_items:100)
          ++ Fields.required "offset" decimal
          ++ Fields.required "remaining" decimal
          ++ Fields.required "next_offset" (Api_codec.nullable decimal))
         ~decode:(fun (((items, offset), remaining), next_offset) ->
           { items; offset; remaining; next_offset })
         ~encode:(fun { items; offset; remaining; next_offset } ->
           ((items, offset), remaining), next_offset))
    |> Api_codec.map
         ~decode:(fun t ->
           let count = List.length t.items in
           let valid =
             t.remaining <= Int.max_value - count
             && t.offset <= Int.max_value - count
             &&
             if t.remaining = 0
             then Option.is_none t.next_offset
             else
               count > 0
               && Option.value_map
                    t.next_offset
                    ~default:false
                    ~f:(Int.equal (t.offset + count))
           in
           if valid
           then Ok t
           else
             Error (Problem.create Invalid_argument "inconsistent planning page cursor"))
         ~encode:Fn.id
         ~description:
           "Ordered nonempty remaining pages advance by actual returned-item count."
  ;;
end

module Milestone_read = struct
  type t =
    { milestone : Milestone.t
    ; progress : Progress.t
    }

  let codec =
    Api_codec.object_
      (Fields.map
         (Fields.required "milestone" Milestone.codec
          ++ Fields.required "progress" Progress.codec)
         ~decode:(fun (milestone, progress) -> { milestone; progress })
         ~encode:(fun { milestone; progress } -> milestone, progress))
  ;;
end

module Response = struct
  type t =
    | Workspace of Workspace.t
    | Project of Project.t
    | Projects of Project.t Page.t
    | Milestone of Milestone_read.t
    | Milestones of Milestone.t Page.t
    | Actors of Actor.t Page.t
    | Labels of Label.t Page.t
    | Statuses of Status.t Page.t

  let encoded codec value =
    match Api_codec.encode codec value with
    | Ok json -> json
    | Error problem -> raise (Api_method.Invalid_response ("planning view", problem))
  ;;

  let data = function
    | Workspace value -> encoded Workspace.codec value
    | Project value -> encoded Project.codec value
    | Projects value -> encoded (Page.codec Project.codec) value
    | Milestone value -> encoded Milestone_read.codec value
    | Milestones value -> encoded (Page.codec Milestone.codec) value
    | Actors value -> encoded (Page.codec Actor.codec) value
    | Labels value -> encoded (Page.codec Label.codec) value
    | Statuses value -> encoded (Page.codec Status.codec) value
  ;;

  let fit t ~workspace_revision ~max_bytes =
    (* Validate complete constructed views before dropping any page suffix. A
       hidden bad source value is a programming error, even if it would not fit. *)
    ignore (data t : Jsonaf.t);
    Json.decode (fun () ->
      if workspace_revision < 0 || max_bytes < 4096 || max_bytes > 1048576
      then Json.fail Invalid_argument "invalid planning capture/budget";
      let attempt ~text_cap ~item_cap =
        let omitted_fields = ref 0
        and omitted_items = ref 0
        and locations = ref 0
        and details = ref [] in
        let note path kind count =
          incr locations;
          if List.length !details < 4
          then
            details
            := Json.obj
                 [ "path", Json.string path
                 ; "kind", Json.string kind
                 ; "omitted", Json.int count
                 ]
               :: !details
        in
        let text path value =
          let selected = Query_budget.prefix value ~max_bytes:text_cap in
          let removed = String.length value - String.length selected in
          if removed > 0
          then (
            incr omitted_fields;
            note path "text_bytes" removed);
          selected
        in
        let project path (value : Project.t) =
          { value with
            description = text (path ^ "/description") value.description
          ; summary = text (path ^ "/summary") value.summary
          ; acceptance_criteria =
              text (path ^ "/acceptance_criteria") value.acceptance_criteria
          }
        in
        let milestone path (value : Milestone.t) =
          { value with description = text (path ^ "/description") value.description }
        in
        let label path (value : Label.t) =
          { value with description = text (path ^ "/description") value.description }
        in
        let page : 'a. (string -> 'a -> 'a) -> 'a Page.t -> 'a Page.t =
          fun map value ->
          let selected = List.take value.items item_cap in
          let removed = List.length value.items - List.length selected in
          if removed > 0
          then (
            omitted_items := !omitted_items + removed;
            note "/data/items" "items" removed);
          let items =
            List.mapi selected ~f:(fun index value ->
              map ("/data/items/" ^ Int.to_string index) value)
          in
          let remaining = value.remaining + removed in
          { Page.items
          ; offset = value.offset
          ; remaining
          ; next_offset =
              (if remaining = 0 then None else Some (value.offset + List.length items))
          }
        in
        let selected =
          match t with
          | Workspace value ->
            let settings = value.settings in
            Workspace
              { value with
                settings =
                  { settings with
                    description = text "/data/settings/description" settings.description
                  ; instructions =
                      text "/data/settings/instructions" settings.instructions
                  ; summary = text "/data/settings/summary" settings.summary
                  }
              }
          | Project value -> Project (project "/data" value)
          | Projects value -> Projects (page project value)
          | Milestone value ->
            Milestone
              { value with milestone = milestone "/data/milestone" value.milestone }
          | Milestones value -> Milestones (page milestone value)
          | Labels value -> Labels (page label value)
          | Actors value -> Actors (page (fun _ value -> value) value)
          | Statuses value -> Statuses (page (fun _ value -> value) value)
        in
        let value = data selected in
        let truncated = !omitted_fields > 0 || !omitted_items > 0 in
        let metadata returned_bytes =
          Json.obj
            [ "max_bytes", Json.int max_bytes
            ; "returned_bytes", Json.int returned_bytes
            ; ("truncated", if truncated then `True else `False)
            ; "omitted_fields", Json.int !omitted_fields
            ; "omitted_items", Json.int !omitted_items
            ; "details", `Array (List.rev !details)
            ; ("details_complete", if !locations <= 4 then `True else `False)
            ]
        in
        let rec size returned_bytes =
          let result =
            Json.obj
              [ "workspace_revision", Json.int workspace_revision
              ; "data", value
              ; "budget", metadata returned_bytes
              ]
          in
          let actual = Api_response.encoded_size Planning_read result in
          if Int.equal actual returned_bytes then result, actual else size actual
        in
        size 0
      in
      let profiles =
        [ Int.max_value, 100
        ; 32768, 100
        ; 16384, 100
        ; 8192, 100
        ; 4096, 50
        ; 2048, 25
        ; 1024, 10
        ; 512, 5
        ; 128, 1
        ; 0, 1
        ]
      in
      let rec choose = function
        | [] ->
          Json.fail
            Invalid_argument
            "first planning record or essential metadata exceeds max_bytes; increase \
             max_bytes or narrow the query"
        | (text_cap, item_cap) :: rest ->
          let result, bytes = attempt ~text_cap ~item_cap in
          if bytes <= max_bytes then result else choose rest
      in
      choose profiles)
  ;;
end
