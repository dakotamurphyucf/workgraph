(** The explicit wire projection for each current service method family. This
    separates domain/storage results from the one public response contract. *)
val layout : string -> Api_response.Layout.t
