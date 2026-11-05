#!/usr/bin/env python3
"""Read-only WGX dashboard. Python standard library only; launched by wgx.sh.

Network reads run on one cancellable worker. The UI publishes only completed
snapshots, retains the last successful observation on errors, and never submits a
mutation. Collection captures are independent; context and readiness use the
planning revision. Large workspaces enrich eight tickets per refresh.
"""
from __future__ import annotations

import argparse
import codecs
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import queue
import select
import signal
import subprocess
import sys
import termios
import threading
import time
import tty
import unicodedata

READS = frozenset({
    'workspace.overview', 'workspace.metrics', 'project.list', 'ticket.list', 'ticket.ready',
    'ticket.readiness', 'ticket.read', 'ticket.context', 'request.list', 'request.get',
    'run.list', 'reservation.list', 'reservation.path.list', 'reservation.contention',
    'coordinator.overview', 'activity.digest',
    'comment.list', 'resource.list',
})
# Linear-inspired dark palette: charcoal surfaces, neutral text and indigo accents.
# Restore the canvas after each row so line clearing also paints the background.
CANVAS = "\x1b[48;5;234m"
STYLES = {'': '38;5;252', 'bold': '1;38;5;254', 'dim': '38;5;245',
          'green': '38;5;108', 'yellow': '38;5;179', 'cyan': '38;5;104',
          'magenta': '38;5;104', 'red': '38;5;174', 'changed': '1;38;5;104',
          'selected': '1;38;5;189;48;5;237'}
STYLES.update({'heading-' + color: '1;' + STYLES[color]
               for color in ('green', 'yellow', 'cyan', 'magenta', 'red')})


class ReadError(Exception):
    """Expected transport, deadline, incomplete-read or protocol failure."""


def clean(value):
    """Never let record text become terminal controls or directional overrides."""
    text = str(value)
    return ''.join(f'\\u{ord(c):04x}' if unicodedata.category(c) in {'Cc', 'Cf', 'Cs'}
                   and c != '\n' else c for c in text)


def cell_width(char):
    if unicodedata.category(char) in {'Mn', 'Me'}:
        return 0
    return 2 if unicodedata.east_asian_width(char) in {'W', 'F'} else 1


def wrap(text, width):
    """Wrap complete safe text by terminal cells, including CJK and combining marks."""
    width = max(1, width)
    output = []
    for paragraph in clean(text).split('\n'):
        line, cells = '', 0
        for char in paragraph:
            size = cell_width(char)
            if cells + size > width and line:
                split = line.rfind(' ')
                if split > 0 and line[:split].strip():
                    output.append(line[:split])
                    line = line[split+1:]
                    cells = sum(cell_width(c) for c in line)
                else:
                    output.append(line)
                    line, cells = '', 0
            if size > width:
                char, size = '?', 1
            line += char
            cells += size
        output.append(line)
    return output


def age(timestamp, now):
    if not timestamp:
        return 'age unknown'
    try:
        # Workgraph emits UTC timestamps with fractional seconds and a space.
        moment = datetime.fromisoformat(timestamp.replace(' ', 'T').replace('Z', '+00:00'))
        seconds = max(0, int(now - moment.timestamp()))
    except (ValueError, TypeError):
        return 'age unknown'
    if seconds < 60:
        return f'{seconds}s ago'
    if seconds < 3600:
        return f'{seconds // 60}m ago'
    if seconds < 86400:
        return f'{seconds // 3600}h ago'
    return f'{seconds // 86400}d ago'


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def owner(ticket):
    claim = ticket.get('claim') or {}
    return claim.get('actor_id', 'unclaimed') + (f" / {claim['run_id']}" if claim.get('run_id') else '')


def reason_text(reason):
    kind = reason.get('kind', 'unknown')
    if kind == 'prerequisite':
        return 'waiting for ' + reason['ticket_id']
    # Preserve all typed reason fields, including capabilities, holders and pools.
    fields = ', '.join(f'{key.replace("_", " ")}: {value if isinstance(value, str) else compact(value)}'
                       for key, value in reason.items() if key != 'kind')
    return kind.replace('_', ' ') + (': ' + fields if fields else '')


def omissions(result):
    warnings = []
    budget = result.get('meta', {}).get('budget', {})
    if budget.get('truncated'):
        warnings.append('body/field omissions: ' + compact(budget))
    data = result.get('data', {})
    if int(data.get('omitted_for_budget', 0)):
        warnings.append('omitted records: ' + str(data['omitted_for_budget']))
    return warnings


def run_warning_text(warning):
    metadata = warning['metadata']
    run = warning['source']['run_id']
    if metadata['clock_regressed']:
        observation = 'observation clock regressed; age unknown'
    elif metadata['liveness'] == 'unobserved':
        observation = 'unobserved; age unknown'
    else:
        observation = 'stale observation ' + str(metadata['observation_age_ms']) + 'ms old'
    return run + ': ' + observation + '; held records ' + compact(metadata['held_work']) + ' (not process liveness)'


@dataclass(frozen=True)
class Snapshot:
    revision: str
    acquired: float
    tickets: list
    ready: set
    requests: list
    threads: dict
    runs: list
    paths: list
    metrics: dict
    events: list
    checks: dict
    warnings: tuple = ()
    projects: dict = field(default_factory=dict)
    name: str = ''
    run_warnings: list = field(default_factory=list)
    reservations: list = field(default_factory=list)
    activity_capture: dict = field(default_factory=dict)

    def fingerprints(self):
        records = {}
        for kind, items, key in [('ticket', self.tickets, 'ticket_id'),
                                 ('request', self.requests, 'request_id'),
                                 ('run', self.runs, 'run_id')]:
            for item in items:
                # Captured age is rendered later; unchanged records stay unchanged.
                records[(kind, item[key])] = compact(item)
        for key, item in self.threads.items():
            records[('thread', key)] = compact(item)
        for item in self.paths:
            records[('path', compact(item.get('target')))] = compact(item)
        return records


def changed_records(before, after):
    old = before.fingerprints() if before else {}
    new = after.fingerprints()
    return {key for key in old.keys() | new.keys() if old.get(key) != new.get(key)} if before else set()


