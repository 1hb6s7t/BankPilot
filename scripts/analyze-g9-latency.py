#!/usr/bin/env python3
"""Read-only latency summary for the frozen G8N evidence named in this report."""
import base64, json, statistics, math
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/evidence/2026-10-24-g9-latency-audit.json'

DATASETS = [
 ('v2-full', ROOT/'evals/results/g8n-known24-final-2026-10-24/2026-10-24T03-13-40-478Z-g7-semantic-live-all-production.json'),
 ('v4-full', ROOT/'evals/results/g8n-known24-v4-2026-10-24/2026-10-24T03-36-49-383Z-g7-semantic-live-all-production.json'),
 ('targeted-supplemental', ROOT/'evals/results/g8n-http-supplemental-2026-10-24/2026-10-24T03-53-55-831Z-targeted-http-supplemental.json'),
]

def dt(s): return datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()*1000
def pct(xs,p):
    if not xs: return None
    return round(sorted(xs)[min(len(xs)-1, max(0, math.ceil(len(xs)*p)-1))],1)
def summary(xs):
    return {'n':len(xs),'medianMs':round(statistics.median(xs),1) if xs else None,'p95Ms':pct(xs,.95),'minMs':round(min(xs),1) if xs else None,'maxMs':round(max(xs),1) if xs else None}
def interval_union(intervals):
    ints=sorted((a,b) for a,b in intervals if a is not None and b is not None)
    if not ints: return 0
    total=0; a,b=ints[0]
    for x,y in ints[1:]:
        if x<=b: b=max(b,y)
        else: total+=b-a; a,b=x,y
    return total+b-a

def attempts(path):
    starts={}; out=[]
    for line in Path(path).read_text().splitlines():
        x=json.loads(line)
        if x.get('type')=='attempt_start': starts[x['attemptId']]=x
        elif x.get('type')=='attempt_end':
            st=starts.get(x['attemptId'],{})
            out.append({'role':x.get('role'),'attempt':x.get('attempt'),'caseSequence':x.get('caseSequence'),
              'start':st.get('startedAtUtc') or x.get('startedAtUtc'),'end':x.get('endedAtUtc'),
              'durationMs':x.get('durationMs'),'status':x.get('status'),'httpStatus':x.get('httpStatus'),
              'errorCode':x.get('errorCode'),'inputTokens':x.get('inputTokens'),'outputTokens':x.get('outputTokens'),
              'requestStarted':x.get('requestStarted'), 'startMissing':not bool(st)})
            starts.pop(x['attemptId'],None)
    for st in starts.values():
        out.append({'role':st.get('role'),'attempt':st.get('attempt'),'caseSequence':st.get('caseSequence'),
          'start':st.get('startedAtUtc'),'end':None,'durationMs':None,'status':'unknown_open','httpStatus':None,
          'errorCode':None,'inputTokens':None,'outputTokens':None,'requestStarted':None,'startMissing':False})
    return out

def dataset(name,p):
    x=json.loads(p.read_text()); recorded=x.get('attemptJournalPath')
    journal=Path(recorded) if recorded else ROOT/'__missing__'
    if not journal.is_file():
        # supplemental path is directly recorded in its journal metadata
        rec=x.get('independentAttemptJournal')
        journal=Path(rec) if isinstance(rec,str) else Path((rec or {}).get('path','__missing__'))
        if not journal.is_absolute(): journal=ROOT/journal
    rows=attempts(journal)
    byrole=defaultdict(list); statuses=Counter(); http=Counter(); missing=Counter(); roleints=defaultdict(list)
    for a in rows:
        statuses[a['status']]+=1
        if a['httpStatus'] is not None: http[str(a['httpStatus'])]+=1
        if a['inputTokens'] is None: missing['input']+=1
        if a['outputTokens'] is None: missing['output']+=1
        if a['durationMs'] is not None: byrole[a['role']].append(a['durationMs'])
        if a['start'] and a['end']: roleints[a['role']].append((dt(a['start']),dt(a['end'])))
    role_stats={r:summary(v) for r,v in sorted(byrole.items())}
    role_union={r:round(interval_union(v),1) for r,v in roleints.items()}
    # Per-case interval union for potentially parallel domain requests; case elapsed uses result duration where available.
    case_intervals=defaultdict(list)
    for a in rows:
        if a['role'] not in ('semantic_intent','reviewer') and a['start'] and a['end']:
            case_intervals[a['caseSequence']].append((dt(a['start']),dt(a['end'])))
    cases=x.get('records',[])
    case_durs=[c.get('durationMs') for c in cases if isinstance(c.get('durationMs'),(int,float))]
    trend=[{'sequence':c.get('sequence'),'id':c.get('id'),'startedAt':c.get('startedAt'),'durationMs':c.get('durationMs'),'passed':c.get('passed')} for c in cases]
    return {'source':str(p.relative_to(ROOT)),'journal':str(journal.relative_to(ROOT)) if journal.exists() else None,
      'runStartedAt':x.get('startedAt'),'runFinishedAt':x.get('finishedAt'),'journalAttemptCount':len(rows),
      'attemptsByRole':{r:sum(a['role']==r for a in rows) for r in sorted({a['role'] for a in rows})},
      'statusCounts':dict(statuses),'httpStatusCounts':dict(http),'usageMissingCounts':dict(missing),
      'reportedInputTokens':sum(a['inputTokens'] or 0 for a in rows),'reportedOutputTokens':sum(a['outputTokens'] or 0 for a in rows),
      'reportedTokensAreIncomplete':bool(missing),'roles':role_stats,'roleObservedIntervalUnionMs':role_union,
      'domainParallelIntervalUnionByCaseMs':{str(k):round(interval_union(v),1) for k,v in case_intervals.items()},
      'caseDurationSummary':summary(case_durs),'caseTrend':trend,
      'resultLatencySummary':x.get('latency'),
      'missingStartOrEndRows':sum(not a['start'] or not a['end'] for a in rows),
      'timeFields':'attempt start startedAtUtc; attempt end endedAtUtc and durationMs; result-record case startedAt/durationMs; provider wait interpreted as attempt start-to-end duration, not pure server time.'}

