#!/usr/bin/env python3
"""Convert selected user-visible Claude JSONL parts into deterministic history events.

Text, tool names/inputs and visible tool results only. Private reasoning is never
imported. Oversized visible parts are split on UTF-8 boundaries without clipping.
Unsupported parts are counted on stderr; missing/duplicate UUIDs and malformed
records reject. Publish output only after successful conversion.
"""
import argparse
import json
from pathlib import Path
import sys


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def chunks(text, limit):
    current, size = [], 0
    for char in text:
        count = len(char.encode("utf-8"))
        if size + count > limit:
            yield "".join(current)
            current, size = [], 0
        current.append(char)
        size += count
    if current:
        yield "".join(current)


def visible(part, counts):
    if not isinstance(part, dict):
        raise ValueError("message part must be an object")
    kind = part.get("type")
    if kind == "text":
        text = part.get("text")
        if not isinstance(text, str):
            raise ValueError("text part requires text")
        return "message", text
    if kind == "tool_use":
        name = part.get("name")
        if not isinstance(name, str) or not name or "input" not in part:
            raise ValueError("tool use requires name and input")
        return "tool_call", name + " " + canonical(part["input"])
    if kind == "tool_result":
        content = part.get("content")
        if isinstance(content, str):
            return "tool_result", content
        if not isinstance(content, list):
            raise ValueError("tool result requires string or part list")
        texts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
                texts.append(item["text"])
            else:
                counts["unsupported_parts"] += 1
        return "tool_result", "\n".join(texts)
    if kind in ("thinking", "redacted_thinking", "reasoning"):
        counts["private_parts_excluded"] += 1
    else:
        counts["unsupported_parts"] += 1
    return None


def convert(lines, max_bytes=32768):
    if not 1024 <= max_bytes <= 262144:
        raise ValueError("max-event-bytes must be 1024..262144")
    seen, result = set(), []
    counts = {"records": 0, "events": 0, "private_parts_excluded": 0, "unsupported_parts": 0, "non_message_records": 0}
    for number, line in enumerate(lines, 1):
        if not line.strip():
            raise ValueError(f"line {number}: blank JSONL record")
        entry = json.loads(line)
        if not isinstance(entry, dict):
            raise ValueError(f"line {number}: record must be an object")
        if entry.get("type") not in ("user", "assistant"):
            counts["non_message_records"] += 1
            continue
        counts["records"] += 1
        uuid = entry.get("uuid")
        if not isinstance(uuid, str) or not uuid or len(uuid.encode()) > 128 or uuid in seen:
            raise ValueError(f"line {number}: missing, duplicate or oversized source UUID")
        seen.add(uuid)
        message = entry.get("message")
        if not isinstance(message, dict):
            raise ValueError(f"line {number}: message object required")
        role = message.get("role", entry["type"])
        if role not in ("user", "assistant"):
            raise ValueError(f"line {number}: unsupported visible role")
        content = message.get("content")
        parts = [{"type": "text", "text": content}] if isinstance(content, str) else content
        if not isinstance(parts, list):
            raise ValueError(f"line {number}: content must be text or a part list")
        for index, part in enumerate(parts):
            selected = visible(part, counts)
            if selected is None:
                continue
            kind, text = selected
            for chunk_index, text_chunk in enumerate(chunks(text, max_bytes)):
                result.append({"source_id": f"{uuid}:{index}:{chunk_index}", "role": role, "kind": kind,
                               "payload": {"timestamp": entry.get("timestamp"), "role": role, "kind": kind,
                                           "part_index": index, "chunk_index": chunk_index, "text": text_chunk},
                               "searchable_text": text_chunk})
    counts["events"] = len(result)
    return result, counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("transcript", type=Path)
    parser.add_argument("--max-event-bytes", type=int, default=32768)
    args = parser.parse_args()
    try:
        with args.transcript.open(encoding="utf-8") as source:
            events, counts = convert(source, args.max_event_bytes)
        for event in events:
            print(canonical(event))
        print(canonical(counts), file=sys.stderr)
    except (ValueError, OSError, UnicodeError) as error:
        parser.exit(1, f"transcript-converter: {error}\n")


if __name__ == "__main__":
    main()
