open Core

module Initialization = struct
  type t =
    { protocol_version : int
    ; max_frame_bytes : int
    ; name : string
    ; version : string
    ; administrative_receipts : bool
    ; workspace_receipts : bool
    ; registry_format_version : int
    ; background_exports : bool
    }

  let current () =
    { protocol_version = 1
    ; max_frame_bytes = Framing.max_bytes
    ; name = "workgraph"
    ; version = Version.value
    ; administrative_receipts = true
    ; workspace_receipts = true
    ; registry_format_version = 1
    ; background_exports = true
    }
  ;;

  let codec =
    let open Api_codec in
    let open Fields in
    both
      (both
         (both
            (required "protocol_version" (decimal ~max:1))
            (required "max_frame_bytes" (decimal ~max:Framing.max_bytes)))
         (both
            (required "name" (text ~max_bytes:128))
            (required "version" (text ~max_bytes:128))))
      (both
         (both
            (required "administrative_receipts" boolean)
            (required "workspace_receipts" boolean))
         (both
            (required "registry_format_version" (decimal ~max:1))
            (required "background_exports" boolean)))
    |> map
         ~decode:
           (fun
             ( ((protocol_version, max_frame_bytes), (name, version))
             , ( (administrative_receipts, workspace_receipts)
               , (registry_format_version, background_exports) ) ) ->
           { protocol_version
           ; max_frame_bytes
           ; name
           ; version
           ; administrative_receipts
           ; workspace_receipts
           ; registry_format_version
           ; background_exports
           })
         ~encode:
           (fun
             { protocol_version
             ; max_frame_bytes
             ; name
             ; version
             ; administrative_receipts
             ; workspace_receipts
             ; registry_format_version
             ; background_exports
             } ->
           ( ((protocol_version, max_frame_bytes), (name, version))
           , ( (administrative_receipts, workspace_receipts)
             , (registry_format_version, background_exports) ) ))
    |> object_
  ;;
end

let initialize =
  Api_method.create
    ~name:"initialize"
    ~summary:"Read daemon capabilities and protocol limits."
    ~mode:Read
    ~request:(Api_codec.object_ Api_codec.Fields.empty)
    ~response:Initialization.codec
;;

let shutdown =
  Api_method.create
    ~name:"daemon.shutdown"
    ~summary:"Drain admitted work and stop the daemon."
    ~mode:Write
    ~request:(Api_codec.object_ Api_codec.Fields.empty)
    ~response:(Api_codec.object_ (Api_codec.Fields.required "stopping" Api_codec.boolean))
;;

let methods = [ Api_method.Packed.Pack initialize; Pack shutdown ]

let find name =
  List.find methods ~f:(fun (Api_method.Packed.Pack method_) ->
    String.equal name (Api_method.name method_))
;;
