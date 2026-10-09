"""Focused lost-ack cursor/observable-source checks, no model or daemon required."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ADAPTER = Path(__file__).resolve().parents[2] / "examples/history-adapter.py"
spec = importlib.util.spec_from_file_location("history_adapter", ADAPTER)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AdapterTest(unittest.TestCase):
    def test_lost_ack_replays_exact_pending_and_rejects_rewritten_source(self):
        class DurableClient:
            def __init__(self):
                self.receipts = {}
                self.events = []
                self.lose_ack = True
            def call(self, method, params):
                self.assert_method = method
                identity = params["mutation_id"]
                encoded = module.canonical(params)
                if identity in self.receipts:
                    previous, result = self.receipts[identity]
                    if previous != encoded:
                        raise ValueError("changed retry")
                    return result
                self.events.extend(params["events"])
                result = {"data": {"through": str(len(self.events))}, "meta": {"durable": True}}
                self.receipts[identity] = encoded, result
                if self.lose_ack:
                    self.lose_ack = False
                    raise EOFError("lost ack after durable commit")
                return result
        with tempfile.TemporaryDirectory() as root:
            source, cursor = Path(root) / "source.jsonl", Path(root) / "cursor.json"
            source.write_text(module.canonical({"source_id": "first", "payload_base64": "/wA=", "searchable_text": "complete fact"}) + "\n")
            client = DurableClient()
            params = dict(source=source, state_path=cursor, workspace="ws", session="s", actor="a")
            with self.assertRaises(EOFError):
                module.ingest(client, **params)
            pending = json.loads(cursor.read_text())
            self.assertEqual(pending["next_line"], 0)
            self.assertIsNotNone(pending["pending"])
            state = module.ingest(client, **params)
            self.assertEqual(state["through"], "1")
            self.assertEqual(len(client.events), 1)
            self.assertEqual(client.events[0]["payload"], {"kind": "inline", "bytes_base64": "/wA="})
            source.write_text(module.canonical({"source_id": "first", "payload": "changed"}) + "\n")
            with self.assertRaisesRegex(ValueError, "source changed"):
                module.ingest(client, **params)


if __name__ == "__main__":
    unittest.main()