class Client:
    def __init__(self, executable, context, run=None):
        self.executable, self.context, self.run = executable, context, run
        self.max_pages = int(os.environ.get('WGX_MAX_PAGES', '100'))
        self.total_bytes = int(os.environ.get('WGX_TOTAL_BYTES', '16777216'))
        if not 1 <= self.max_pages <= 1000 or not 4096 <= self.total_bytes <= 67108864:
            raise ValueError('invalid WGX traversal bounds')
        self.stopped = threading.Event()
        self.lock = threading.Lock()
        self.process = None
        self.revision, self.checks = None, {}

    def close(self):
        self.stopped.set()
        with self.lock:
            if self.process is not None and self.process.poll() is None:
                self.process.kill()

    def call(self, method, **params):
        if method not in READS:
            raise ValueError('dashboard cannot call a mutation: ' + method)
        args = [self.executable, '--context', self.context, method]
        for key, value in params.items():
            if key == 'paginate' and value:
                args += ['--paginate']
            elif isinstance(value, (dict, list)):
                args += ['--json-field', key, compact(value)]
            elif value is not None:
                args += ['--' + key.replace('_', '-'), str(value).lower() if isinstance(value, bool) else str(value)]
        with self.lock:
            if self.stopped.is_set():
                raise ReadError('viewer stopped')
            process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.process = process
        try:
            out, err = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise ReadError(method + ' timed out after 10 seconds') from None
        finally:
            with self.lock:
                self.process = None
        if process.returncode:
            raise ReadError(method + ': ' + clean((err or out).decode('utf-8', 'replace'))[:1800])
        try:
            envelope = json.loads(out)
            result = envelope['result']
            if 'error' in envelope or not isinstance(result['data'], dict) or not isinstance(result['meta'], dict):
                raise ValueError('invalid result')
        except (ValueError, KeyError, TypeError):
            raise ReadError(method + ': invalid success envelope') from None
        return result

    def pages(self, method, **params):
        result = self.call(method, paginate=True, page_limit=self.max_pages,
                           total_bytes=self.total_bytes, limit=100, max_bytes=1048576, **params)
        data = result['data']
        if data.get('pagination', {}).get('complete') is not True:
            raise ReadError(method + ': incomplete collection ' + compact(data.get('pagination')))
        pages = data.get('pages')
        if not isinstance(pages, list) or not pages:
            raise ReadError(method + ': missing captured pages')
        return ([item for page in pages for item in page['data']['items']],
                pages[0]['meta'], [method + ': ' + warning for page in pages for warning in omissions(page)])

    def cursor_rows(self, method, collection_field, **params):
        rows, warnings, size = [], [], 0
        boundary = dict(params)
        for _ in range(self.max_pages):
            try:
                result = self.call(method, limit=100, max_bytes=1048576, **boundary)
            except ReadError as error:
                raise ReadError(str(error) + '; retained boundary: ' + compact(boundary)) from None
            size += len(compact(result).encode())
            data = result['data']
            if size > self.total_bytes or data.get('needs_larger_budget'):
                raise ReadError(method + ' byte limit; retained boundary: ' + compact(boundary))
            next_cursor = data['cursor']
            if data['has_more'] and next_cursor == boundary.get('cursor'):
                raise ReadError(method + ' made no progress; retained boundary: ' + compact(boundary))
            rows.extend(data[collection_field])
            warnings.extend(omissions(result))
            if not data['has_more']:
                return rows, data, result['meta'], warnings
            boundary = {key: value for key, value in params.items() if key not in {'after', 'cursor'}}
            boundary['cursor'] = next_cursor
        raise ReadError(method + ' page limit; retained boundary: ' + compact(boundary))

    def digest(self, *, after=None, cursor=None, scope=None):
        boundary = {'after': after} if cursor is None else {'cursor': cursor}
        entries, data, _, warnings = self.cursor_rows('activity.digest', 'entries', scope=scope, **boundary)
        if any(entry['item']['clipped_fields'] for entry in entries):
            warnings.append('Activity contains source excerpts; inspect clipped_fields and exact sources in detail.')
        return entries, data['capture'], warnings

    def snapshot(self):
        overview = self.call('workspace.overview')
        revision = overview['meta']['workspace_revision']
        warnings = []

        def collection(method, **params):
            items, meta, notes = self.pages(method, **params)
            warnings.extend(notes)
            return items, meta

        projects, _ = collection('project.list', at_revision=revision)
        tickets, _ = collection('ticket.list', at_revision=revision)
        ready, _ = collection('ticket.ready', at_revision=revision, target_run_id=self.run)
        requests, _ = collection('request.list')
        threads = {q['thread_id']: q['thread_summary'] for q in requests}
        for request in requests:
            summary = request['thread_summary']
            if len(summary['title'].encode()) < int(summary['title_bytes']) or len(summary['links']) < int(summary['link_count']):
                warnings.append('request ' + request['request_id'] + ': thread summary is a bounded prefix; expand request.get.')
        runs, _ = collection('run.list')
        paths, _ = collection('reservation.path.list')
        reservations, _ = collection('reservation.list')
        run_warnings, _ = collection('coordinator.overview', kinds=['stale_run', 'unobserved_run'])
        metrics = self.call('workspace.metrics')
        warnings.extend(omissions(metrics))
        events, activity_capture, notes = self.digest(after=str(max(0, int(revision) - 8)))
        warnings.extend(notes)
        if self.revision != revision:
            self.revision, self.checks = revision, {}
        active = [t for t in tickets if t['status'] not in {'done', 'canceled'}]
        # Enrich eight at a time. Coverage is visible; uninspected is never "clear".
        for ticket in [t for t in active if t['ticket_id'] not in self.checks][:8]:
            tid = ticket['ticket_id']
            readiness = self.call('ticket.readiness', ticket_id=tid, at_revision=revision, target_run_id=self.run)
            context = self.call('ticket.context', ticket_id=tid, at_revision=revision, limit=100, max_bytes=1048576)
            self.checks[tid] = {'readiness': readiness['data'],
                                'context': {'pending_amendment_acknowledgements': context['data'].get('pending_amendment_acknowledgements', {})},
                                'warnings': omissions(readiness) + omissions(context)}
        for check in self.checks.values():
            warnings.extend(check['warnings'])
        return Snapshot(revision, time.time(), tickets, {t['ticket_id'] for t in ready}, requests,
                        threads, runs, paths, metrics['data'], events,
                        dict(self.checks), tuple(warnings), {p['project_id']:p for p in projects},
                        overview['data'].get('workspace', {}).get('name', ''),
                        run_warnings, reservations, activity_capture)

    def detail(self, entity, snapshot):
        kind, identity = entity
        if kind == 'request':
            result = self.call('request.get', request_id=identity, include_messages=True, max_bytes=1048576)
            return result['data'], omissions(result)
        if kind == 'reservation':
            target = json.loads(identity)
            items, data, meta, warnings = self.cursor_rows('reservation.contention', 'items', target=target, include_inactive=True)
            return {**data, 'items': items, 'capture_meta': meta}, warnings
        if kind != 'ticket':
            raise ValueError('unsupported detail entity')
        core = self.call('ticket.read', ticket_id=identity, at_revision=snapshot.revision, max_bytes=1048576)
        expansion = core['data']['expand_context']
        result = self.call(expansion['method'], **expansion['params'])
        target = {'kind': 'ticket', 'id': identity}
        comments, comments_meta, notes = self.pages('comment.list', target=target)
        resources, resources_meta, more = self.pages('resource.list', target=target)
        readiness = self.call('ticket.readiness', ticket_id=identity, at_revision=snapshot.revision, target_run_id=self.run)
        events, capture, history_notes = self.digest(after='0', scope={'kind': 'ticket', 'ticket_id': identity})
        return {**result['data'], 'ticket': core['data']['ticket'], 'start_readiness': readiness['data'], 'all_comments': comments, 'linked_resources': resources,
                'semantic_history': events, 'history_capture': capture, 'expand_context': expansion,
                'collection_captures': {'core': core['meta'], 'context': result['meta'], 'comments': comments_meta, 'resources': resources_meta}}, omissions(result) + omissions(readiness) + notes + more + history_notes


