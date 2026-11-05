"""Behavioral offline discovery checks; no daemon or runtime data is available."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile

binary=str(Path(sys.argv[1]).resolve())
with tempfile.TemporaryDirectory(prefix='workgraph-discover-') as tmp:
    def call(*args, ok=True):
        p=subprocess.run([binary,'--context',str(Path(tmp)/'missing-context'),*args],cwd=tmp,text=True,capture_output=True)
        assert (p.returncode==0)==ok,(args,p.stdout,p.stderr)
        return p
    catalog=json.loads(call('discover','--catalog').stdout)
    entries={e['name']:e for e in catalog['entries']}
    methods=json.loads(call('schema').stdout)['methods']
    assert {e['name'] for e in entries.values() if e['kind']=='method'}=={m['name'] for m in methods}
    assert len(catalog['capabilities'])==8
    for cap in catalog['capabilities']:
        assert json.loads(call('capabilities',cap['id'],'--output','json').stdout)['capabilities']==[cap]
    for group in catalog['groups']:
        text=call('help',group['id']).stdout
        assert group['summary'] in text and group['distinction'] in text
    for e in entries.values():
        if e['kind']!='method':
            text=call('help',e['name']).stdout
            assert text.strip()
    assert 'Workgraph capabilities' in call('help','administration').stdout
    for command in ('discover','capabilities'):
        assert call(command,'--help').stdout==call('help',command).stdout
    def search(query, *args):
        return json.loads(call('discover',query,*args,'--output','json').stdout)
    # Intent fixtures name an outcome rather than spelling an API operation.
    cases=[
        ('ask another agent a question', {'request.ask'}),
        ('import conversation JSONL search history exact message', {'workflow.import_history'}),
        ('write multiple tasks atomically', {'transaction.apply','transaction.preflight','workflow.plan_work'}),
        ('keep two developers from editing the same file', {'reservation.paths.acquire','reservation.paths.wait'}),
        ('I am new and need to set up Workgraph', {'init'}),
        ('save progress before losing context', {'ticket.progress','handoff.set','ticket.resume'}),
        ('avoid two agents editing the same files', {'reservation.paths.acquire','reservation.paths.wait'}),
        ('small shared configuration value', {'fact.put','fact.get'}),
        ('retrieve old conversation messages', {'history.search','history.read'}),
        ('upload a large binary file', {'resource.upload','resource.begin_upload'}),
        ('independent reviewer approval', {'review.record','review.gate','review.accept'}),
    ]
    for query,wanted in cases:
        r=search(query)
        assert wanted.intersection(e['name'] for e in r['results']), (query,r)
        assert len(r['results'])<=5
        assert len(json.dumps(r).encode())<12000
        assert all(e['next']=='workgraph help '+e['name'] for e in r['results'])
    assert search('ticket.get')['results'][0]['name']=='ticket.context'
    assert search('zzquuximpossibleoperation')['results']==[]
    assert search('ticket','--limit','1')['has_more'] is True
    assert all(e['kind']=='workflow' for e in search('question','--kind','workflow')['results'])
    for args in [[],[''],['the and'],['ticket','--limit','0'],['ticket','--limit','21'],['ticket','--kind','bogus'],['ticket','--capability','bogus'],['ticket','--limit','2','--limit','3'],['--catalog','--output','json','ticket'],['--catalog','--kind','method'],['ticket','--unknown','x']]:
        r=call('discover',*args,'--output','json',ok=False)
        assert json.loads(r.stdout)['error']['data']['kind']=='Invalid_argument'
    assert json.loads(call('capabilities','bogus','--output','json',ok=False).stdout)['error']['data']['kind']=='Not_found'
    assert list(Path(tmp).iterdir())==[], 'offline discovery created files'
print('offline catalog, group cards, helpers, recipes, intent ranking, bounds and errors passed')
