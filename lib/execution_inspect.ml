open Core

module Stream = struct
  type t =
    | Stdout
    | Stderr
  [@@deriving equal, sexp]
end

module Selection = struct
  type t =
    | Range of
        { offset : int
        ; length : int
        }
    | Tail of int

  let validate ~offset ~length =
    Json.decode (fun () ->
      if offset < 0 || length < 1 || length > 65536
      then
        Json.fail
          Invalid_argument
          "inspection requires nonnegative byte offset and length 1..65536")
  ;;

  let range ~offset ~length =
    Result.map (validate ~offset ~length) ~f:(fun () -> Range { offset; length })
  ;;

  let tail ~length = Result.map (validate ~offset:0 ~length) ~f:(fun () -> Tail length)
end

type t =
  { bytes : string
  ; metadata : Jsonaf.t
  ; text : string
  ; lossy : bool
  }

let bytes t = t.bytes

let create capture ~stream ~selection =
  Json.decode (fun () ->
    let output =
      match stream with
      | Stream.Stdout -> Execution_capture.stdout capture
      | Stderr -> Execution_capture.stderr capture
    in
    let retained = Execution_capture.Output.bytes output in
    let retained_bytes = String.length retained in
    let offset, length, kind =
      match selection with
      | Selection.Range { offset; length } -> offset, length, "range"
      | Tail length -> Int.max 0 (retained_bytes - length), length, "retained_tail"
    in
    if offset > retained_bytes
    then
      Json.fail
        Invalid_argument
        (sprintf
           "inspection offset %d exceeds retained prefix of %d bytes; discarded output \
            cannot be recovered"
           offset
           retained_bytes);
    let bytes =
      String.sub retained ~pos:offset ~len:(Int.min length (retained_bytes - offset))
    in
    let text = Buffer.create (String.length bytes) in
    let lossy =
      Uutf.String.fold_utf_8
        (fun lossy _ -> function
           | `Uchar uchar ->
             Uutf.Buffer.add_utf_8 text uchar;
             lossy
           | `Malformed _ ->
             Uutf.Buffer.add_utf_8 text Uutf.u_rep;
             true)
        false
        bytes
    in
    let metadata =
      Json.obj
        [ ( "stream"
          , Json.string
              (match stream with
               | Stdout -> "stdout"
               | Stderr -> "stderr") )
        ; "selection", Json.string kind
        ; "retention", Json.string "prefix"
        ; "offset", Json.int offset
        ; "returned_bytes", Json.int (String.length bytes)
        ; "retained_bytes", Json.int retained_bytes
        ; "omitted_retained_bytes", Json.int (retained_bytes - String.length bytes)
        ; "observed_bytes", Json.int64 (Execution_capture.Output.observed_bytes output)
        ; "observed_sha256", Json.string (Execution_capture.Output.observed_sha256 output)
        ; ("eof", if Execution_capture.Output.eof output then `True else `False)
        ; ( "truncated"
          , if Execution_capture.Output.truncated output then `True else `False )
        ; ( "at_observed_end"
          , if
              Int64.equal
                (Int64.of_int (offset + String.length bytes))
                (Execution_capture.Output.observed_bytes output)
            then `True
            else `False )
        ; ( "source_before"
          , Source_provenance.coverage (Execution_capture.source_before capture) )
        ; ( "source_after"
          , Source_provenance.coverage (Execution_capture.source_after capture) )
        ; ( "outcome"
          , Api_codec.encode
              Execution_capture.Outcome.codec
              (Execution_capture.outcome capture)
            |> Disk.unwrap )
        ]
    in
    { bytes; metadata; text = Buffer.contents text; lossy })
;;

let to_json t =
  match t.metadata with
  | `Object fields ->
    Json.obj
      (fields
       @ [ "text", Json.string t.text
         ; ("text_lossy", if t.lossy then `True else `False)
         ; "data_base64", Json.string (Base64.encode_exn t.bytes)
         ])
  | _ -> assert false
;;

let to_text t =
  let metadata = Json.canonical t.metadata in
  metadata
  ^ "\nDecoded output"
  ^ (if t.lossy
     then " (lossy UTF8 replacement; use --output bytes for exact data)"
     else "")
  ^ ":\n"
  ^ t.text
;;