def browser_report(path,label):
    x=json.loads(path.read_text()); rows=[]
    for suite in x.get('suites',[]):
      for spec in suite.get('specs',[]):
       for test in spec.get('tests',[]):
        for result in test.get('results',[]):
          scope=None
          for a in result.get('attachments',[]):
            if a.get('name')=='scope.json' and a.get('body'):
              try: scope=json.loads(base64.b64decode(a['body']))
              except Exception: pass
          calls=[]
          for c in (scope or {}).get('cloudCalls',[]):
            calls.append({k:c.get(k) for k in ('sequence','startedAt','durationMs','outcome','httpStatus')})
          rows.append({'title':spec.get('title'),'status':result.get('status'),'startTime':result.get('startTime'),'durationMs':result.get('duration'),'cloudCalls':calls,
            'scopeHasStartEnd':bool((scope or {}).get('timeDomains',{}).get('wallStart'))})
    return {'label':label,'source':str(path.relative_to(ROOT)),'reportStart':x.get('stats',{}).get('startTime'),'reportDurationMs':x.get('stats',{}).get('duration'),'counts':x.get('stats'),'tests':rows,
      'timeFields':'Playwright result startTime/duration; scope cloudCalls startedAt/durationMs/httpStatus. Browser denominator kept separate.'}

result={'datasets':[dataset(n,p) for n,p in DATASETS],
 'browserReports':[browser_report(ROOT/'docs/evidence/g8n-live-browser-2026-10-24/attempt-2/report.json','browser-attempt-2'),browser_report(ROOT/'docs/evidence/g8n-live-browser-2026-10-24/http-recovery-retest/report.json','http-recovery-retest')],
 'concurrencyInterpretation':'Temporal overlap between browser cloud calls and evaluation attempts is correlation in time only; no causal attribution.',
 'scope':'Read-only summarized observations; no credentials, URLs, headers, prompts, completions, or user identifiers.'}
# Mark interval overlap as a timestamp association only, using observed call windows.
for b in result['browserReports']:
    calls=[(dt(c['startedAt']),dt(c['startedAt'])+c['durationMs'],c['httpStatus']) for t in b['tests'] for c in t['cloudCalls'] if c.get('startedAt') and c.get('durationMs') is not None]
    for d in result['datasets']:
        journal=ROOT/d['journal'] if d['journal'] else None
        rows=attempts(journal) if journal else []
        matched=[]
        for a in rows:
            if not a.get('start') or not a.get('end'): continue
            aa,ab=dt(a['start']),dt(a['end'])
            for ca,cb,ch in calls:
                overlap=max(0,min(ab,cb)-max(aa,ca))
                if overlap>0:
                    matched.append({'role':a['role'],'caseSequence':a['caseSequence'],'status':a['status'],'httpStatus':a['httpStatus'],'overlapMs':round(overlap,1),'browserHttpStatus':ch})
        b.setdefault('evaluationIntervalOverlap',{})[d['source']]={'overlappingAttemptIntervals':len(matched),'overlapDurationSumMs':round(sum(z['overlapMs'] for z in matched),1),'pairs':matched,'interpretation':'Temporal overlap only; this cannot establish causality.'}
OUT.parent.mkdir(parents=True,exist_ok=True)
OUT.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(OUT)
