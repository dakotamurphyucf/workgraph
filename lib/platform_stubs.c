/* Directory publication must never replace even an empty raced destination.
   Eio.Path currently exposes only replacing rename. Paths are copied before
   releasing the OCaml runtime lock; no managed pointer escapes the call. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/syscall.h>
#endif
#include <caml/mlvalues.h>
#include <caml/memory.h>
#include <caml/fail.h>
#include <caml/threads.h>
#include <caml/unixsupport.h>

CAMLprim value workgraph_rename_exclusive(value v_src, value v_dst)
{
  CAMLparam2(v_src, v_dst);
  caml_unix_check_path(v_src, "rename_exclusive");
  caml_unix_check_path(v_dst, "rename_exclusive");
  char *src = caml_stat_strdup_noexc(String_val(v_src));
  char *dst = caml_stat_strdup_noexc(String_val(v_dst));
  if (src == NULL || dst == NULL) {
    if (src != NULL) caml_stat_free(src);
    if (dst != NULL) caml_stat_free(dst);
    caml_raise_out_of_memory();
  }
  int result;
  caml_enter_blocking_section();
#if defined(__APPLE__)
  result = renamex_np(src, dst, RENAME_EXCL);
#elif defined(__linux__) && defined(SYS_renameat2)
  result = syscall(SYS_renameat2, AT_FDCWD, src, AT_FDCWD, dst, 1 /* RENAME_NOREPLACE */);
#else
  errno = ENOSYS;
  result = -1;
#endif
  int saved_errno = errno;
  caml_leave_blocking_section();
  caml_stat_free(src);
  caml_stat_free(dst);
  if (result == -1) caml_unix_error(saved_errno, "rename_exclusive", v_dst);
  CAMLreturn(Val_unit);
}
