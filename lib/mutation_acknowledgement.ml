open Core

module Commit = struct
  type t =
    { workspace_revision : Api_position.Workspace_revision.t
    ; result : Jsonaf.t
    }
end

module Observation = struct
  type t =
    { workspace_revision : Api_position.Workspace_revision.t
    ; explanation : Allocation.Explanation.t
    }
end

type t =
  | Committed of Commit.t
  | Observed_empty of Observation.t

let of_response response ~method_ =
  let decoded =
    Json.decode (fun () ->
      let meta = Api_response.meta response in
      Json.fields meta ~allowed:[ "workspace_revision"; "durable" ];
      let result = Api_response.data response in
      let workspace_revision =
        Api_codec.decode
          Api_position.Workspace_revision.codec
          (Json.field meta "workspace_revision")
        |> Disk.unwrap
      in
      let is_allocation = String.equal method_ "ticket.claim_next" in
      if is_allocation
      then (
        let codec = Option.value_exn (Planning_result.codec ~method_) in
        ignore (Api_codec.decode codec result |> Disk.unwrap : Jsonaf.t));
      match Json.field meta "durable" with
      | `True ->
        if is_allocation && String.equal (Json.text (Json.field result "kind")) "empty"
        then
          Json.fail
            Outcome_unknown
            "standalone empty allocation cannot be a durable receipt";
        Committed { Commit.workspace_revision; result }
      | `False
        when is_allocation && String.equal (Json.text (Json.field result "kind")) "empty"
        ->
        let explanation =
          Api_codec.decode Allocation.Explanation.codec (Json.field result "explanation")
          |> Disk.unwrap
        in
        let captured =
          Api_position.Workspace_revision.of_int
            (Allocation.Explanation.captured_workspace_revision explanation)
          |> Disk.unwrap
        in
        if not (Api_position.Workspace_revision.equal captured workspace_revision)
        then
          Json.fail
            Outcome_unknown
            "empty allocation capture differs from acknowledgement";
        Observed_empty { Observation.workspace_revision; explanation }
      | `False | `Null | `String _ | `Number _ | `Object _ | `Array _ ->
        Json.fail Outcome_unknown "response does not confirm durable publication")
  in
  Result.map_error decoded ~f:(fun problem ->
    Problem.create Outcome_unknown ("invalid mutation acknowledgement: " ^ problem.message))
;;
