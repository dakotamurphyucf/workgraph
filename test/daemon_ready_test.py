"""A socket pathname must not satisfy the test harness readiness gate."""
from pathlib import Path
import socket
import tempfile
import unittest

from daemon_ready import is_current_daemon_ready, is_listening


class DaemonReadyTest(unittest.TestCase):
    def test_restart_requires_current_invocation_ready_line(self):
        with tempfile.TemporaryDirectory(prefix="wg-ready-", dir="/tmp") as directory:
            address = Path(directory) / "socket"
            log = Path(directory) / "daemon.log"
            ready = b'workgraph daemon ready registry="registry" socket="socket"\n'
            log.write_bytes(ready)
            offset = log.stat().st_size
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                listener.bind(str(address))
                listener.listen(8)
                self.assertTrue(is_listening(address))
                self.assertFalse(is_current_daemon_ready(address, log, offset))
                with log.open("ab") as output:
                    output.write(b"workgraph daemon starting\n")
                self.assertFalse(is_current_daemon_ready(address, log, offset))
                with log.open("ab") as output:
                    output.write(ready[:-1])
                self.assertFalse(is_current_daemon_ready(address, log, offset))
                with log.open("ab") as output:
                    output.write(b"\n")
                self.assertTrue(is_current_daemon_ready(address, log, offset))
            self.assertFalse(is_current_daemon_ready(address, log, offset))

    def test_missing_bound_listening_and_closed_socket(self):
        with tempfile.TemporaryDirectory(prefix="wg-ready-", dir="/tmp") as directory:
            address = Path(directory) / "socket"
            self.assertFalse(is_listening(address))
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                listener.bind(str(address))
                self.assertTrue(address.exists())
                self.assertFalse(is_listening(address))
                listener.listen(1)
                self.assertTrue(is_listening(address))
                connection, _ = listener.accept()
                connection.close()
            self.assertTrue(address.exists())
            self.assertFalse(is_listening(address))


if __name__ == "__main__":
    unittest.main()