@dataclass(frozen=True)
class Row:
    text: str
    style: str = ''
    entity: tuple | None = None
    section: str = ''


def graph_rows(tickets, root, limit=250):
    """Bounded declared-prerequisite traversal, with shared/cyclic nodes explicit."""
    by_id = {t['ticket_id']: t for t in tickets}
    reverse = {}
    for ticket in tickets:
        for prerequisite in ticket.get('prerequisite_ticket_ids', []):
            reverse.setdefault(prerequisite, set()).add(ticket['ticket_id'])
    downstream, todo = set(), list(reverse.get(root, []))
    while todo:
        node = todo.pop()
        if node not in downstream and node != root:
            downstream.add(node)
            todo.extend(reverse.get(node, []))
    rows = [Row(f'{root}: {len(downstream)} downstream tickets in this capture (not an effort estimate)', 'bold')]
    stack, seen = [(root, '', '')], set()
    while stack and len(rows) < limit:
        tid, prefix, connector = stack.pop()
        ticket = by_id.get(tid)
        suffix = ' [already shown]' if tid in seen else ''
        description = f"{ticket['status']} · {owner(ticket)}" if ticket else 'not in this capture'
        rows.append(Row(prefix + connector + tid + ' — ' + description + suffix, 'cyan', ('ticket', tid)))
        if tid in seen or ticket is None:
            continue
        seen.add(tid)
        children = ticket.get('prerequisite_ticket_ids', [])
        next_prefix = prefix + ('   ' if connector == '└─ ' else '│  ' if connector else '')
        for index in range(len(children) - 1, -1, -1):
            stack.append((children[index], next_prefix, '└─ ' if index == len(children) - 1 else '├─ '))
    if stack:
        rows.append(Row(f'Tree limited to {limit} rows; select a ticket to explore its subtree.', 'yellow'))
    return rows


def structured_rows(value, prefix=''):
    """Readable complete fields; nested collections stay explicit, not discarded."""
    if isinstance(value, dict):
        for key, item in value.items():
            label = key.replace('_', ' ')
            if isinstance(item, (dict, list)):
                yield Row(prefix + label + ':', 'bold')
                yield from structured_rows(item, prefix + '  ')
            else:
                yield Row(prefix + label + ': ' + str(item))
    elif isinstance(value, list):
        if not value:
            yield Row(prefix + '(none)', 'dim')
        for item in value:
            yield Row(prefix + '•', 'dim')
            yield from structured_rows(item, prefix + '  ')
    else:
        yield Row(prefix + str(value))


def detail_rows(entity, data, warnings):
    rows = [Row(f'{entity[0].upper()} {entity[1]} — captured detail; Esc returns to the previous position', 'bold')]
    rows.extend(Row('INCOMPLETE: ' + note, 'red') for note in warnings)
    if entity[0] == 'reservation':
        rows += [Row('ADVISORY CONTENTION — no FIFO or automatic grant', 'yellow')]
        now = int(data['observed_unix_ms'])
        for item in data['items']:
            if item['kind'] == 'holder':
                lease = item['holder']['lease']
                phase = 'clock regressed' if now < int(lease['last_unix_ms']) else 'unbounded' if lease['deadline_unix_ms'] is None else 'expired (still held)' if now >= int(lease['deadline_unix_ms']) else 'active'
                rows.append(Row('HOLDER · lease ' + phase + ' · reported release note is advisory', 'yellow'))
            else:
                rows.append(Row('WAITER · ' + item['phase'] + ' · elapsed ' + str(item['elapsed_ms'] if item['elapsed_ms'] is not None else 'unknown') + 'ms', 'cyan'))
            rows += list(structured_rows(item))
        rows += list(structured_rows({key: value for key, value in data.items() if key != 'items'}))
        rows.append(Row('Reported expected release is a note, not the ownership lease. Expiry does not remove holders.', 'dim'))
        return rows
    if entity[0] == 'request':
        related = data.get('related') or {}
        question = related.get('source_message') or {}
        answer = data.get('answer') or {}
        rows += [Row(f"{data['status']['kind']} · {data.get('kind')} · resolver {data['resolver_id']}", 'magenta'),
                 Row('QUESTION (' + str(related.get('source_message_version', 'unavailable')) + ' discussion copy)', 'bold'),
                 Row(question.get('body', '[question body unavailable; inspect record details]')),
                 Row('PINNED ANSWER', 'bold'), Row(answer.get('body', '[no answer recorded]')),
                 Row('RECORD DETAILS / RELATED MESSAGES', 'bold')]
        rows += list(structured_rows(data))
        rows.append(Row('Pinned answer/status is authoritative even when related messages are absent or paged. Use request.get or request wait.', 'yellow'))
        return rows
    ticket = data['ticket']
    rows += [Row(ticket['title'], 'bold'), Row(f"{ticket['status']} · {owner(ticket)}", 'yellow'),
             Row('TASK', 'bold'), Row(ticket.get('description', '')), Row('ACCEPTANCE', 'bold'),
             Row(ticket.get('acceptance_criteria', ''))]
    for label, key in [('START REQUIREMENTS', 'start_readiness'), ('COMPLETION REQUIREMENTS', 'completion_readiness'), ('HANDOFF', 'handoff'),
                       ('INSTRUCTION AMENDMENTS', 'amendments'), ('PENDING ACKNOWLEDGEMENTS', 'pending_amendment_acknowledgements')]:
        rows.append(Row(label, 'bold'))
        rows += list(structured_rows(data.get(key)))
    rows.append(Row('NOTES / DECISIONS / EVIDENCE', 'bold'))
    for comment in data.get('all_comments', []):
        rows += [Row(f"{comment['comment_id']} · {comment.get('author_id')} · {comment.get('kind')} · {comment.get('created_at')}", 'cyan'),
                 Row(comment.get('body', '[body omitted]'))]
    rows.append(Row('LINKED RESOURCES', 'bold'))
    for resource in data.get('linked_resources', []):
        rows.append(Row(f"{resource['resource_id']} · {resource['metadata']['title']}"))
    for label, key in [('LINKED REQUESTS / THREADS', 'communication'), ('CONDITIONS', 'external_conditions'),
                       ('REVIEW / EVIDENCE', 'evidence'), ('ATTEMPTS', 'attempts'), ('RECOVERIES', 'recoveries'),
                       ('SCOPED SEMANTIC HISTORY', 'semantic_history'), ('HISTORY CAPTURE', 'history_capture'),
                       ('CONTEXT PAGING / EXPANSION', 'expand_context')]:
        rows.append(Row(label, 'bold'))
        rows += list(structured_rows(data.get(key)))
    rows.append(Row('OTHER RELATED CONTEXT (captured sections)', 'bold'))
    shown = {'ticket', 'start_readiness', 'completion_readiness', 'handoff', 'amendments', 'pending_amendment_acknowledgements',
             'communication', 'external_conditions', 'evidence', 'attempts', 'recoveries', 'semantic_history', 'history_capture',
             'expand_context', 'all_comments', 'linked_resources'}
    rows += list(structured_rows({key: value for key, value in data.items() if key not in shown}))
    rows.append(Row('CONTEXT COLLECTION BOUNDARIES', 'bold'))
    for key, value in data.items():
        if isinstance(value, dict) and any(k in value for k in ('remaining', 'next_offset')):
            rows += list(structured_rows({key: {k: v for k, v in value.items() if k != 'items'}}))
    rows.append(Row('Context collections retain their remaining/continuation fields. Resource bodies are not downloaded here.', 'dim'))
    return rows


