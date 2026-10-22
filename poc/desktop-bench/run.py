"""A small, local, visible-window comparison on macOS ARM64.

All shells display the same Go/React frontend through a measurement-only proxy.
This compares envelopes; it deliberately does not port the backend to Rust/JS
or compare optimized Wails in-process bindings. No user repository is opened.
"""
import argparse
import datetime
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import platform
import select
import signal
import statistics
import subprocess
import tempfile
import threading
import time
from urllib.parse import parse_qs, urlsplit
import uuid

from metrics import processes, responsible, sample

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
OUT = ROOT / '.task/desktop-bench'
PROBE = (HERE / 'probe.js').read_text()


def command(args, **kwargs):
    return subprocess.check_output([str(arg) for arg in args], text=True, **kwargs).strip()


def fixture(path):
    path.mkdir()
    env = {**os.environ, 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1',
           'GIT_AUTHOR_DATE': '2026-10-11T00:00:00Z', 'GIT_COMMITTER_DATE': '2026-10-11T00:00:00Z'}
    git = lambda *args: command(['git', '-C', path, *args], env=env)
    git('init', '-b', 'main')
    git('config', 'user.name', 'Desktop benchmark')
    git('config', 'user.email', 'fixture@example.invalid')
    for index in range(100):
        (path / f'file-{index:03}.ts').write_text(''.join(
            f'const item_{index}_{line} = {line}\n' for line in range(200)))
    git('add', '.')
    git('commit', '-m', 'benchmark base')
    for index in range(100):
        (path / f'file-{index:03}.ts').write_text(''.join(
            f'export const item_{index}_{line} = {line + 1}\n' for line in range(200)))
    return hashlib.sha256(subprocess.check_output(['git', '-C', path, 'diff', 'HEAD'], env=env)).hexdigest()


def backend(path, logfile):
    start = time.monotonic()
    proc = subprocess.Popen([str(ROOT / 'go/dist/ghl'), '--repo', str(path), '--base', 'HEAD',
                             '--no-daemon', '--port', '0', '--no-open', '--json'],
                            stdout=subprocess.PIPE, stderr=logfile, text=True)
    if not select.select([proc.stdout], [], [], 30)[0]:
        proc.kill()
        raise RuntimeError('Go startup timed out')
    info = json.loads(proc.stdout.readline())
    return proc, info, (time.monotonic() - start) * 1000


