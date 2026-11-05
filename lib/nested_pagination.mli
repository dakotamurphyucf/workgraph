open Core

(** Pure continuations for independently paged sections of ticket.context and
    expanded thread.get/request.get. Retains selectors and exact
    workspace or communication/discussion capture. Fact-key discovery switches
    to fact.keys with the same capture and an explicit response_path. No fetching
    or implicit merge.
    Text omissions require a same-position retry; paged suffix omissions advance
    only to the returned first unconsumed offset. Other omissions stay incomplete.
    Unsupported methods return None; malformed inputs/results return an error. *)
val methods : string list

val of_response
  :  Protocol.Request.t
  -> response:Jsonaf.t
  -> (Pagination_metadata.t option, Problem.t) Result.t
