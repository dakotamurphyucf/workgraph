open Core

module Query : sig
  (** Current bounded reads. Positive offset requires the exact observed
      workspace revision. Omitted fields choose defaults; explicit null rejects.
      These are unscoped requests; catalog adds required workspace identity. *)
  type t =
    | Workspace_get
    | Project_get of Id.Project.t
    | Project_list
    | Milestone_get of Id.Milestone.t
    | Milestone_list of Id.Project.t option
    | Actor_list
    | Label_list
    | Status_list

  type request

  val query : request -> t
  val offset : request -> int
  val limit : request -> int
  val at_revision : request -> int option
  val include_archived : request -> bool
  val max_bytes : request -> int
  val decode : method_:string -> params:Jsonaf.t -> (request, Problem.t) Result.t
end

(** One executable request/result declaration per method; Runtime consumes these
    actual codecs and projected responses, rather than a parallel method registry. *)
val methods : Api_method.Packed.t list

val request_codec : method_:string -> Jsonaf.t Api_codec.t option
val response_codec : method_:string -> Jsonaf.t Api_codec.t option

(** Check projected result data after fitting, preserving unexpected failures. *)
val validate_result : method_:string -> Jsonaf.t -> unit