class Proxy(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if urlsplit(self.path).path == '/__bench/report':
            report = json.loads(body)
            self.server.events[report['phase']] = report
            self.send_response(200)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        conn = http.client.HTTPConnection('127.0.0.1', self.server.backend_port, timeout=30)
        conn.request('POST', self.path, body=body,
                     headers={'Host': f'127.0.0.1:{self.server.backend_port}',
                              'Content-Type': self.headers.get('Content-Type', 'application/json')})
        response = conn.getresponse()
        payload = response.read()
        self.send_response(response.status)
        self.send_header('Content-Type', response.getheader('Content-Type', 'application/json'))
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        conn.close()

    def do_GET(self):
        path = urlsplit(self.path)
        if path.path == '/__bench/control':
            body = json.dumps({'load': self.server.load}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
        elif path.path == '/__bench/empty':
            body = b'<!doctype html><html><head></head><body></body></html>'
            body = body.replace(b'</head>', ('<script>' + PROBE + '</script></head>').encode())
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
        else:
            conn = http.client.HTTPConnection('127.0.0.1', self.server.backend_port, timeout=30)
            conn.request('GET', self.path, headers={'Host': f'127.0.0.1:{self.server.backend_port}'})
            response = conn.getresponse()
            body = response.read()
            self.send_response(response.status)
            content_type = response.getheader('Content-Type', '')
            self.send_header('Content-Type', content_type)
            if 'text/html' in content_type:
                body = body.replace(b'</head>', ('<script>' + PROBE + '</script></head>').encode())
            conn.close()
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def wait_event(server, name, timeout=60):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if 'error' in server.events:
            raise RuntimeError(server.events['error'])
        if name in server.events:
            return server.events[name]
        time.sleep(.05)
    raise RuntimeError(f'Timed out waiting for {name}; events={server.events}')


def app_pid(app, before):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        for pid, row in processes().items():
            if pid not in before and str(app / 'Contents/MacOS') in row['command']:
                return pid
        time.sleep(.05)
    raise RuntimeError('Cannot find app process for ' + str(app))


def size(path):
    return sum(file.stat().st_size for file in path.rglob('*')
               if file.is_file() and not file.is_symlink())


def close_app(root, pids):
    # Only PIDs recorded as this benchmark application's tasks. Never close
    # an existing browser or unrelated global WebKit process.
    for pid in [root, *sorted(pids - {root})]:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass


def measure(name, app, mode, repo, expected_patch, iteration):
    run_id = uuid.uuid4().hex
    log_path = OUT / f'{name}-{mode}-{iteration}.log'
    owned = set()
    root = None
    go = None
    with log_path.open('w') as log:
        go_info = None
        go_startup = 0
        if mode == 'review':
            go, go_info, go_startup = backend(repo, log)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
        server.events, server.load = {}, False
        server.backend_port = go_info['port'] if go_info else None
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        route = f"/r/{go_info['repoId']}?base=HEAD&__bench={run_id}" if go_info else f'/__bench/empty?__bench={run_id}'
        url = f'http://127.0.0.1:{server.server_port}{route}'
        try:
            if go:
                conn = http.client.HTTPConnection('127.0.0.1', go_info['port'])
                conn.request('GET', f"/r/{go_info['repoId']}/api/diff?base=HEAD")
                payload = json.loads(conn.getresponse().read())
                conn.close()
                assert len(payload['files']) == 100
                assert payload['totals']['additions'] == payload['totals']['deletions'] == 20000
                assert hashlib.sha256(payload['patch'].encode()).hexdigest() == expected_patch
            before = set(processes())
            started = time.monotonic()
            launch = subprocess.Popen(['/usr/bin/open', '-n', '-W', '--stdout', str(log_path),
                                       '--stderr', str(log_path), '--env', 'GHL_DESKTOP_BENCH_URL=' + url,
                                       str(app), '--args', url], stdout=log, stderr=log)
            root = app_pid(app, before)
            if responsible(root) != root:
                raise RuntimeError(f'App responsibility is not isolated: PID {root}, responsible {responsible(root)}')
            ready = wait_event(server, 'ready')
            startup = (time.monotonic() - started) * 1000
            assert ready['viewport'] == [1280, 720], ready
            assert not ready['errors'], ready
            # No polling traffic during the memory/CPU idle interval.
            # The probe polls every 200ms until load; account this identical
            # instrumentation as part of all windows rather than calling it zero-CPU idle.
            time.sleep(3)
            idle_before = sample(root)
            owned |= {row['pid'] for row in idle_before['processes']}
            time.sleep(2)
            idle_after = sample(root)
            owned |= {row['pid'] for row in idle_after['processes']}
            server.load = True
            snapshots = []
            while 'loaded' not in server.events:
                if 'error' in server.events:
                    raise RuntimeError(server.events['error'])
                current = sample(root)
                owned |= {row['pid'] for row in current['processes']}
                snapshots.append(current)
                if time.monotonic() - started > 90:
                    raise RuntimeError('Load timed out')
                time.sleep(.25)
            loaded = wait_event(server, 'loaded')
            assert not loaded['errors'], loaded
            if mode == 'review':
                assert loaded['visibility'] == 'visible', loaded
                assert loaded['files_seen'] > 1 and loaded['peak_mounted'] < 20, loaded
                assert any('file-099.ts' in title for title in loaded['end_titles']), loaded
                if not any('WebContent' in row['name'] or 'Helper' in row['name'] for row in snapshots[-1]['processes']):
                    raise RuntimeError('Renderer not included in process measurement')
            after = sample(root)
            owned |= {row['pid'] for row in after['processes']}
            go_memory = sample(go.pid) if go else None
            return {'runtime': name, 'mode': mode, 'round': iteration,
                    'window_startup_ms': startup, 'go_startup_ms': go_startup,
                    'total_startup_ms': startup + go_startup, 'ready': ready, 'load': loaded,
                    'idle': idle_after, 'after_load': after,
                    'peak_footprint_mib': max([after['footprint_mib'], *[s['footprint_mib'] for s in snapshots]]),
                    'idle_cpu_percent': max(0, idle_after['cpu_seconds'] - idle_before['cpu_seconds']) / 2 * 100,
                    'load_cpu_seconds': max(0, after['cpu_seconds'] - idle_after['cpu_seconds']),
                    'go_backend': go_memory, 'bundle_mib': size(app) / 1024**2,
                    'with_go_bundle_mib': (size(app) + (ROOT / 'go/dist/ghl').stat().st_size) / 1024**2,
                    'observed_processes': sorted(owned)}
        finally:
            if root:
                close_app(root, owned)
            if go:
                go.terminate()
                go.wait(timeout=10)
            server.shutdown()
            server.server_close()
            if 'launch' in locals():
                try:
                    launch.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    launch.terminate()
            time.sleep(2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtimes', nargs='+', default=['electron', 'tauri', 'wails', 'tinyjs'])
    parser.add_argument('--rounds', type=int, default=3)
    parser.add_argument('--modes', nargs='+', default=['empty', 'review'])
    args = parser.parse_args()
    assert platform.system() == 'Darwin' and platform.machine() == 'arm64'
    build = json.loads((OUT / 'build.json').read_text())
    report = {'complete': False, 'measured_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'platform': platform.platform(), 'versions': build['versions'],
              'cpu_model': command(['/usr/sbin/sysctl', '-n', 'machdep.cpu.brand_string']),
              'memory_bytes': int(command(['/usr/sbin/sysctl', '-n', 'hw.memsize'])),
              'source_commit': command(['git', 'rev-parse', 'HEAD'], cwd=ROOT),
              'backend': json.loads(command([ROOT / 'go/dist/ghl', '--version', '--json'])),
              'scope': 'Visible release envelopes + common external Go backend; physical footprint, RSS and CPU include attributed WebKit/XPC tasks. Harness excluded.',
              'measurement': 'macOS proc_pid_rusage v0; responsibility lookup plus descendants. New processes, current OS caches, no system delta measurement.',
              'fixture': {'files': 100, 'lines_per_version_per_file': 200}, 'runs': []}
    report['fingerprints'] = {}
    for name, value in build['apps'].items():
        binaries = [file for file in (Path(value) / 'Contents/MacOS').iterdir() if file.is_file()]
        report['fingerprints'][name] = {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in binaries}
    output = OUT / 'results.json'
    output.write_text(json.dumps(report, indent=2))
    with tempfile.TemporaryDirectory(prefix='ghl-desktop-bench-') as directory:
        repo = Path(directory).resolve() / 'fixture'
        expected = fixture(repo)
        report['fixture']['patch_sha256'] = expected
        for iteration in range(1, args.rounds + 1):
            names = args.runtimes if iteration % 2 else list(reversed(args.runtimes))
            for mode in args.modes:
                for name in names:
                    print(f'Round {iteration}/{args.rounds}: {name}, {mode}', flush=True)
                    result = measure(name, Path(build['apps'][name]), mode, repo, expected, iteration)
                    report['runs'].append(result)
                    output.write_text(json.dumps(report, indent=2))
                    print(f"  footprint {result['after_load']['footprint_mib']:.1f} MiB, RSS {result['after_load']['rss_mib']:.1f} MiB, startup {result['total_startup_ms']:.0f} ms", flush=True)
    report['complete'] = True
    output.write_text(json.dumps(report, indent=2))
    print('Results:', output)


if __name__ == '__main__':
    main()
