let inspect path = File_content.inspect path ~max_bytes:Resource.max_blob_bytes
let copy src ~dst = File_content.copy src ~dst ~max_bytes:Resource.max_blob_bytes

let read_range path ~offset ~length =
  File_content.read_range path ~max_bytes:Resource.max_blob_bytes ~offset ~length
;;
