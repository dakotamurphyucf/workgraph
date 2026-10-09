"""A socket pathname must not satisfy the test harness readiness gate."""
from pathlib import Path
import socket
import tempfile
import unittest

from daemon_ready import is_listening


class DaemonReadyTest(unittest.TestCase):
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