TABS = ('Overview', 'Tasks', 'Questions', 'Agents', 'Activity', 'Reservations')


def item_positions(rows):
    """One stop per item, regardless of wrapping or metadata lines."""
    positions, occurrences, previous = [], Counter(), None
    for index, row in enumerate(rows):
        key = (row.section, row.entity) if row.entity else None
        if key is not None and key != previous:
            occurrence = occurrences[key]
            occurrences[key] += 1
            positions.append((index, (key, occurrence)))
        previous = key
    return positions


class View:
    def __init__(self, workspace, project='', run=''):
        self.workspace, self.project, self.run = workspace, project, run
        self.snapshot = self.latest = None
        self.paused = False
        self.paused_at = 0.0
        self.changes, self.pause_changes = set(), set()
        self.highlight_until = 0.0
        self.error, self.last_success = '', 0.0
        self.query, self.actor, self.mode = '', '', 'all'
        self.tab = 'Overview'
        self.positions = {}
        self.collapsed = set()
        self.hide_inactive = False
        self.selected, self.offset, self.anchor = 0, 0, None
        self.overlay, self.overlay_rows = None, []
        self.parents = []
        self.detail_key = None
        self.prompt, self.prompt_text = None, ''
        self.notice = ''

    def accept(self, snapshot):
        if self.paused:
            self.pause_changes |= changed_records(self.latest, snapshot)
        self.latest, self.last_success, self.error = snapshot, snapshot.acquired, ''
        if not self.paused:
            differences = changed_records(self.snapshot, snapshot)
            if differences:
                if time.monotonic() >= self.highlight_until:
                    self.changes.clear()
                self.changes |= differences
                self.highlight_until = time.monotonic() + 6
            self.snapshot = snapshot

    def toggle_pause(self):
        if self.paused:
            differences = set(self.pause_changes)
            self.notice = f'{len(differences)} records changed since pause'
            self.changes, self.highlight_until = differences, time.monotonic() + 6
            self.snapshot = self.latest
        else:
            self.paused_at = time.time()
            self.pause_changes.clear()
        self.paused = not self.paused

    def tickets(self):
        if not self.snapshot:
            return []
        return [t for t in self.snapshot.tickets if not self.project or t.get('project_id') == self.project]

    def matches(self, text, actor=''):
        return (not self.query or self.query.casefold() in text.casefold()) and (not self.actor or self.actor.casefold() in actor.casefold())

    def attention(self):
        """One two-line item per request or ticket needing instruction acceptance."""
        if not self.snapshot:
            return []
        snapshot = self.snapshot
        tids = {t['ticket_id'] for t in self.tickets()}
        now = self.paused_at if self.paused else time.time()
        items = []
        requests = sorted(snapshot.requests, key=lambda q: (int(q.get('priority', 0)) or 5, q.get('created', {}).get('timestamp', '')))
        for request in requests:
            thread = snapshot.threads.get(request.get('thread_id'), {})
            linked = {link['id'] for link in thread.get('links', []) if link['kind'] == 'ticket'}
            scope = thread.get('scope', {})
            in_project = bool(linked & tids) or (scope.get('kind') == 'project' and scope.get('id') == self.project)
            if request['status']['kind'] != 'open' or (self.project and not in_project):
                continue
            title = thread.get('title', '[title unavailable]')
            if self.matches(request['request_id'] + ' ' + title, request['resolver_id']):
                kind = 'Review requested' if request.get('kind') == 'review' else 'Waiting for an answer'
                items.append((title, f"{request['resolver_id']} · {kind} · {age(request.get('created', {}).get('timestamp'), now)} · scope {compact(scope)}",
                              ('request', request['request_id'])))
        for ticket in self.tickets():
            if not self.matches(ticket['ticket_id'] + ' ' + ticket['title'], owner(ticket)):
                continue
            pending = snapshot.checks.get(ticket['ticket_id'], {}).get('context', {}).get('pending_amendment_acknowledgements', {})
            count = len(pending.get('items', [])) + int(pending.get('remaining', 0))
            if count:
                actor = (ticket.get('claim') or {}).get('actor_id', 'Unassigned')
                items.append((ticket['title'], f'{actor} · Acknowledge updated instructions ({count})', ('ticket', ticket['ticket_id'])))
        return items

    def task_status(self, ticket):
        tid = ticket['ticket_id']
        check = self.snapshot.checks.get(tid)
        if ticket['status'] == 'done':
            return 'Complete'
        if ticket['status'] == 'canceled':
            return 'Canceled'
        if check:
            pending = check['context'].get('pending_amendment_acknowledgements', {})
            if pending.get('items') or int(pending.get('remaining', 0)):
                return 'Acknowledgement needed'
        if tid in self.snapshot.ready:
            return 'Ready to start' if self.run else 'Dependencies ready; worker checks on start'
        if ticket['status'] == 'in_progress':
            if check and not check['readiness'].get('completion', {}).get('can_complete', True):
                return 'Working · completion requirements pending'
            return 'Working'
        if check:
            reasons = check['readiness'].get('reasons', [])
            prerequisites = [r['ticket_id'] for r in reasons if r.get('kind') == 'prerequisite']
            if prerequisites:
                return 'Waiting for ' + ', '.join(prerequisites)
            return 'Not ready · Enter for requirements'
        return 'Checking requirements…'

    def rows(self):
        if self.overlay == 'status':
            return self.status_rows()
        if self.overlay:
            return self.overlay_rows
        if not self.snapshot:
            return [Row('Connecting to Workgraph…', 'dim')]
        snapshot, rows = self.snapshot, []
        tickets = [t for t in self.tickets() if self.matches(t['ticket_id'] + ' ' + t['title'], owner(t))]

        ticket_colors = {t['ticket_id']: ('green' if t['status']=='done' else 'dim' if t['status']=='canceled' else 'cyan' if t['ticket_id'] in snapshot.ready else 'yellow') for t in snapshot.tickets}
        run_colors = {r['run_id']: ('yellow' if r['status']=='running' else 'green' if r['status']=='completed' else 'red' if r['status']=='failed' else 'dim') for r in snapshot.runs}

        def section(key, title, items):
            rows.append(Row(title + ('  [collapsed — c to expand]' if key in self.collapsed else ''), 'bold', section=key))
            rows.append(Row(''))
            if key in self.collapsed:
                # A collapsed section must remain reachable by item navigation.
                rows.extend([Row('Show ' + title.lower(), 'dim', ('section', key), key), Row('')])
                return
            if not items:
                rows.extend([Row('Nothing here right now.', 'dim'), Row('')])
            for title, subtitle, entity in items:
                color = ticket_colors.get(entity[1], 'dim') if entity[0]=='ticket' else run_colors.get(entity[1], 'dim') if entity[0]=='run' else 'magenta' if entity[0]=='request' else 'dim'
                rows.extend([Row(title, '', entity, key), Row(subtitle, color, entity, key), Row('')])

        def task_item(ticket):
            actor = (ticket.get('claim') or {}).get('actor_id')
            subtitle = (actor + ' · ' if actor else '') + self.task_status(ticket)
            if self.tab == 'Tasks':
                subtitle = ticket['ticket_id'] + ' · ' + subtitle
            return ticket['title'], subtitle, ('ticket', ticket['ticket_id'])

        if self.tab == 'Overview':
            attention = self.attention()
            if attention:
                section('attention', 'NEEDS YOUR ATTENTION', attention[:3])
                if len(attention) > 3:
                    rows += [Row(f'View all {len(attention)} attention items → Questions', 'dim', ('tab', 'Questions'), 'attention'), Row('')]
            section('work', 'IN PROGRESS', [task_item(t) for t in tickets if t['status'] == 'in_progress'])
            ready = sum(t['ticket_id'] in snapshot.ready for t in tickets)
            waiting = sum(t['status'] == 'todo' and t['ticket_id'] not in snapshot.ready for t in tickets)
            rows.append(Row(f'{ready} tasks ready · {waiting} waiting → Tasks', 'dim', ('tab', 'Tasks'), 'summary'))
        elif self.tab == 'Tasks':
            groups = [('work', 'IN PROGRESS', 'active', [t for t in tickets if t['status'] == 'in_progress']),
                      ('ready', 'READY TO START' if self.run else 'DEPENDENCIES READY', 'ready', [t for t in tickets if t['ticket_id'] in snapshot.ready]),
                      ('blocked', 'WAITING', 'blocked', [t for t in tickets if t['status'] == 'todo' and t['ticket_id'] not in snapshot.ready]),
                      ('done', 'COMPLETED / CANCELED', 'done', [t for t in tickets if t['status'] in {'done','canceled'}])]
            for key, title, mode, group in groups:
                if self.mode in {'all', mode}:
                    section(key, title, [task_item(t) for t in group])
        elif self.tab == 'Questions':
            section('attention', 'QUESTIONS, REVIEWS & ACKNOWLEDGEMENTS', self.attention())
        elif self.tab == 'Agents':
            items = []
            for run in snapshot.runs:
                if self.hide_inactive and run['status'] != 'running':
                    continue
                if not self.matches(compact(run), run['actor_id']):
                    continue
                work = [t['title'] for t in snapshot.tickets if (t.get('claim') or {}).get('run_id') == run['run_id']]
                warning = next((w for w in snapshot.run_warnings if w['source'].get('run_id') == run['run_id']), None)
                observation = run_warning_text(warning) if warning else 'No stale/unobserved warning in this capture'
                items.append((run['actor_id'] + ' · ' + run['run_id'], f"Reported {run['status']} · " + (', '.join(work) if work else 'No recorded task ownership') + ' · ' + observation, ('run',run['run_id'])))
            section('runs', 'AGENTS' + (' · RUNNING REPORTS ONLY' if self.hide_inactive else ''), items)
            rows += [Row('Workspace-wide records. Reported status does not prove process liveness.', 'dim'),
                     Row('Enter for objectives, capabilities and file reservations.', 'dim')]
        elif self.tab == 'Reservations':
            items = []
            for reservation in snapshot.reservations:
                target = {'kind': 'named', 'reservation_id': reservation['reservation_id']}
                if not self.matches(compact(reservation), ' '.join(holder['actor_id'] for holder in reservation['holders'])):
                    continue
                items.append((reservation['reservation_id'], 'Named · Enter for advisory waiters and holder notes', ('reservation', compact(target))))
            for path in snapshot.paths:
                target = {'kind': 'path', 'target': path['target']}
                if not self.matches(compact(path), ' '.join(holder['actor_id'] for holder in path['holders'])):
                    continue
                label = path['target']['worktree_id'] + ':' + path['target']['path']
                items.append((label, 'Path · Enter for overlapping holders and advisory waiters', ('reservation', compact(target))))
            section('reservations', 'RESERVATIONS', items)
            rows.append(Row('Explicit unheld targets: wgx contention named NAME / contention path WORKTREE file|subtree PATH. No FIFO or automatic grant.', 'dim'))
        elif self.tab == 'Activity':
            items = []
            for event in reversed(snapshot.events):
                if self.query and self.query.casefold() not in compact(event).casefold():
                    continue
                summary = event['item']['summary']
                if event['item']['record'].get('body'):
                    summary += ': ' + event['item']['record']['body']
                if event['item']['clipped_fields']:
                    summary += ' [source excerpt]'
                identity = event['workspace_revision'] + ':' + event['change_index']
                items.append((event['category'].replace('_', ' ').capitalize() + ' · ' + summary,
                              'revision ' + identity + ' · Enter for exact source references', ('event', identity)))
            section('recent', 'SEMANTIC ACTIVITY', items)
            if self.actor:
                rows.append(Row('Worker filter does not apply: digest sources do not expose mutation actor attribution.', 'yellow'))
            rows.append(Row('Independent digest capture: ' + compact(snapshot.activity_capture) + '; unclassified bookkeeping is not semantic activity.', 'dim'))
        return rows

    def status_rows(self):
        rows = [Row('VIEW STATUS', 'heading-cyan'), Row('')]
        if not self.snapshot:
            return rows + [Row(self.error or 'No successful read yet.', 'red')]
        snapshot = self.snapshot
        active = [t for t in self.tickets() if t['status'] not in {'done','canceled'}]
        checked = sum(t['ticket_id'] in snapshot.checks for t in active)
        rows += [Row(f'Planning capture: {snapshot.revision}'), Row(f'Exact checks: {checked}/{len(active)}'),
                 Row(f'Last successful read: {age(datetime.fromtimestamp(self.last_success, timezone.utc).isoformat(), time.time())}'),
                 Row('Panels are independently captured. Checks not yet loaded are not known to be clear.'),
                 Row('Ready means graph readiness.' if not self.run else 'Worker eligibility checked for ' + self.run),
                 Row('Project: ' + (self.project or 'all') + ' · worker filter: ' + (self.actor or 'all')),
                 Row('')]
        if self.error:
            rows += [Row('CONNECTION ERROR', 'red'), Row(self.error), Row('')]
        if snapshot.warnings:
            rows += [Row('INCOMPLETE DATA', 'yellow')] + [Row(w) for w in snapshot.warnings] + [Row('')]
        rows += [Row('RUN OBSERVATION WARNINGS (advisory)', 'heading-cyan')]
        rows += [Row(run_warning_text(w), 'yellow') for w in snapshot.run_warnings]
        rows += [Row('FILE RESERVATIONS (workspace-wide)', 'heading-cyan'), Row('')]
        for path in snapshot.paths:
            rows += list(structured_rows(path)) + [Row('')]
        if not snapshot.paths:
            rows += [Row('None', 'dim'), Row('')]
        rows += [Row('STORAGE (workspace-wide)', 'heading-cyan'), Row('')]
        for meter in snapshot.metrics.get('planning_admission', []) + snapshot.metrics.get('storage_admission', []):
            used, limit = int(meter['used']), int(meter['limit'])
            percent = 100 * used / limit if limit else 0
            filled = min(20, int(percent/5))
            rows += [Row(meter['name'].replace('_', ' '), 'bold'),
                     Row(f"[{'#'*filled}{'-'*(20-filled)}] {percent:.1f}% · {used:,}/{limit:,} {meter.get('unit','')} · {meter['severity']}", 'yellow' if percent >= 80 else 'dim'), Row('')]
        return rows

    def inspect_local(self, entity):
        kind, identity = entity
        if kind == 'run':
            run = next(r for r in self.snapshot.runs if r['run_id'] == identity)
            paths = [p for p in self.snapshot.paths if any(h.get('run_id') == identity for h in p.get('holders', []))]
            rows = [Row('AGENT ' + run['actor_id'], 'bold'), Row('')]
            rows += list(structured_rows(run))
            rows += [Row(run_warning_text(w), 'yellow') for w in self.snapshot.run_warnings if w['source'].get('run_id') == identity]
            rows += [Row(''), Row('FILE RESERVATIONS', 'bold')]
            rows += list(structured_rows(paths))
        else:
            event = next(e for e in self.snapshot.events if e['workspace_revision'] + ':' + e['change_index'] == identity)
            rows = [Row('ACTIVITY · capture ' + self.snapshot.revision, 'bold'), Row('')] + list(structured_rows(event))
        self.open_overlay('detail', rows)

    def switch_tab(self, name):
        self.positions[self.tab] = (self.selected, self.offset, self.anchor)
        self.tab = name
        self.selected, self.offset, self.anchor = self.positions.get(name, (0,0,None))

    def open_overlay(self, title, rows):
        self.parents.append((self.overlay, self.overlay_rows, self.selected, self.offset, self.anchor))
        self.overlay, self.overlay_rows = title, rows
        self.selected = self.offset = 0
        self.anchor = None

    def back(self):
        self.overlay, self.overlay_rows, self.selected, self.offset, self.anchor = self.parents.pop()
        self.detail_key = None

    def layout(self, rows, capacity):
        """Anchor to a logical item and keep its screen-relative position on refresh."""
        positions = item_positions(rows)
        distance = self.selected - self.offset
        if positions:
            by_key = {key:index for index,key in positions}
            anchored = self.anchor in by_key
            self.selected = by_key.get(self.anchor, min(positions, key=lambda item: abs(item[0]-self.selected))[0])
            if anchored:
                self.offset = self.selected-distance
            self.anchor = next(key for index,key in positions if index == self.selected)
        else:
            self.selected = min(self.selected, max(0,len(rows)-1))
            self.anchor = None
        self.offset = max(0, min(self.offset, max(0,len(rows)-capacity)))
        if self.selected < self.offset:
            self.offset = self.selected
        elif self.selected >= self.offset+capacity:
            self.offset = max(0,self.selected-capacity+1)

    def show_selection(self, rows, capacity):
        if not rows or not rows[self.selected].entity:
            return
        row = rows[self.selected]
        end = self.selected
        while end+1 < len(rows) and (rows[end+1].section, rows[end+1].entity) == (row.section, row.entity):
            end += 1
        if end-self.selected+1 <= capacity and end >= self.offset+capacity:
            self.offset = end-capacity+1

    def navigate(self, key, rows, capacity):
        positions = item_positions(rows)
        stops = [index for index,_ in positions]
        if key in {'g','G'}:
            self.selected = (stops[0] if stops else 0) if key == 'g' else (stops[-1] if stops else max(0,len(rows)-1))
            self.offset = 0 if key == 'g' else max(0,len(rows)-capacity)
        elif key in {' ', 'b'}:
            direction = 1 if key == ' ' else -1
            target = max(0,min(len(rows)-1,self.selected + direction*capacity))
            self.selected = min(stops,key=lambda index:abs(index-target)) if stops else target
        elif stops:
            candidates = [i for i in stops if i > self.selected] if key == 'j' else [i for i in stops if i < self.selected]
            if candidates:
                self.selected = candidates[0] if key == 'j' else candidates[-1]
        else:
            self.selected = max(0,min(len(rows)-1,self.selected+(1 if key=='j' else -1)))
        self.anchor = next((anchor for index,anchor in positions if index == self.selected),None)
        if self.selected < self.offset:
            self.offset = self.selected
        elif self.selected >= self.offset+capacity:
            self.offset = max(0,self.selected-capacity+1)

    def header(self, width):
        state = 'Paused' if self.paused else 'Connected' if self.snapshot else 'Connecting…'
        if self.error:
            state = 'STALE / RECONNECTING'
        title = self.project or self.workspace
        if self.snapshot:
            project_ids = {t.get('project_id') for t in self.tickets()} - {None}
            project = self.project or (next(iter(project_ids)) if len(project_ids)==1 else None)
            title = self.snapshot.projects.get(project, {}).get('title') or self.snapshot.name or title
        connection = '  ● ' + state
        title_width = max(1,width-sum(cell_width(c) for c in connection))
        title = wrap(title,title_width)[0]
        rows = [Row(title + connection, 'heading-red' if self.error else 'heading-yellow' if self.paused else 'bold')]
        if self.snapshot:
            counts = Counter(t['status'] for t in self.tickets())
            total = sum(counts.values())
            filled = int(16*counts['done']/total) if total else 0
            rows.append(Row(f"{counts['done']} of {total} complete  [{'█'*filled}{'░'*(16-filled)}]", 'green'))
        rows.append(Row(''))
        question_count = len(self.attention())
        tabs = []
        for name in TABS:
            label = name + (f' ({question_count})' if name == 'Questions' and question_count else '')
            tabs.append('['+label+']' if name==self.tab else label)
        if width < 70:
            tabs = [('[' if name==self.tab else '') + str(i+1) + ':' + name[:3] + (']' if name==self.tab else '') for i,name in enumerate(TABS)]
        tab_line = (' ' if width < 70 else '   ').join(tabs)
        if width < 33:
            tab_line = '[' + self.tab + ']  Tab: next view'
        rows.extend([Row(tab_line, 'cyan'), Row('')])
        filters = []
        if self.query: filters.append('Search: ' + self.query)
        if self.actor: filters.append('Worker: ' + self.actor)
        if self.tab=='Tasks' and self.mode!='all': filters.append('Showing: ' + self.mode)
        if filters: rows.append(Row(' · '.join(filters),'dim'))
        if self.snapshot:
            active = [t for t in self.tickets() if t['status'] not in {'done','canceled'}]
            if self.snapshot.warnings:
                rows.append(Row('Some details are incomplete · i to inspect', 'yellow'))
            elif any(t['ticket_id'] not in self.snapshot.checks for t in active):
                rows.append(Row('Checking requirements… attention may be incomplete', 'dim'))
        if self.paused:
            rows.append(Row(f'{len(self.pause_changes)} records changed since pause · p to resume', 'dim'))
        if self.error:
            rows.append(Row('Showing last saved view · i for connection details', 'yellow'))
        elif self.notice:
            rows.append(Row(self.notice,'dim'))
        return rows


