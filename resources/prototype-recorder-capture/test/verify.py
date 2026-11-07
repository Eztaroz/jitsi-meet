#!/usr/bin/env python3
"""PROTOTYPE - check what the recorder bot wrote. Throwaway code.

Usage: python3 -I verify.py <bot-output-dir>

For each WebM file: container duration as written and after a copy remux,
decode errors, video resolutions over time, audio level and dominant tone.
Cross-checks file durations with timeline.json and lists staff visits.
Writes verify-report.json next to the files.
"""
import json
import os
import subprocess
import sys
from datetime import datetime

import numpy as np


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def probe_duration(path):
    out = run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path]).stdout
    d = json.loads(out or '{}').get('format', {}).get('duration')
    return float(d) if d not in (None, 'N/A') else None


def decode_errors(path):
    err = run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'null', '-']).stderr.strip()
    return [line for line in err.splitlines() if line][:5], len([line for line in err.splitlines() if line])


def video_info(path, frames_dir, name):
    out = run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
               'frame=width,height,pts_time,best_effort_timestamp_time', '-of', 'json', path]).stdout
    runs = []
    count = 0
    for fr in json.loads(out or '{}').get('frames', []):
        w, h = fr.get('width'), fr.get('height')
        ts = fr.get('pts_time') or fr.get('best_effort_timestamp_time')
        ts = float(ts) if ts not in (None, 'N/A') else None
        count += 1
        if runs and runs[-1]['size'] == f'{w}x{h}':
            runs[-1]['end'] = ts
            runs[-1]['frames'] += 1
        else:
            runs.append({'size': f'{w}x{h}', 'start': ts, 'end': ts, 'frames': 1})
    snaps = []
    for r in runs:
        if r['start'] is None or r['end'] is None:
            continue
        mid = (r['start'] + r['end']) / 2
        snap = os.path.join(frames_dir, f'{name}-{r["size"]}-{mid:.1f}s.png')
        run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{mid:.2f}', '-i', path, '-frames:v', '1', snap])
        if os.path.exists(snap):
            snaps.append(snap)
    return {'frames': count, 'resolution_runs': runs, 'snapshots': snaps}


def audio_info(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 's16le', '-ac', '1', '-ar', '48000', '-'],
                         capture_output=True).stdout
    pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float64) / 32768.0
    if pcm.size == 0:
        return {'samples': 0}
    win = 4800  # 100 ms
    n = pcm.size // win
    rms = np.sqrt(np.mean(pcm[:n * win].reshape(n, win) ** 2, axis=1)) if n else np.array([0.0])
    db = 20 * np.log10(np.maximum(rms, 1e-9))
    spec = np.abs(np.fft.rfft(pcm[: min(pcm.size, 48000 * 20)]))
    freqs = np.fft.rfftfreq(min(pcm.size, 48000 * 20), 1 / 48000)
    return {
        'decoded_seconds': round(pcm.size / 48000, 2),
        'mean_dbfs': round(float(20 * np.log10(max(np.sqrt(np.mean(pcm ** 2)), 1e-9))), 1),
        'silent_fraction': round(float(np.mean(db < -60)), 3),
        'dominant_hz': round(float(freqs[int(np.argmax(spec[1:])) + 1]), 1),
    }


def ts(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00'))


def main():
    out_dir = os.path.normpath(sys.argv[1])
    timeline = json.load(open(os.path.join(out_dir, 'timeline.json')))
    events = timeline['events']
    t0 = ts(next(e for e in events if e['type'] == 'bot_joined')['t'])
    rel = lambda e: round((ts(e['t']) - t0).total_seconds(), 2)

    remux_dir = os.path.join(out_dir, 'remuxed')
    frames_dir = os.path.join(out_dir, 'frames')
    os.makedirs(remux_dir, exist_ok=True)
    os.makedirs(frames_dir, exist_ok=True)

    files = {}
    for e in events:
        if e['type'] == 'track_recording_started':
            files[e['file']] = {'kind': e['kind'], 'displayName': e.get('displayName'),
                                'started_s': rel(e)}
        elif e['type'] == 'track_recording_stopped' and e['file'] in files:
            files[e['file']]['stopped_s'] = rel(e)
            files[e['file']]['stop_why'] = e['why']

    report = {'out_dir': out_dir, 'files': {}, 'staff_visits': [], 'stop': None}
    for name, meta in sorted(files.items()):
        path = os.path.join(out_dir, name)
        entry = dict(meta)
        entry['bytes'] = os.path.getsize(path) if os.path.exists(path) else 0
        entry['wallclock_s'] = round(meta.get('stopped_s', 0) - meta['started_s'], 2)
        entry['duration_as_written'] = probe_duration(path)
        remuxed = os.path.join(remux_dir, name)
        run(['ffmpeg', '-v', 'error', '-y', '-i', path, '-c', 'copy', remuxed])
        entry['duration_after_remux'] = probe_duration(remuxed)
        entry['decode_errors_sample'], entry['decode_error_count'] = decode_errors(path)
        if meta['kind'] == 'video':
            entry['video'] = video_info(remuxed, frames_dir, os.path.splitext(name)[0])
        else:
            entry['audio'] = audio_info(remuxed)
        report['files'][name] = entry

    open_visit = {}
    for e in events:
        if e['type'] == 'participant_joined' and e.get('displayName') == 'Staff':
            open_visit[e['id']] = rel(e)
        elif e['type'] == 'participant_left' and e['id'] in open_visit:
            report['staff_visits'].append({'id': e['id'], 'joined_s': open_visit.pop(e['id']), 'left_s': rel(e)})
    for pid, start in open_visit.items():
        report['staff_visits'].append({'id': pid, 'joined_s': start, 'left_s': None})
    stop = next((e for e in events if e['type'] == 'stopping'), None)
    empty = [e for e in events if e['type'] == 'room_empty']
    report['stop'] = {'reason': stop and stop['reason'], 'at_s': stop and rel(stop),
                      'room_empty_at_s': [rel(e) for e in empty]}

    json.dump(report, open(os.path.join(out_dir, 'verify-report.json'), 'w'), indent=2)

    print(f'# {os.path.basename(out_dir)}')
    print('| file | who | wall s | dur written | dur remuxed | decode errs | detail |')
    print('|---|---|---|---|---|---|---|')
    for name, f in report['files'].items():
        if f['kind'] == 'video':
            detail = ' -> '.join(f"{r['size']}({r['frames']}f)" for r in f['video']['resolution_runs'])
        else:
            a = f['audio']
            detail = f"{a.get('dominant_hz')} Hz, {a.get('mean_dbfs')} dBFS, silent {a.get('silent_fraction')}"
        print(f"| {name} | {f['displayName']} | {f['wallclock_s']} | {f['duration_as_written']} | "
              f"{f['duration_after_remux']} | {f['decode_error_count']} | {detail} |")
    print('staff visits:', report['staff_visits'])
    print('stop:', report['stop'])


if __name__ == '__main__':
    main()
