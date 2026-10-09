(** Communication identifiers have the existing opaque 1..96-byte ID syntax;
    each module is a distinct domain type. Decoders validate the syntax. *)
module Board : Id.S

module Thread : Id.S
module Request : Id.S
module Team : Id.S
module Subscription : Id.S
module Message : Id.S

(** Durable inbox consumer identity, scoped jointly with recipient and workspace. *)
module Consumer : Id.S