HELP = '''KEYS

↑ / ↓ or j / k   Select an item (wrapped lines stay together)
Tab / Shift-Tab   Next / previous view; left / right also switch views
1–6              Overview / Tasks / Questions / Agents / Activity / Reservations
Enter            Open selected item; Escape returns to the same position
Space / b        Page down / up; g / G or Home / End go to top / bottom
/                Search this view; an empty value clears the search
a                Filter by worker/resolver; an empty value clears it
f                Tasks: cycle all / active / ready / blocked / done
c                Collapse/expand the selected item's section
h                Agents: hide/show non-running reports
p                Pause/resume; changes accumulate while paused
d                Dependency tree for the selected ticket
i                View status, coverage, reservations, storage and errors
r                Refresh now; ? opens this help; q quits

Selection follows the same item across refreshes and terminal resizing.
Titles and headings stay neutral; navigation and status lines use restrained color.
Indigo: navigation/questions/changes. Green: complete. Amber: active/waiting.
Coverage warnings remain visible until checks finish or omitted data is read.
Everything is read-only: no key changes work or acknowledges a request.
Agent status is reported state, not proof that a process is alive.
Dependency counts are graph reachability, not estimates or readiness guarantees.
'''


class Worker:
    def __init__(self, client):
        self.client = client
        self.jobs, self.results = queue.Queue(), queue.Queue()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        while True:
            job = self.jobs.get()
            if job is None:
                return
            kind, args = job
            try:
                value = self.client.snapshot() if kind == 'snapshot' else self.client.detail(*args)
                self.results.put((kind, args, value, None))
            except (ReadError, OSError, ValueError, KeyError, TypeError) as error:
                self.results.put((kind, args, None, str(error)))
            except Exception as error:
                # Unexpected implementation failures stop the UI after restoring
                # its terminal, rather than leaving a permanently busy worker.
                self.results.put((kind, args, None, error))

    def close(self):
        self.client.close()
        self.jobs.put(None)
        self.thread.join(timeout=2)


