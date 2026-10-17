"""Measure whole Chrome, incremental tabs and tab reuse in an isolated profile.

Uses the desktop fixture/probe. Never connects to a user's browser. Automation
flags and viewport emulation are recorded; this is not their everyday profile.
"""
import argparse
import datetime
import hashlib
import http.client
import json
from pathlib import Path
import platform
import select
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import ThreadingHTTPServer

from metrics import sample
from run import ROOT, OUT, Proxy, backend, close_app, command, fixture, wait_event


def receive(driver):
    if not select.select([driver.stdout], [], [], 70)[0]:
        raise RuntimeError('Chrome driver timed out')
    line = driver.stdout.readline()
    if not line:
        raise RuntimeError(f'Chrome driver exited: {driver.poll()}')
    value = json.loads(line)
    if 'error' in value:
        raise RuntimeError(value['error'])
    return value


def send(driver, value):
    driver.stdin.write(json.dumps(value) + '\n')
    driver.stdin.flush()
    return receive(driver)


def measure(chrome, repo, expected, profile, iteration):
    owned = set()
    root = driver = go = None
    server = ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
    server.events, server.load = {}, False
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with (OUT / f'chrome-{iteration}.log').open('w') as log:
        try:
            driver = subprocess.Popen(['node', str(Path(__file__).with_name('chrome-driver.mjs')),
                                       str(chrome), str(profile)],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=log, text=True)
            launch = receive(driver)
            root = launch['pid']
            time.sleep(5)
            blank = sample(root)
            owned |= {row['pid'] for row in blank['processes']}
            go, info, go_startup = backend(repo, log)
            server.backend_port = info['port']
            conn = http.client.HTTPConnection('127.0.0.1', info['port'])
            conn.request('GET', f"/r/{info['repoId']}/api/diff?base=HEAD")
            payload = json.loads(conn.getresponse().read())
            conn.close()
            assert len(payload['files']) == 100
            assert payload['totals']['additions'] == payload['totals']['deletions'] == 20000
            assert hashlib.sha256(payload['patch'].encode()).hexdigest() == expected
            result = {'round': iteration, 'chrome': launch, 'blank_browser': blank,
                      'go_startup_ms': go_startup, 'phases': []}
            for phase, action, pages in [('first_review', 'new', 2),
                                          ('duplicate_review', 'new', 3),
                                          ('reuse_review', 'reuse', 3)]:
                server.events, server.load = {}, False
                url = (f"http://127.0.0.1:{server.server_port}/r/{info['repoId']}"
                       f'?base=HEAD&__bench={uuid.uuid4().hex}')
                before = sample(root)
                started = time.monotonic()
                response = send(driver, {'action': action, 'url': url})
                assert response['pages'] == pages, response
                ready = wait_event(server, 'ready')
                startup = (time.monotonic() - started) * 1000
                assert ready['viewport'] == [1280, 720] and not ready['errors'], ready
                time.sleep(3)
                idle_before = sample(root)
                time.sleep(2)
                idle = sample(root)
                server.load = True
                snapshots = []
                while 'loaded' not in server.events:
                    if 'error' in server.events:
                        raise RuntimeError(server.events['error'])
                    current = sample(root)
                    owned |= {row['pid'] for row in current['processes']}
                    snapshots.append(current)
                    if time.monotonic() - started > 90:
                        raise RuntimeError('Chrome workload timed out')
                    time.sleep(.25)
                loaded = wait_event(server, 'loaded')
                assert not loaded['errors'] and loaded['visibility'] == 'visible', loaded
                assert loaded['files_seen'] > 1 and loaded['peak_mounted'] < 20, loaded
                assert any('file-099.ts' in title for title in loaded['end_titles']), loaded
                after = sample(root)
                owned |= {row['pid'] for row in after['processes']}
                assert any('Helper' in row['name'] for row in after['processes'])
                go_memory = sample(go.pid)
                value = {'phase': phase, 'pages': pages, 'tab_startup_ms': startup,
                         'before': before, 'idle': idle, 'after_load': after,
                         'go_backend': go_memory, 'ready': ready, 'load': loaded,
                         'total_with_go_mib': after['footprint_mib'] + go_memory['footprint_mib'],
                         'browser_delta_mib': after['footprint_mib'] - before['footprint_mib'],
                         'extra_over_blank_with_go_mib': after['footprint_mib'] - blank['footprint_mib'] + go_memory['footprint_mib'],
                         'peak_browser_mib': max(after['footprint_mib'], *[s['footprint_mib'] for s in snapshots]),
                         'idle_cpu_percent': max(0, idle['cpu_seconds'] - idle_before['cpu_seconds']) / 2 * 100,
                         'load_cpu_seconds': max(0, after['cpu_seconds'] - idle['cpu_seconds'])}
                result['phases'].append(value)
                print(f"  {phase}: {value['total_with_go_mib']:.1f} MiB total, "
                      f"{value['browser_delta_mib']:+.1f} MiB browser delta, {startup:.0f} ms, {pages} tabs", flush=True)
            return result
        finally:
            if driver and driver.poll() is None:
                try:
                    send(driver, {'action': 'close'})
                    driver.wait(timeout=10)
                except (RuntimeError, BrokenPipeError, subprocess.TimeoutExpired):
                    if root:
                        close_app(root, owned)
                    driver.terminate()
                    driver.wait(timeout=10)
            if go:
                go.terminate()
                go.wait(timeout=10)
            server.shutdown()
            server.server_close()
            time.sleep(2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--chrome', type=Path, required=True)
    parser.add_argument('--rounds', type=int, default=3)
    args = parser.parse_args()
    assert platform.system() == 'Darwin' and platform.machine() == 'arm64'
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'complete': False, 'measured_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'platform': platform.platform(),
              'cpu_model': command(['/usr/sbin/sysctl', '-n', 'machdep.cpu.brand_string']),
              'memory_bytes': int(command(['/usr/sbin/sysctl', '-n', 'hw.memsize'])),
              'source_commit': command(['git', 'rev-parse', 'HEAD'], cwd=ROOT),
              'backend_sha256': hashlib.sha256((ROOT / 'go/dist/ghl').read_bytes()).hexdigest(),
              'chrome_sha256': hashlib.sha256(args.chrome.read_bytes()).hexdigest(),
              'scope': 'Visible isolated Chrome for Testing, fresh profile per round; blank tab retained, first and duplicate review tab, then reuse second tab. Whole browser family footprint and Go measured separately. No personal browser, extensions or daily workload. Harness and WindowServer excluded.',
              'measurement': 'Same proc_pid_rusage/Mach conversion and review probe as desktop envelopes; descendant Chrome helpers. Puppeteer default flags, 1280x720 viewport emulation in 1280x820 Chrome window. Browser-family deltas are not system-wide memory deltas.',
              'fixture': {'files': 100, 'lines_per_version_per_file': 200}, 'runs': []}
    output = OUT / 'chrome-results.json'
    output.write_text(json.dumps(report, indent=2))
    with tempfile.TemporaryDirectory(prefix='ghl-chrome-bench-') as directory:
        repo = Path(directory).resolve() / 'fixture'
        expected = fixture(repo)
        report['fixture']['patch_sha256'] = expected
        for iteration in range(1, args.rounds + 1):
            print(f'Chrome round {iteration}/{args.rounds}', flush=True)
            report['runs'].append(measure(args.chrome.resolve(), repo, expected,
                                          Path(directory) / f'profile-{iteration}', iteration))
            output.write_text(json.dumps(report, indent=2))
    report['complete'] = True
    output.write_text(json.dumps(report, indent=2))
    print('Results:', output)


if __name__ == '__main__':
    main()
