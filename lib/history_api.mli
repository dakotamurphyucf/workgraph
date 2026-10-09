open Core

(** History mutations publish in the independent journal; none are planning
    operations. Raw public codecs preserve caller JSON identity and opaque
    payload bytes. Scope existence is validated by the enclosing workspace. *)
module Command : sig
  type t =
    | Create of
        { id : Session_id.t
        ; title : string
        ; parent : Session.Event_ref.t option
        ; scopes : Entity_ref.t list
        }
    | Archive of Session_id.t
    | Append of
        { session : Session_id.t
        ; inputs : Session_event.Input.t list
        }

  val decode : method_:string -> params:Jsonaf.t -> (t, Problem.t) Result.t
  val encode : t -> (string * Jsonaf.t, Problem.t) Result.t
end

module Query : sig
  module Part : sig
    type t =
      | Payload
      | Searchable_text
      | Attachment of int
  end

  type t =
    | Session_get of Session_id.t
    | Session_list of
        { offset : int
        ; limit : int
        ; include_archived : bool
        }
    | Get of Session.Event_ref.t
    | Read of
        { session : Session_id.t
        ; anchor : int
        ; direction : History_query.direction
        ; limit : int
        }
    | Search of
        { text : string
        ; session : Session_id.t option
        ; kinds : string list option
        ; after : Session.Event_ref.t option
        ; limit : int
        }
    | Payload of
        { event : Session.Event_ref.t
        ; part : Part.t
        ; offset : int
        ; length : int
        }

  type request =
    { query : t
    ; max_bytes : int
    ; head : string option option
    }

  val decode : method_:string -> params:Jsonaf.t -> (request, Problem.t) Result.t
end

val mutation_methods : string list
val query_methods : string list
val methods : Api_method.Packed.t list
val request_codec : method_:string -> Jsonaf.t Api_codec.t option
val response_codec : method_:string -> Jsonaf.t Api_codec.t option

(** Project only journal receipt envelopes (including durable metadata), never
    input payloads. Validates descriptor public data; malformed programmer output
    raises Api_method.Invalid_response, preserving uncertain-write semantics. *)
val mutation_result : method_:string -> Jsonaf.t -> Jsonaf.t

val validate_result : method_:string -> Jsonaf.t -> unit