def physical_rows(rows, width):
    return [Row(line, row.style, row.entity, row.section) for row in rows for line in wrap(row.text, width)]


def paint(row, color):
    if not color or row.style not in STYLES:
        return row.text
    return CANVAS + '\x1b[' + STYLES[row.style] + 'm' + row.text + '\x1b[0m' + CANVAS


def interact(client, view):
    worker = Worker(client)
    busy, next_read, failures = False, 0.0, 0
    pending_detail = None
    saved = termios.tcgetattr(sys.stdin.fileno())
    color = not os.environ.get('NO_COLOR') and os.environ.get('WGX_COLOR', 'auto') != 'never'
    quit_code = None
    keys = ''
    decoder = codecs.getincrementaldecoder('utf-8')('replace')
    escape_at = 0.0
    last_frame = None

    def terminate(signum, _frame):
        nonlocal quit_code
        quit_code = 128 + signum

    previous_term = signal.signal(signal.SIGTERM, terminate)
    previous_int = signal.signal(signal.SIGINT, terminate)
    try:
        tty.setcbreak(sys.stdin.fileno())
        sys.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?7l')
        while quit_code is None:
            now = time.monotonic()
            try:
                kind, job_args, result, error = worker.results.get_nowait()
                busy = False
                if isinstance(error, Exception):
                    raise error
                if kind == 'snapshot':
                    if error:
                        view.error = error
                        failures += 1
                    else:
                        view.accept(result)
                        failures = 0
                    next_read = now + min(30, 2 ** min(failures, 5)) if error else now + 2
                elif view.overlay == 'loading' and view.detail_key == (job_args[0], job_args[1].revision):
                    entity = job_args[0]
                    if view.overlay == 'loading':
                        view.overlay = 'detail'
                        view.overlay_rows = [Row('Detail unavailable: ' + error, 'red'), Row('Escape returns; Enter retries', 'dim', entity)] if error else [Row(('Detail planning capture ' + job_args[1].revision + '; comments/resources are independent captures') if entity[0] == 'ticket' else 'Request detail: independent current communication capture', 'dim')] + detail_rows(entity, *result)
            except queue.Empty:
                pass
            if not busy:
                if pending_detail is not None:
                    worker.jobs.put(('detail', (pending_detail, view.snapshot)))
                    pending_detail = None
                    busy = True
                elif now >= next_read:
                    worker.jobs.put(('snapshot', ()))
                    busy = True
            size = os.get_terminal_size(sys.stdout.fileno())
            height, width = max(3, size.lines), max(4, size.columns - 1)
            header = view.header(width)
            # Leave at least one body line plus footer on very small terminals.
            header = header[:max(1, min(len(header), height-2))]
            header = [Row(wrap(row.text, width)[0], row.style) for row in header]
            rows = physical_rows(view.rows(), max(1, width-2))
            capacity = max(1, height-len(header)-1)
            view.layout(rows, capacity)
            view.show_selection(rows, capacity)
            body = []
            for index in range(view.offset, min(len(rows), view.offset+capacity)):
                row = rows[index]
                changed = not view.paused and now < view.highlight_until and row.entity in view.changes
                prefix = '› ' if index == view.selected else '* ' if changed else '  '
                style = 'selected' if index == view.selected else 'changed' if changed else row.style
                body.append(Row(prefix + row.text, style))
            body += [Row('')] * (capacity-len(body))
            footer = '↑↓ Select   Enter Details   Tab Views   ? Help   q quit'
            if width < 60:
                footer = '↑↓ Select  Enter Open  Tab Views  ?  q quit'
            if view.overlay:
                footer = '↑↓ Scroll   Esc Back   ? Help   q quit'
            if view.prompt:
                footer = view.prompt + ': ' + view.prompt_text + '  [Enter apply / Esc cancel]'
            frame_rows = header + body
            frame = '\x1b[H' + ''.join(paint(row, color) + '\x1b[K\n' for row in frame_rows)
            frame += f'\x1b[{height};1H' + paint(Row(wrap(footer, width)[0], 'dim'), color) + '\x1b[K'
            if frame != last_frame:
                sys.stdout.write(frame)
                sys.stdout.flush()
                last_frame = frame
            if select.select([sys.stdin], [], [], .1)[0]:
                keys += decoder.decode(os.read(sys.stdin.fileno(), 4096))
                if keys.startswith('\x1b'):
                    escape_at = time.monotonic()
            if not keys:
                continue
            mapping = {'\x1b[A': 'k', '\x1b[B': 'j', '\x1b[5~': 'b', '\x1b[6~': ' ',
                       '\x1b[C': 'next-tab', '\x1b[D': 'prev-tab', '\x1b[Z': 'prev-tab',
                       '\x1b[H': 'g', '\x1b[F': 'G', '\x1b[1~': 'g', '\x1b[4~': 'G'}
            match = next((sequence for sequence in mapping if keys.startswith(sequence)), None)
            if match:
                key, keys = mapping[match], keys[len(match):]
            elif any(sequence.startswith(keys) for sequence in mapping) and time.monotonic()-escape_at < .15:
                continue
            else:
                key, keys = keys[0], keys[1:]
            if view.prompt:
                if match:
                    continue
                if key == '\x1b':
                    view.prompt, view.prompt_text = None, ''
                elif key in '\r\n':
                    if view.prompt == 'Search':
                        view.query = view.prompt_text
                    else:
                        view.actor = view.prompt_text
                    view.prompt, view.prompt_text = None, ''
                    view.selected = view.offset = 0
                    view.anchor = None
                elif key in {'\x7f', '\b'}:
                    view.prompt_text = view.prompt_text[:-1]
                elif key.isprintable() and len(view.prompt_text) < 256:
                    view.prompt_text += key
                continue
            selected = rows[view.selected] if rows else Row('')
            if key == 'q':
                quit_code = 0
            elif key == '\x1b' and view.overlay:
                pending_detail = None
                view.back()
            elif key == '?' and view.overlay != 'loading':
                view.open_overlay('help', [Row(line) for line in HELP.splitlines()])
            elif key == 'p':
                view.toggle_pause()
            elif key == 'r':
                next_read = 0
            elif key in {'/', 'a'} and not view.overlay:
                view.prompt = 'Search' if key == '/' else 'Worker/resolver'
                view.prompt_text = ''
            elif key in {'\t', 'next-tab', 'prev-tab', '1','2','3','4','5','6'} and not view.overlay:
                if key in '123456':
                    name = TABS[int(key)-1]
                else:
                    name = TABS[(TABS.index(view.tab) + (-1 if key == 'prev-tab' else 1)) % len(TABS)]
                view.switch_tab(name)
            elif key == 'i' and view.overlay != 'loading':
                view.open_overlay('status', [])
            elif key == 'h' and not view.overlay:
                view.switch_tab('Agents')
                view.hide_inactive = not view.hide_inactive
            elif key == 'f' and not view.overlay:
                view.switch_tab('Tasks')
                modes = ['all', 'active', 'ready', 'blocked', 'done']
                view.mode = modes[(modes.index(view.mode)+1) % len(modes)]
                view.offset = view.selected = 0
                view.anchor = None
            elif key == 'c' and not view.overlay:
                if selected.section:
                    view.collapsed.symmetric_difference_update({selected.section})
            elif key == 'd' and selected.entity and selected.entity[0] == 'ticket' and view.snapshot:
                view.open_overlay('tree', graph_rows(view.snapshot.tickets, selected.entity[1]))
            elif key in '\r\n' and selected.entity:
                if selected.entity[0] == 'section':
                    view.collapsed.symmetric_difference_update({selected.entity[1]})
                elif selected.entity[0] == 'tab':
                    view.switch_tab(selected.entity[1])
                elif selected.entity[0] in {'run', 'event'}:
                    view.inspect_local(selected.entity)
                elif selected.entity[0] in {'ticket', 'request', 'reservation'}:
                    pending_detail = selected.entity
                    view.detail_key = (selected.entity, view.snapshot.revision)
                    view.open_overlay('loading', [Row('Loading captured detail…'), Row('Escape returns without changing any records.')])
            elif key in {'j', 'k', ' ', 'b', 'g', 'G'}:
                view.navigate(key, rows, capacity)
        return quit_code
    finally:
        # Restore terminal immediately, before waiting for a cancelled read process.
        termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, saved)
        sys.stdout.write('\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l')
        sys.stdout.flush()
        signal.signal(signal.SIGTERM, previous_term)
        signal.signal(signal.SIGINT, previous_int)
        worker.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--context', required=True)
    parser.add_argument('--wg', default=os.environ.get('WG', 'workgraph'))
    parser.add_argument('-p', '--project', default='')
    parser.add_argument('--run', default='')
    parser.add_argument('--tree', metavar='TICKET')
    args = parser.parse_args()
    context = json.loads(Path(args.context).read_text())
    client = Client(args.wg, args.context, args.run or None)
    if args.tree:
        try:
            tickets, _, warnings = client.pages('ticket.list')
            for row in graph_rows(tickets, args.tree):
                print(clean(row.text))
            for warning in warnings:
                print('INCOMPLETE: ' + clean(warning), file=sys.stderr)
            return 0
        finally:
            client.close()
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        parser.error('interactive dashboard requires a terminal; use wgx status')
    return interact(client, View(context['workspace_id'], args.project, args.run))


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ReadError, OSError, ValueError) as error:
        print('wgx: ' + clean(error), file=sys.stderr)
        sys.exit(1)
