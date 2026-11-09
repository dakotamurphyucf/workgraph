"""A fixed loopback port survives an immediate clean restart, without port sharing."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen


def start(binary, root, port):
    root.mkdir(mode=0o700)
    log = root / 'stdout'
    error = root / 'stderr'
    with log.open('wb') as out, error.open('wb') as err:
        process = subprocess.Popen(
            [binary, '--state-root', str(root), '--port', str(port), '--no-open'],
            stdout=out, stderr=err,
        )
    return process, log, error


def ready(process, log, error):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise AssertionError(f'Companion exited before ready: {error.read_text()}')
        for line in log.read_text().splitlines():
            value = json.loads(line)
            if value.get('event') == 'ready':
                return value
        time.sleep(0.02)
    raise AssertionError('Companion did not become ready')


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
            raise AssertionError('Companion did not stop after SIGTERM')


def main():
    binary = str(Path(sys.argv[1]).resolve(strict=True))
    children = []
    with tempfile.TemporaryDirectory(prefix='wg-ui-port-') as directory:
        root = Path(directory)
        try:
            port = 0
            for index in range(2):
                process, log, error = start(binary, root / f'instance-{index}', port)
                children.append(process)
                info = ready(process, log, error)
                actual = int(info['port'])
                assert port == 0 or actual == port, 'Restart changed the requested port'
                port = actual
                with urlopen(info['url'], timeout=5) as response:
                    assert response.status == 200
                    assert response.read(), 'Empty HTML response'
                # A distinct private root must not allow another live listener
                # to share this address or receive some of its browser requests.
                other, _, other_error = start(binary, root / f'competing-{index}', port)
                children.append(other)
                assert other.wait(timeout=10) != 0, 'A competing listener shared the port'
                assert 'Address already in use' in other_error.read_text(), other_error.read_text()
                stop(process)
            print('fixed-port HTTP restart and exclusive live binding: passed')
        finally:
            for process in reversed(children):
                stop(process)


if __name__ == '__main__':
    main()
