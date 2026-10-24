"""Artifact checks only. Requires PyYAML and PyMuPDF; does not test an app."""
from pathlib import Path
from fractions import Fraction as F
import sys, re, json, ast
import yaml, fitz

root = Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parents[1]
pack = (root/'LongBall_Mobile_Build_Pack_v0_1.md').read_text()
spec = yaml.safe_load((root/'contracts/openapi.yaml').read_text())
assert spec['openapi'].startswith('3.1.')
refs = set()
nodes = set()
def walk(x):
    if isinstance(x,(dict,list)):
        if id(x) in nodes:return
        nodes.add(id(x))
    if isinstance(x,dict):
        if '$ref' in x:refs.add(x['$ref'])
        if x.get('type')=='array':assert 'items' in x
        if 'required' in x and isinstance(x['required'],list) and 'properties' in x:
            assert set(x['required']) <= set(x['properties']), x
        for v in x.values():walk(v)
    elif isinstance(x,list):
        for v in x:walk(v)
walk(spec)
def resolve(ref):
    assert ref.startswith('#/'), ref
    node=spec
    for key in ref[2:].split('/'):
        node=node[key.replace('~1','/').replace('~0','~')]
    return node
for ref in refs:resolve(ref)
ops=[]
for path, item in spec['paths'].items():
    for method, op in item.items():
        if method not in ('get','post','put','patch','delete','head','options','trace'):continue
        assert op.get('operationId') and op.get('responses'), (path,method)
        ops.append(op['operationId'])
        params=item.get('parameters',[])+op.get('parameters',[])
        params=[resolve(p['$ref']) if '$ref' in p else p for p in params]
        expected=set(re.findall(r'\{([^}]+)\}',path))
        actual={p['name'] for p in params if p.get('in')=='path'}
        assert expected==actual,(path,expected,actual)
        assert all(p.get('required') is True for p in params if p.get('in')=='path')
        assert len({(p['name'],p['in']) for p in params})==len(params),(path,method)
assert len(set(ops))==len(ops)

for prefix, count in [('D',28),('F',28),('UI',35),('REP',7)]:
    assert all(re.search(r'\b'+prefix+f'{n:02d}'+r'\b',pack) for n in range(1,count+1)),prefix
assert 'openapi_draft.yaml' not in pack
assert 'votingCutoffAt' not in pack
assert 'Current mobile planning readiness is 60/100' in pack
assert pack.count('```')%2==0

v=json.loads((root/'contracts/fairness-vectors.json').read_text())['cases']
assert len(v)==6
a=v[0]; t=F(a['actualDurationMs']*6,8)
assert t==F(**{'numerator':a['outfieldTarget']['numeratorMs'],'denominator':8})
assert [t*F(9,10),t*F(11,10)]==a['outfieldBandMs']
assert t*8+a['keeperTargetMs']==a['expectedPlayerMs']
a=v[1];t=F(a['actualDurationMs']*6,7)
assert sum(a['plannedOutfieldMs'])+a['keeperTargetMs']==a['expectedPlayerMs']
assert all(t*F(9,10)<=p<=t*F(11,10) for p in a['plannedOutfieldMs'])
a=v[2];t=F(a['actualDurationMs']*7,9)
assert sum(a['proposedTotalMinutes'])*60000==a['expectedPlayerMs']
assert all(t*F(9,10)<=p*60000<=t*F(11,10) for p in a['proposedTotalMinutes'])
assert a['keeperRoleTargetMs']*2==a['actualDurationMs']
a=v[3];t=F(600000*6,7)+F(2400000*6,8)
assert t==F(a['originalOutfielderTarget']['numeratorMs'],a['originalOutfielderTarget']['denominator'])
assert t*7+a['lateOutfielderTargetMs']+a['keeperTargetMs']==a['expectedPlayerMs']
a=v[4];assert a['actualDurationMs']==(23*60+40+25*60)*1000
assert a['actualDurationMs']*6/8==a['outfieldTargetMs']
assert a['outfieldTargetMs']*8+a['keeperTargetMs']==a['expectedPlayerMs']
a=v[5];t=F(2400000*6,9)
assert t==a['outfieldTargetMs']
allowed=[m for m in range(0,41,5) if t*F(9,10)<=m*60000<=t*F(11,10)]
assert allowed==[25] and 9*25<240
assert sum(a['nonGridBenchSpellsMs'])==a['actualDurationMs']

tokens=json.loads((root/'contracts/design-tokens.json').read_text())
def lum(h):
    vals=[int(h[i:i+2],16)/255 for i in (1,3,5)]
    vals=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in vals]
    return sum(a*b for a,b in zip(vals,[.2126,.7152,.0722]))
def ratio(a,b):
    x,y=sorted([lum(a),lum(b)])
    return (y+.05)/(x+.05)
contrast={label:round(ratio(a,b),2) for label,a,b in [
    ('ink/white','#14251D','#FFFFFF'),('muted/white','#526459','#FFFFFF'),
    ('white/brand','#FFFFFF','#126946'),('white/pitch','#FFFFFF','#176B45'),
    ('warning','#7B4900','#FFF2D4'),('error','#A32622','#FFF0EF'),('info','#194E7A','#EDF5FC')]}
assert all(v>=4.5 for v in contrast.values())
doc=fitz.open(root/'LongBall_Mobile_Design_Booklet_v0_1.pdf')
assert len(doc)==8
assert '11:56' in doc[5].get_text() and '11:57' in doc[5].get_text()
for page in doc:
    assert page.get_text().strip()
    for block in page.get_text('blocks'):
        assert block[0]>=-1 and block[1]>=-1 and block[2]<=page.rect.width+1 and block[3]<=page.rect.height+1
ast.parse((root/'design/build_visual_booklet.py').read_text())
assert (root/'source/LongBall_Concept_Review_v0_12.docx').stat().st_size==82650

result={'status':'passed limited artifact checks','paths':len(spec['paths']),'operations':len(ops),
        'schemas':len(spec['components']['schemas']),'resolved_internal_refs':len(refs),
        'fairness_vectors':6,'visual_pages':len(doc),'contrast_ratios':contrast,
        'canonical_words':len(pack.split()),'not_run':['full OpenAPI validator','application tests','physical-device tests','deployment or release tests']}
print(json.dumps(result,indent=2))
