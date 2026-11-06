"""Recompute diagnostic summaries from a clipboard-contention JSON report.
No Windows dependencies. Reads evidence only; does not decide product paste behavior.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import statistics


def stats(values):
    values = list(values)
    return None if not values else {'n': len(values), 'min': round(min(values), 3),
                                    'median': round(statistics.median(values), 3),
                                    'max': round(max(values), 3)}


def anchor(result):
    return result.get('anchorQpc') or result['firstChangeQpc']


def sequence_changes(row, frequency):
    result = row['result']
    previous = result['sequenceBefore']
    changes = []
    for event in result['events']:
        current = event['sequence']
        if current is not None and current != previous:
            changes.append({**event, 'sinceAnchorMs': (event['qpc'] - anchor(result)) * 1000 / frequency,
                            'sinceCopyMs': (event['qpc'] - row['menu']['mouseUpAfterQpc']) * 1000 / frequency})
            previous = current
    return changes


def quiet_windows(row, frequency, window_ms):
    """Sequence-only quiet candidates, not ready/none conclusions.
    Query fields are not an atomic Win32 snapshot; times have sampling uncertainty.
    """
    result = row['result']
    changes = sequence_changes(row, frequency)
    # Start at menu release, including any gap before the first producer update.
    copy_qpc = row['menu']['mouseUpAfterQpc']
    events = result['events']
    end_qpc = result['originQpc'] + int(result['endMs'] * frequency / 1000)
    points = [copy_qpc] + [e['qpc'] for e in changes if e['qpc'] > copy_qpc]
    candidates = []
    for index, start in enumerate(points):
        next_change = points[index + 1] if index + 1 < len(points) else None
        end = next_change or end_qpc
        candidate = start + int(window_ms * frequency / 1000)
        if candidate > end:
            continue
        prior = [e for e in events if e['qpc'] <= candidate]
        snapshot = prior[-1] if prior else None
        candidates.append({'atCopyMs': (candidate - copy_qpc) * 1000 / frequency,
                           'laterSequenceChange': next_change is not None,
                           'producerObservedOpen': snapshot is not None and snapshot['openPid'] == row['menu']['menuPid'],
                           'openWindowObserved': snapshot['openWindow'] if snapshot else None})
    return candidates


def summarize(report):
    frequency = report['probe']['qpcFrequency']
    assert frequency > 0
    groups = defaultdict(list)
    timelines = defaultdict(list)
    excluded = []
    for row in report['tests']:
        if row['result'].get('error') or not row.get('inputVerified'):
            excluded.append({'case': row['case'], 'reason': row['result'].get('error', 'input not yet verified')})
            continue
        groups[(row['browser'], row['fixture'], row['mode'], row['delayMs'])].append(row)
        timelines[(row['browser'], row['fixture'], row['mode'])].append(row)
    rows = []
    for (browser, fixture, mode, delay), samples in sorted(groups.items()):
        direct = mode == 'direct'
        attempts = [x for t in samples for x in t['result']['openAttempts']]
        row = {'browser': browser, 'fixture': fixture, 'mode': mode, 'delayMs': delay,
               'n': len(samples), 'inputVerified': sum(bool(t.get('inputVerified')) for t in samples),
               'actualDelayFromAnchorMs': stats(t['result']['readAtMs'] - t['result'].get('anchorAtMs', t['result'].get('firstChangeMs', 0)) for t in samples),
               'readStartAfterMenuMs': stats((t['result']['readQpc'] - t['menu']['mouseUpAfterQpc']) * 1000 / frequency for t in samples),
               'explicitOpenFailureCodes': dict(Counter(str(x['win32Code']) for x in attempts if not x['ok']))}
        if direct:
            successes = [t for t in samples if t['result']['primary']['ok']]
            failures = [t for t in samples if not t['result']['primary']['ok']]
            row.update({'rawSuccess': len(successes), 'rawFailure': len(failures),
                        'validPng': sum(bool(t['result'].get('png', {}).get('ok')) for t in successes),
                        'sourceMatches': sum(bool(t.get('payloadMatchesSource')) for t in successes),
                        'bytesEqualLateReference': sum(bool(t.get('bytesMatchLateReference')) for t in successes),
                        'successReadMs': stats(t['result']['primary']['elapsedMs'] for t in successes),
                        'failureReadMs': stats(t['result']['primary']['elapsedMs'] for t in failures),
                        'rawErrorStringsDiagnosticOnly': dict(Counter(t['result']['primary']['error'] for t in failures)),
                        'textAfterFailureProbes': sum(bool(t['result'].get('textAfterFailure')) for t in failures),
                        'oldMarkerReadAfterFailure': sum(t['result'].get('textAfterFailure', {}).get('adjustmentsMarker') is True for t in failures if t['result'].get('textAfterFailure'))})
        if mode == 'open-retry':
            bounds = []
            for t in samples:
                v = t['result']
                failed = [x for x in v['openAttempts'] if not x['ok']]
                succeeded = [x for x in v['openAttempts'] if x['ok']]
                base = v.get('anchorAtMs', v['firstChangeMs'])
                bounds.append({'case': t['case'],
                               'lastFailureMs': failed[-1]['atMs'] - base if failed else None,
                               'firstSuccessMs': succeeded[0]['atMs'] - base if succeeded else None})
            row['openBoundsFromAnchorMs'] = bounds
        rows.append(row)
    timeline_rows = []
    for (browser, fixture, mode), samples in sorted(timelines.items()):
        change_lists = [sequence_changes(t, frequency) for t in samples]
        entry = {'browser': browser, 'fixture': fixture, 'mode': mode, 'n': len(samples),
                 'sequenceChangeCount': stats(len(xs) for xs in change_lists),
                 'firstSequenceChangeAfterMenuMs': stats(xs[0]['sinceCopyMs'] for xs in change_lists if xs),
                 'lastSequenceChangeAfterMenuMs': stats(xs[-1]['sinceCopyMs'] for xs in change_lists if xs),
                 'lastSequenceChangeAfterAnchorMs': stats(xs[-1]['sinceAnchorMs'] for xs in change_lists if xs)}
        entry['quietCandidates'] = {}
        for window in [100, 200, 350, 500]:
            candidates = [x for t in samples for x in quiet_windows(t, frequency, window)]
            entry['quietCandidates'][str(window)] = {'candidates': len(candidates),
                'followedByMoreChanges': sum(c['laterSequenceChange'] for c in candidates),
                'producerObservedOpen': sum(c['producerObservedOpen'] for c in candidates)}
        timeline_rows.append(entry)
    controls = []
    for control in report.get('controls', []):
        result = control['result']
        if result.get('error'):
            controls.append({'case': control['case'], 'error': result['error']})
            continue
        controls.append({'case': control['case'], 'holdMs': control.get('holdMs'),
                         'primary': result['primary'], 'openAttempts': len(result['openAttempts']),
                         'explicitOpenFailureCodes': dict(Counter(str(x['win32Code']) for x in result['openAttempts'] if not x['ok'])),
                         'firstSuccessAtMs': next((x['atMs'] - result.get('anchorAtMs', result.get('firstChangeMs', 0)) for x in result['openAttempts'] if x['ok']), None),
                         'finalOpen': result['finalOpen']})
    return {'completed': report.get('completed', False), 'dispatchAnchor': report.get('dispatchAnchor', False),
            'browserSamples': len(report['tests']), 'controlSamples': len(report.get('controls', [])),
            'excludedSamples': excluded,
            'groups': rows, 'timelines': timeline_rows, 'controls': controls,
            'note': 'Win32Code comes only from explicit OpenClipboard calls, not parsed error text. Quiet candidates are sequence-only observations, never none/ready decisions. Timelines are sampled, not atomic.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    args = parser.parse_args()
    data = args.report.read_bytes()
    report = json.loads(data.decode('utf-8-sig'))
    value = summarize(report)
    value['inputSha256'] = hashlib.sha256(data).hexdigest()
    print(json.dumps(value, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
