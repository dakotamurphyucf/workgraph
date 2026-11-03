open Core

let literal text =
  let longest, trailing =
    String.fold text ~init:(0, 0) ~f:(fun (longest, current) char ->
      if Char.equal char '`'
      then (
        let current = current + 1 in
        Int.max longest current, current)
      else longest, 0)
  in
  let fence = String.make (Int.max 3 (Int.max longest trailing + 1)) '`' in
  fence
  ^ "text\n"
  ^ text
  ^ (if String.is_suffix text ~suffix:"\n" then "" else "\n")
  ^ fence
  ^ "\n"
;;

let section ~heading text =
  "\n### "
  ^ heading
  ^ "\n\n"
  ^ if String.is_empty text then "_None recorded._\n" else literal text
;;
