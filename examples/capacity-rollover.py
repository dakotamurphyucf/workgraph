#!/usr/bin/env python3
"""Copy explicitly selected open work into a fresh workspace using current APIs.

Coordinate/stop predecessor writers first. This cooperative recipe closes the
predecessor after exporting/verifying it. It keeps all copied tickets on hold
until an operator restores current policies and chooses fresh ownership.
Every write has a private saved request; rerunning replays those exact identities.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(data):
    return hashlib.sha256(data).hexdigest()


class ApiError(RuntimeError):
    def __init__(self, problem):
        super().__init__(canonical(problem))
        self.problem = problem


class Recipe:
    def __init__(self, args):
        self.args = args
        self.directory = args.state_directory
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.requests = self.directory / 'requests'
        self.requests.mkdir(mode=0o700, exist_ok=True)
        identity = {
            'recipe': 'workgraph-selected-rollover-v1', 'actor': args.actor,
            'predecessor': args.predecessor, 'successor': args.successor,
            'successor_root': str(args.successor_root),
            'export_directory': str(args.export_directory),
            'selection': json.loads(args.selection.read_text()),
        }
        self.identity = identity
        self.selection = identity['selection']
        if not isinstance(self.selection, dict) or set(self.selection) - {'tickets', 'projects', 'milestones', 'resources', 'facts', 'handoffs'}:
            raise ValueError('selection must contain only tickets/projects/milestones/resources/facts/handoffs')
        for kind in ['tickets', 'projects', 'milestones', 'resources', 'handoffs']:
            values = self.selection.get(kind, [])
            if not isinstance(values, list) or any(not isinstance(value, str) for value in values) or len(values) != len(set(values)):
                raise ValueError('selection ' + kind + ' must be distinct IDs')
        facts = self.selection.get('facts', [])
        if not isinstance(facts, list) or any(not isinstance(fact, dict) or set(fact) != {'scope', 'key'} for fact in facts):
            raise ValueError('facts must be explicit scope/key objects')
        if len({canonical(fact) for fact in facts}) != len(facts):
            raise ValueError('selected facts must be distinct')
        intent = self.directory / 'intent.json'
        if intent.exists():
            if json.loads(intent.read_text()) != identity:
                raise ValueError('saved rollover intent differs; resume its exact original selection')
        else:
            self.save(intent, identity)
        self.run_id = digest(canonical(identity).encode())
        self.modes = {method['name']: method['mode'] for method in self.run('schema')['methods']}

    @staticmethod
    def save(path, value):
        # Sync the intent before sending its writes; API receipts are authoritative.
        temporary = path.with_suffix('.pending')
        with temporary.open('w') as stream:
            stream.write(canonical(value) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def run(self, *arguments):
        result = subprocess.run([str(self.args.binary), *map(str, arguments)], capture_output=True, text=True)
        if result.returncode:
            try:
                problem = json.loads(result.stdout)['error']['data'] if result.stdout else json.loads(result.stderr.splitlines()[-1])
            except (ValueError, IndexError):
                raise RuntimeError(result.stderr) from None
            raise ApiError(problem)
        value = json.loads(result.stdout)
        return value.get('result', value)

    def read(self, method, params):
        return self.run('call', self.args.socket, method, canonical(params))

    def write(self, step, method, params):
        request = self.requests / (step + '.json')
        if request.exists():
            return self.run('retry', self.args.socket, request)
        params = {**params, 'actor_id': self.args.actor}
        if self.modes[method] == 'mutation':
            params['mutation_id'] = 'roll-' + digest((self.run_id + ':' + step).encode())
        parameters = self.directory / (step + '-params.json')
        self.save(parameters, params)
        return self.run('request', self.args.socket, method, '--params-file', parameters, '--save-request', request)

    def successor(self, step, method, **params):
        return self.write(step, method, {'workspace_id': self.args.successor, **params})

    def entity_revision(self, kind, entity):
        if kind == 'ticket':
            return self.read('ticket.context', {'workspace_id': self.args.successor, 'ticket_id': entity, 'max_bytes': '1048576'})['data']['ticket']['revision']
        return self.read(kind + '.get', {'workspace_id': self.args.successor, kind + '_id': entity})['data']['revision']

    def publish_bytes(self, step, resource, title, filename, mime_type, data):
        final = self.requests / (step + '-publish.json')
        if final.exists():
            try:
                return self.run('retry', self.args.socket, final)
            except ApiError as error:
                if error.problem['kind'] != 'Not_found':
                    raise
        upload = 'roll-upload-' + digest((self.run_id + ':' + step).encode())[:32]
        self.successor(step + '-begin', 'upload.begin', upload_id=upload,
                       size_bytes=str(len(data)), digest=digest(data))
        for offset in range(0, len(data), 262144):
            self.successor(step + '-chunk-' + str(offset), 'upload.chunk', upload_id=upload,
                           offset=str(offset), data_base64=base64.b64encode(data[offset:offset + 262144]).decode())
        return self.successor(step + '-publish', 'resource.finish_upload', upload_id=upload,
                              resource_id=resource, expected_revision='0', title=title,
                              filename=filename, mime_type=mime_type)

    def execute(self):
        old, new = self.args.predecessor, self.args.successor
        if old == new:
            raise ValueError('successor must have a fresh workspace identity')
        job = self.write('export', 'workspace.export', {'workspace_id': old, 'destination': str(self.args.export_directory)})['data']
        job_id = job['job_id']
        deadline = time.monotonic() + 120
        while True:
            current = self.read('export.get', {'job_id': job_id})['data']
            if current['status'] == 'completed':
                break
            if current['status'] in {'failed', 'canceled', 'interrupted'} or time.monotonic() >= deadline:
                raise RuntimeError('export did not complete: ' + canonical(current))
            time.sleep(.05)
        verified = self.read('export.verify', {'directory': str(self.args.export_directory)})['data']
        manifest_bytes = (self.args.export_directory / 'manifest.json').read_bytes()
        manifest = json.loads(manifest_bytes)
        source_bytes = (self.args.export_directory / 'workspace.json').read_bytes()
        if digest(source_bytes) != manifest['files']['workspace.json']:
            raise ValueError('verified predecessor projection changed before selection')
        source = json.loads(source_bytes)
        if source['workspace_id'] != old or int(source['revision']) != int(verified['revision']):
            raise ValueError('predecessor identity/capture differs')
        tables = {kind: {row['id']: row for row in source[kind + 's']}
                  for kind in ['ticket', 'project', 'milestone', 'resource']}
        selected = {kind: set(self.selection.get(kind + 's', [])) for kind in tables}
        if not selected['ticket']:
            raise ValueError('select at least one open ticket')
        for kind, identifiers in selected.items():
            if not identifiers <= set(tables[kind]):
                raise ValueError('unknown selected ' + kind + ' IDs')
        for ticket_id in selected['ticket']:
            ticket = tables['ticket'][ticket_id]
            if ticket['archived'] or ticket['status'] in {'done', 'canceled'}:
                raise ValueError('selected tickets must be open and unarchived: ' + ticket_id)
            if ticket['project']:
                selected['project'].add(ticket['project'])
            if ticket['milestone']:
                selected['milestone'].add(ticket['milestone'])
        for milestone_id in selected['milestone']:
            selected['project'].add(tables['milestone'][milestone_id]['project'])
        mapping = {kind: {identifier: 'roll-' + kind + '-' + digest((self.run_id + ':' + kind + ':' + identifier).encode())[:24]
                          for identifier in sorted(ids)} for kind, ids in selected.items()}
        # Validate every selected immutable source before changing either workspace.
        handoffs = {row['ticket']: row for row in source['handoffs']}
        for identifier in self.selection.get('handoffs', []):
            if identifier not in mapping['ticket'] or identifier not in handoffs:
                raise ValueError('selected handoff needs a selected ticket and current handoff: ' + identifier)
        for selection in self.selection.get('facts', []):
            matches = [row for row in source['facts'] if row['scope'] == selection['scope'] and row['key'] == selection['key']]
            if not matches or max(matches, key=lambda row: int(row['revision']))['deleted']:
                raise ValueError('selected fact absent or deleted: ' + canonical(selection))
            scope = selection['scope']
            if scope['kind'] != 'workspace' and scope['id'] not in mapping.get(scope['kind'], {}):
                raise ValueError('selected fact scope is not copied: ' + canonical(selection))
        for identifier in selected['resource']:
            resource = tables['resource'][identifier]
            if resource['metadata']['archived']:
                raise ValueError('selected resources must be unarchived: ' + identifier)
            version = max(resource['versions'], key=lambda item: int(item['revision']))
            if digest((self.args.export_directory / 'resources' / (version['digest'] + '.bin')).read_bytes()) != version['digest']:
                raise ValueError('exported resource content changed: ' + identifier)
        # Closing preserves the predecessor and rejects new writes through this daemon.
        health = self.read('daemon.health', {})['data']['workspaces']
        if any(row['workspace_id'] == new for row in health) and not (self.requests / 'create-successor.json').exists():
            raise ValueError('successor identity already exists; choose a fresh workspace')
        predecessor = next(row for row in health if row['workspace_id'] == old)
        if predecessor['open']:
            observed = self.read('ticket.context', {'workspace_id': old, 'ticket_id': sorted(selected['ticket'])[0], 'max_bytes': '1048576'})['meta']['workspace_revision']
            if observed != source['revision']:
                raise ValueError('predecessor changed after export; keep writers quiesced and restart with a fresh intent/export')
        self.write('close-predecessor', 'workspace.close', {'workspace_id': old})
        predecessor = next(row for row in self.read('daemon.health', {})['data']['workspaces'] if row['workspace_id'] == old)
        if predecessor['open']:
            raise ValueError('predecessor was reopened after the saved close; quiesce and close it before resuming')
        historical = {
            'workspace_id': old, 'revision': source['revision'], 'planning_head': manifest['head'],
            'history_head': manifest['history_head'], 'export_manifest_sha256': digest(manifest_bytes),
            'export_directory': str(self.args.export_directory),
        }
        omitted = {
            'authority': ['claims', 'leases', 'runs', 'attempts', 'reservations', 'reviewer_decisions',
                          'submissions', 'satisfied_gates', 'acceptance_policies', 'receipts', 'waivers',
                          'recovery_records'],
            'history': ['prior_resource_versions', 'prior_fact_versions', 'discussion_history',
                        'sessions', 'old_handoff_audit', 'unselected_entities'],
            'metadata': ['assignees', 'custom_status_ids', 'labels'], 'graph_edges': [],
        }
        self.write('create-successor', 'workspace.create', {'workspace_id': new,
                    'name': 'Successor of ' + old, 'root': str(self.args.successor_root)})
        for project_id in sorted(selected['project']):
            project = tables['project'][project_id]
            target = mapping['project'][project_id]
            self.successor('project-' + target, 'project.create', project_id=target,
                           title=project['title'], description=project['description'])
            self.successor('project-metadata-' + target, 'project.update', project_id=target,
                           expected_revision=self.entity_revision('project', target), priority=project['priority'],
                           summary=project['summary'], acceptance_criteria=project['acceptance_criteria'])
        for milestone_id in sorted(selected['milestone']):
            milestone = tables['milestone'][milestone_id]
            target = mapping['milestone'][milestone_id]
            params = dict(milestone_id=target, project_id=mapping['project'][milestone['project']],
                          title=milestone['title'], description=milestone['description'])
            if milestone['target_date'] is not None:
                params['target_date'] = milestone['target_date']
            self.successor('milestone-' + target, 'milestone.create', **params)
        pending = set(selected['ticket'])
        while pending:
            ready = sorted(identifier for identifier in pending if tables['ticket'][identifier]['parent'] not in pending)
            if not ready:
                raise ValueError('selected parent graph contains a cycle')
            for identifier in ready:
                ticket = tables['ticket'][identifier]
                target = mapping['ticket'][identifier]
                params = dict(ticket_id=target, title=ticket['title'], description=ticket['description'])
                for source_field, parameter, kind in [('project', 'project_id', 'project'),
                                                     ('milestone', 'milestone_id', 'milestone'),
                                                     ('parent', 'parent_ticket_id', 'ticket')]:
                    if ticket[source_field] in mapping[kind]:
                        params[parameter] = mapping[kind][ticket[source_field]]
                    elif ticket[source_field]:
                        omitted['graph_edges'].append({'ticket': identifier, 'kind': source_field, 'target': ticket[source_field]})
                self.successor('ticket-' + target, 'ticket.create', **params)
                self.successor('ticket-metadata-' + target, 'ticket.metadata', ticket_id=target,
                               expected_revision=self.entity_revision('ticket', target),
                               priority=ticket['priority'], acceptance_criteria=ticket['acceptance_criteria'])
                self.successor('ticket-hold-' + target, 'ticket.hold', ticket_id=target,
                               expected_revision=self.entity_revision('ticket', target),
                               reason='Rollover context only: restore current policies, resolve omitted prerequisites, then choose fresh ownership.')
                pending.remove(identifier)
        for identifier in sorted(selected['ticket']):
            ticket = tables['ticket'][identifier]
            for dependency in ticket['prerequisites']:
                if dependency in mapping['ticket']:
                    self.successor('dependency-' + mapping['ticket'][identifier] + '-' + mapping['ticket'][dependency],
                                   'dependency.add', ticket_id=mapping['ticket'][identifier], prerequisite_id=mapping['ticket'][dependency])
                else:
                    omitted['graph_edges'].append({'ticket': identifier, 'kind': 'prerequisite', 'target': dependency})
            for related in ticket['related']:
                if related in mapping['ticket'] and identifier < related:
                    left, right = mapping['ticket'][identifier], mapping['ticket'][related]
                    self.successor('related-' + left + '-' + right, 'related.add', ticket_id=left, related_id=right,
                                   expected_revision=self.entity_revision('ticket', left),
                                   related_expected_revision=self.entity_revision('ticket', right))
                elif related not in mapping['ticket']:
                    omitted['graph_edges'].append({'ticket': identifier, 'kind': 'related', 'target': related})
        resource_pins = {}
        for identifier in sorted(selected['resource']):
            resource = tables['resource'][identifier]
            version = max(resource['versions'], key=lambda item: int(item['revision']))
            content = (self.args.export_directory / 'resources' / (version['digest'] + '.bin')).read_bytes()
            if digest(content) != version['digest']:
                raise ValueError('exported resource content changed: ' + identifier)
            target = mapping['resource'][identifier]
            result = self.publish_bytes('resource-' + target, target, resource['metadata']['title'],
                                        resource['metadata']['filename'], resource['metadata']['mime_type'], content)
            resource_pins[identifier] = {'predecessor_version': version['revision'], 'digest': version['digest'],
                                         'successor_publication': result['data']}
            self.successor('resource-metadata-' + target, 'resource.update', resource_id=target,
                           expected_revision=self.entity_revision('resource', target),
                           description=resource['metadata']['description'])
            for reference in resource['metadata']['targets']:
                kind = reference['kind']
                if kind == 'workspace':
                    rewritten = {'kind': 'workspace'}
                elif reference['id'] in mapping[kind]:
                    rewritten = {'kind': kind, 'id': mapping[kind][reference['id']]}
                else:
                    omitted['graph_edges'].append({'resource': identifier, 'kind': kind, 'target': reference['id']})
                    continue
                self.successor('resource-link-' + target + '-' + digest(canonical(rewritten).encode())[:16],
                               'resource.link', resource_id=target,
                               expected_revision=self.entity_revision('resource', target), target=rewritten)
        copied_facts = []
        for index, selection in enumerate(self.selection.get('facts', [])):
            matches = [row for row in source['facts'] if row['scope'] == selection['scope'] and row['key'] == selection['key']]
            if not matches:
                raise ValueError('selected fact not found: ' + canonical(selection))
            current = max(matches, key=lambda row: int(row['revision']))
            if current['deleted']:
                raise ValueError('selected fact is deleted: ' + canonical(selection))
            scope = dict(current['scope'])
            if scope['kind'] != 'workspace':
                scope['id'] = mapping[scope['kind']][scope['id']]
            self.successor('fact-' + str(index), 'fact.put', scope=scope, key=current['key'],
                           expected_revision='0', value=current['value'])
            copied_facts.append({'predecessor': selection, 'predecessor_revision': current['revision'],
                                 'successor_scope': scope, 'value_references': 'Literal JSON values retained; embedded IDs remain historical unless operator edits them.'})
        handoff_refs = []
        for identifier in self.selection.get('handoffs', []):
            if identifier not in mapping['ticket'] or identifier not in handoffs:
                raise ValueError('selected handoff needs a selected ticket and current handoff: ' + identifier)
            handoff = handoffs[identifier]
            target = mapping['ticket'][identifier]
            resources = [mapping['resource'][resource] for resource in handoff['resources'] if resource in mapping['resource']]
            for resource in handoff['resources']:
                if resource not in mapping['resource']:
                    omitted['graph_edges'].append({'handoff': identifier, 'kind': 'resource', 'target': resource})
            observed = self.read('ticket.context', {'workspace_id': new, 'ticket_id': target, 'max_bytes': '1048576'})['meta']['workspace_revision']
            self.successor('handoff-' + target, 'handoff.set', ticket_id=target, expected_revision='0',
                           summary=handoff['summary'], objective=handoff['objective'], completed=handoff['completed'],
                           decisions=handoff['decisions'], blockers=handoff['blockers'], next_steps=handoff['next_steps'],
                           evidence=handoff['evidence'],
                           resource_ids=resources, covers_through=observed)
            handoff_refs.append({'ticket_id': identifier, 'revision': handoff['revision'], 'covers_through': handoff['covers_through'],
                                 'treatment': 'Historical predecessor context only; exact evidence is retained and establishes no successor completion or approval.'})
        record = {'recipe': 'workgraph-selected-rollover-v1', 'predecessor': historical,
                  'successor_workspace_id': new, 'id_mapping': mapping, 'resource_pins': resource_pins,
                  'facts': copied_facts, 'handoffs': handoff_refs, 'omitted': omitted,
                  'successor_work_state': 'All selected tickets held; configure fresh policies and ownership before resuming.'}
        mapping_id = 'rollover-map-' + self.run_id[:32]
        result = self.publish_bytes('mapping', mapping_id, 'Predecessor and successor rollover mapping',
                                    'rollover-mapping.json', 'application/json', (canonical(record) + '\n').encode())
        self.save(self.directory / 'mapping.json', record)
        return {'predecessor_workspace_id': old, 'successor_workspace_id': new,
                'mapping_resource_id': mapping_id, 'mapping_publication': result['data'], 'id_mapping': mapping}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--socket', required=True)
    parser.add_argument('--actor', required=True)
    parser.add_argument('--predecessor', required=True)
    parser.add_argument('--successor', required=True)
    parser.add_argument('--successor-root', type=Path, required=True)
    parser.add_argument('--export-directory', type=Path, required=True)
    parser.add_argument('--state-directory', type=Path, required=True)
    parser.add_argument('--selection', type=Path, required=True)
    parser.add_argument('--writers-quiesced', action='store_true', required=True)
    args = parser.parse_args()
    for path in [args.binary, args.successor_root, args.export_directory, args.state_directory, args.selection]:
        if not path.is_absolute():
            parser.error('all filesystem paths must be absolute')
    print(canonical(Recipe(args).execute()))


if __name__ == '__main__':
    main()
