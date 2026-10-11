"""Real Wails/WebKit acceptance; temporary repos, never a personal browser."""
import argparse
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent.parent.parent
BINARY = ROOT / '.task/wails/ghl Prototype.app/Contents/MacOS/ghl-desktop'


def fixture(path, context):
    path.mkdir()
    env = {**os.environ, 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1'}
    def git(*args):
        subprocess.run(['git', '-C', str(path), *args], env=env, check=True, capture_output=True)
    git('init', '-b', 'main')
    git('config', 'user.name', 'Desktop smoke')
    git('config', 'user.email', 'fixture@example.invalid')
    file = path / ('context.txt' if context else 'other.txt')
    original = ''.join(f'line {n}\n' for n in range(1, 101)) if context else 'before\n'
    file.write_text(original)
    git('add', '.')
    git('commit', '-m', 'base')
    file.write_text(original.replace('line 10\n', 'changed 10\n').replace('line 90\n', 'changed 90\n') if context else 'after\n')


class Collector(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.events.append(data)
        self.send_response(200)
        self.send_header('Content-Length', '0')
        self.end_headers()


def wait(server, phase, start=0):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        for event in server.events[start:]:
            if event['phase'] == 'error':
                raise RuntimeError(event)
            if event['phase'] == phase:
                return event
        time.sleep(.1)
    raise RuntimeError(f'Timed out: {phase}; {server.events}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--standalone', action='store_true')
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', 0), Collector)
    server.events = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    app = None
    with tempfile.TemporaryDirectory(prefix='ghl-wails-smoke-') as directory:
        folder = Path(directory).resolve()
        first, second = folder / 'first', folder / 'second é space'
        fixture(first, True)
        fixture(second, False)
        script = folder / 'probe.js'
        script.write_text(f'window.smokeCollector = "http://127.0.0.1:{server.server_port}/";\n' + Path(__file__).with_name('native-smoke.js').read_text())
        env = {**os.environ, 'GHL_DESKTOP_PROBE': str(script)}
        binary = BINARY
        if args.standalone:
            bundle = folder / 'ghl Prototype.app'
            shutil.copytree(BINARY.parents[2], bundle)
            binary = bundle / 'Contents/MacOS/ghl-desktop'
            env['PATH'] = '/usr/bin:/bin:/usr/sbin:/sbin'
            assert all(shutil.which(tool, path=env['PATH']) is None for tool in ['node', 'pnpm', 'go'])
        log_path = ROOT / '.task/wails/smoke.log'
        with log_path.open('w') as log:
            try:
                app = subprocess.Popen([str(binary), '--desktop-window', '--repo', str(first), '--base', 'HEAD'], env=env, stdout=log, stderr=log)
                initial = wait(server, 'initial')
                assert initial['pid'] == app.pid
                clipboard = subprocess.check_output(['/usr/bin/pbpaste'], text=True)
                assert clipboard == initial['clipboard']
                time.sleep(1)
                # Resolve the Unicode path relative to the second caller, not the app cwd.
                subprocess.run([str(binary), '--base', 'HEAD', '--repo', second.name], cwd=folder, env=env, stdout=log, stderr=log, check=True, timeout=10)
                selected = wait(server, 'second')
                assert selected['pid'] == app.pid and not selected['minimized'] and selected['tabs'] == 2
                checkpoint = len(server.events)
                time.sleep(.2)
                subprocess.run([str(binary), '--repo', str(second), '--base', 'HEAD'], env=env, stdout=log, stderr=log, check=True, timeout=10)
                duplicate = wait(server, 'same-tab', checkpoint)
                assert duplicate['tabs'] == 2 and duplicate['mountedReviews'] == 1
                restored = wait(server, 'restored', checkpoint)
                assert restored['pid'] == app.pid and restored['repos'] == 2 and restored['tabs'] == 1
                app.send_signal(signal.SIGTERM)
                app.wait(timeout=15)
                assert app.returncode == 0
                checkpoint = len(server.events)
                app = subprocess.Popen([str(binary), '--desktop-window', '--repo', str(first), '--base', 'HEAD'], env=env, stdout=log, stderr=log)
                restarted = wait(server, 'restored', checkpoint)
                assert restarted['pid'] == app.pid and restarted['pid'] != initial['pid']
                assert restarted['repos'] == 1
                empty = wait(server, 'empty', checkpoint)
                assert empty['tabs'] == 0 and empty['mountedReviews'] == 0 and empty['welcome']
                assert app.poll() is None
                app.send_signal(signal.SIGTERM)
                app.wait(timeout=15)
                assert app.returncode == 0
                report = {'complete': True, 'standalone': args.standalone, 'checks': ['native rendering', 'context expansion', 'UI comment create/edit/delete', 'OS Markdown clipboard', 'Viewed', 'relative Unicode path from second caller', 'same process/window reuse', 'unminimise', 'switch back', 'shutdown', 'restart persistence', 'CLI tab deduplication', 'UI close tab', 'one mounted review', 'close last tab keeps window'], 'events': server.events}
                (ROOT / '.task/wails/validation.json').write_text(json.dumps(report, indent=2))
                print(json.dumps({'complete': True, 'checks': report['checks'], 'report': '.task/wails/validation.json'}))
            finally:
                if app and app.poll() is None:
                    app.terminate()
                    try:
                        app.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        app.kill()
                        app.wait()
                server.shutdown()
                server.server_close()


if __name__ == '__main__':
    main()
