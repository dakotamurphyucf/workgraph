/* Linux-only qualification shim, never linked into the application.
   LD_PRELOAD plus EIO_BACKEND=posix intercepts actual libc persistence calls.
   An external arm file enables exactly one matching failure, before or after
   the syscall. A marker proves the intended boundary was exercised. This models
   error returns/process exit, not power loss or device-cache guarantees. */
#define _GNU_SOURCE
#define _FILE_OFFSET_BITS 64
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <unistd.h>

static const char *arm_path, *match_path, *phase_name, *when_name, *action_name;
static int error_number, exact_path, occurrence;
static atomic_int fired, hits;

__attribute__((constructor)) static void initialize(void) {
  arm_path = getenv("WG_FAULT_ARM");
  match_path = getenv("WG_FAULT_MATCH");
  phase_name = getenv("WG_FAULT_PHASE");
  when_name = getenv("WG_FAULT_WHEN");
  action_name = getenv("WG_FAULT_ACTION");
  const char *error = getenv("WG_FAULT_ERRNO");
  error_number = error ? atoi(error) : EIO;
  exact_path = getenv("WG_FAULT_EXACT") != NULL;
  const char *nth = getenv("WG_FAULT_N");
  occurrence = nth ? atoi(nth) : 1;
}

static int fd_path(int fd, char *result) {
  char proc[64];
  snprintf(proc, sizeof proc, "/proc/self/fd/%d", fd);
  ssize_t n = readlink(proc, result, PATH_MAX - 1);
  if (n < 0) return 0;
  result[n] = '\0';
  return 1;
}

static int at_path(int fd, const char *name, char *result) {
  if (name[0] == '/') {
    return snprintf(result, PATH_MAX, "%s", name) < PATH_MAX;
  }
  char base[PATH_MAX];
  if (fd == AT_FDCWD) {
    if (!getcwd(base, sizeof base)) return 0;
  } else if (!fd_path(fd, base)) return 0;
  return snprintf(result, PATH_MAX, "%s/%s", base, name) < PATH_MAX;
}

static int inject(const char *phase, const char *path, const char *when) {
  int saved_errno = errno;
  if (!arm_path || !match_path || !phase_name || !when_name ||
      atomic_load(&fired) || strcmp(phase_name, phase) || strcmp(when_name, when) ||
      (exact_path ? strcmp(path, match_path) != 0 : strstr(path, match_path) == NULL) ||
      access(arm_path, F_OK) != 0) {
    errno = saved_errno;
    return 0;
  }
  if (atomic_fetch_add(&hits, 1) + 1 != occurrence) {
    errno = saved_errno;
    return 0;
  }
  int expected = 0;
  if (!atomic_compare_exchange_strong(&fired, &expected, 1)) {
    errno = saved_errno;
    return 0;
  }
  char marker[PATH_MAX];
  if (snprintf(marker, sizeof marker, "%s.fired", arm_path) >= (int)sizeof marker)
    _exit(87);
  int fd = open(marker, O_CREAT | O_EXCL | O_WRONLY, 0600);
  if (fd < 0) _exit(88);
  close(fd);
  if (action_name && !strcmp(action_name, "exit")) _exit(86);
  errno = error_number;
  return 1;
}

int fsync(int fd) {
  int (*real_fn)(int) = dlsym(RTLD_NEXT, "fsync");
  char path[PATH_MAX];
  struct stat st;
  if (!fd_path(fd, path) || fstat(fd, &st)) return real_fn(fd);
  const char *phase = S_ISDIR(st.st_mode) ? "directory_sync" : "file_sync";
  if (inject(phase, path, "before")) return -1;
  int result = real_fn(fd);
  if (!result && inject(phase, path, "after")) return -1;
  return result;
}

ssize_t writev(int fd, const struct iovec *iov, int count) {
  ssize_t (*real_fn)(int, const struct iovec *, int) = dlsym(RTLD_NEXT, "writev");
  char path[PATH_MAX];
  if (!fd_path(fd, path)) return real_fn(fd, iov, count);
  if (inject("write", path, "before")) return -1;
  ssize_t result = real_fn(fd, iov, count);
  if (result >= 0 && inject("write", path, "after")) return -1;
  return result;
}

ssize_t pwritev(int fd, const struct iovec *iov, int count, off_t offset) {
  ssize_t (*real_fn)(int, const struct iovec *, int, off_t) = dlsym(RTLD_NEXT, "pwritev64");
  char path[PATH_MAX];
  if (!fd_path(fd, path)) return real_fn(fd, iov, count, offset);
  if (inject("write", path, "before")) return -1;
  ssize_t result = real_fn(fd, iov, count, offset);
  if (result >= 0 && inject("write", path, "after")) return -1;
  return result;
}

ssize_t write(int fd, const void *buffer, size_t count) {
  ssize_t (*real_fn)(int, const void *, size_t) = dlsym(RTLD_NEXT, "write");
  char path[PATH_MAX];
  if (!fd_path(fd, path)) return real_fn(fd, buffer, count);
  if (inject("write", path, "before")) return -1;
  ssize_t result = real_fn(fd, buffer, count);
  if (result >= 0 && inject("write", path, "after")) return -1;
  return result;
}

int renameat(int oldfd, const char *oldname, int newfd, const char *newname) {
  int (*real_fn)(int, const char *, int, const char *) = dlsym(RTLD_NEXT, "renameat");
  char path[PATH_MAX];
  if (!at_path(newfd, newname, path)) return real_fn(oldfd, oldname, newfd, newname);
  if (inject("rename", path, "before")) return -1;
  int result = real_fn(oldfd, oldname, newfd, newname);
  if (!result && inject("rename", path, "after")) return -1;
  return result;
}
