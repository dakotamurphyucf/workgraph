#!/usr/bin/env python3
"""Optional POSIX notification bridge; explicit callbacks, saved acknowledgements.

Python3.10+, standard library. The daemon never runs this callback. Delivery is
at least once: callbacks must durably deduplicate delivery_id before returning0.
"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def save(path, value):
    """Sync bytes and atomic rename, then sync the parent. Caller holds the lock."""
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            output.write(canonical(value) + '\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def checkpoint_lock(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(str(path) + '.lock', os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('another watcher owns this checkpoint') from error
        yield
    finally:
        os.close(descriptor)


class Watcher:
    """Caller holds checkpoint_lock across construction and every step.

    Client.call returns the Workgraph {data,meta} result or raises. Callback takes
    one JSON-compatible packet; returning means its work is durably recorded.
    Neither saved data nor notification bodies are executable code.
    """
    def __init__(self, client, path, identity, callback):
        self.client = client
        self.path = Path(path)
        self.identity = json.loads(canonical(identity))
        self.callback = callback
        if self.path.exists():
            self.state = json.loads(self.path.read_text(encoding='utf-8'))
            if (set(self.state) != {'identity', 'last_notification_id', 'pending'}
                    or self.state['identity'] != self.identity):
                raise ValueError('checkpoint identity differs; use the original configuration or a fresh checkpoint')
            self._validate_pending()
        else:
            self.state = {'identity': self.identity, 'last_notification_id': None, 'pending': None}
            save(self.path, self.state)

    def _ack(self, notification_id):
        identity = self.identity
        mutation = 'watch-' + hashlib.sha256(canonical([identity, notification_id]).encode()).hexdigest()
        params = {key: identity[key] for key in ['workspace_id', 'actor_id', 'consumer_id', 'recipient']}
        params.update(mutation_id=mutation, notification_ids=[notification_id])
        if identity['run_id'] is not None:
            params['run_id'] = identity['run_id']
        return {'method': 'inbox.ack', 'params': params}

    def _packet(self, item, meta):
        scope = {key: self.identity[key] for key in ['workspace_id', 'consumer_id', 'recipient']}
        serial = item['notification_id']
        if not isinstance(serial, str) or not serial.isascii() or not serial.isdecimal() or str(int(serial)) != serial or int(serial) < 1:
            raise ValueError('invalid notification identity')
        return {**scope, 'delivery_id': hashlib.sha256(canonical([scope, serial]).encode()).hexdigest(),
                'notification': item, 'read_meta': meta}

    def _validate_pending(self):
        pending = self.state['pending']
        if pending is None:
            return
        if (not isinstance(pending, dict) or set(pending) != {'packet', 'ack', 'callback_completed'}
                or type(pending['callback_completed']) is not bool):
            raise ValueError('malformed pending delivery')
        packet = pending['packet']
        expected = self._packet(packet['notification'], packet['read_meta'])
        if packet != expected or pending['ack'] != self._ack(packet['notification']['notification_id']):
            raise ValueError('pending delivery or acknowledgement identity differs')

    def step(self, *, timeout_ms=20000, max_bytes=65536):
        pending = self.state['pending']
        if pending is None:
            params = {key: self.identity[key] for key in ['workspace_id', 'consumer_id', 'recipient']}
            params.update(after='0', limit='1', timeout_ms=str(timeout_ms), max_bytes=str(max_bytes))
            for key in ['kinds', 'ticket_id']:
                if self.identity[key] is not None:
                    params[key] = self.identity[key]
            response = self.client.call('inbox.wait', params)
            data = response['data']
            if data['consumer_id'] != self.identity['consumer_id'] or data['recipient'] != self.identity['recipient']:
                raise ValueError('inbox response identity differs')
            if not data['items']:
                if int(data['remaining']) > 0:
                    raise ValueError('notification cannot fit; increase --max-bytes')
                return False
            if len(data['items']) != 1:
                raise ValueError('inbox response exceeded requested single-item page')
            packet = self._packet(data['items'][0], response['meta'])
            pending = {'packet': packet, 'ack': self._ack(packet['notification']['notification_id']),
                       'callback_completed': False}
            state = {**self.state, 'pending': pending}
            save(self.path, state)
            self.state = state
        if not pending['callback_completed']:
            # Pass a copy: callback mutations cannot alter the durable ack identity.
            self.callback(json.loads(canonical(pending['packet'])))
            pending = {**pending, 'callback_completed': True}
            state = {**self.state, 'pending': pending}
            save(self.path, state)
            self.state = state
        response = self.client.call(pending['ack']['method'], pending['ack']['params'])
        expected = {key: pending['ack']['params'][key] for key in ['consumer_id', 'recipient', 'notification_ids']}
        if response['meta'].get('durable') is not True or response['data'] != expected:
            raise RuntimeError('acknowledgement lacks the expected durable receipt; pending request retained')
        state = {**self.state, 'last_notification_id': pending['packet']['notification']['notification_id'], 'pending': None}
        save(self.path, state)
        self.state = state
        return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--socket', required=True)
    parser.add_argument('--workspace-id', required=True)
    parser.add_argument('--actor-id', required=True)
    parser.add_argument('--run-id')
    parser.add_argument('--consumer-id', required=True)
    parser.add_argument('--recipient-kind', choices=['actor', 'run'], default='actor')
    parser.add_argument('--recipient-id', required=True)
    parser.add_argument('--state', required=True)
    parser.add_argument('--ticket-id')
    parser.add_argument('--kind', action='append', dest='kinds')
    parser.add_argument('--callback-cwd', default=os.getcwd())
    parser.add_argument('--timeout-ms', type=int, default=20000)
    parser.add_argument('--max-bytes', type=int, default=65536)
    parser.add_argument('--once', action='store_true', help='finish one pending/new delivery or one wait timeout')
    parser.add_argument('callback', nargs=argparse.REMAINDER, help='-- PROGRAM ARG... (receives JSON on stdin)')
    args = parser.parse_args()
    callback = args.callback[1:] if args.callback[:1] == ['--'] else args.callback
    if not callback:
        parser.error('provide an explicit callback after --')
    if not 1 <= args.timeout_ms <= 25000 or not 4096 <= args.max_bytes <= 1048576:
        parser.error('timeout must be1..25000ms and max-bytes4096..1048576')
    if args.recipient_kind == 'actor' and args.recipient_id != args.actor_id:
        parser.error('actor recipient must match actor-id')
    if args.recipient_kind == 'run' and args.recipient_id != args.run_id:
        parser.error('run recipient must match run-id, owned by actor-id')
    identity = {'workspace_id': args.workspace_id, 'actor_id': args.actor_id, 'run_id': args.run_id,
                'consumer_id': args.consumer_id, 'recipient': {'kind': args.recipient_kind, 'id': args.recipient_id},
                'kinds': sorted(set(args.kinds)) if args.kinds else None, 'ticket_id': args.ticket_id,
                'callback_argv': callback, 'callback_cwd': str(Path(args.callback_cwd).resolve()),
                'socket': str(Path(args.socket).resolve())}
    spec = importlib.util.spec_from_file_location('history_adapter', Path(__file__).with_name('history-adapter.py'))
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)
    client = adapter.Workgraph(identity['socket'])
    def invoke(packet):
        # Explicit argv only; stored text is stdin data, never a shell fragment.
        subprocess.run(callback, cwd=identity['callback_cwd'], input=(canonical(packet) + '\n').encode(),
                       check=True, stdout=sys.stderr, stderr=sys.stderr)
    path = Path(args.state).absolute()
    with checkpoint_lock(path):
        watcher = Watcher(client, path, identity, invoke)
        while True:
            delivered = watcher.step(timeout_ms=args.timeout_ms, max_bytes=args.max_bytes)
            if delivered or args.once:
                print(canonical({'delivered': delivered, 'last_notification_id': watcher.state['last_notification_id']}), flush=True)
            if args.once:
                break
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
