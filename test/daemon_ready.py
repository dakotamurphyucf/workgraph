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
