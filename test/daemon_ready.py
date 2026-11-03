"""Readiness probe for process tests using pathname Unix sockets."""
import socket


def is_listening(address):
    """A bound pathname alone is not ready; require a successful connection.

    Callers own their startup deadline and child-process checks. Only normal
    pre-listen failures are retried; unexpected socket errors remain visible.
    """
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(1)
        try:
            connection.connect(str(address))
        except (FileNotFoundError, ConnectionRefusedError):
            return False
        return True


def is_current_daemon_ready(address, log_path, log_offset):
    """Require this launch's ready diagnostic before probing its endpoint.

    Capture the log byte size before launching, after any previous child exited.
    An old socket can briefly remain connectable after a crash; neither that
    connection nor a ready line from the previous invocation proves readiness.
    Callers still own the deadline and current child-process exit checks.
    """
    with log_path.open("rb") as log:
        log.seek(log_offset)
        ready = any(line.startswith(b"workgraph daemon ready ") and line.endswith(b"\n")
                    for line in log)
    return ready and is_listening(address)
