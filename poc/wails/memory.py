"""Three-pass local navigation footprint probe; no hidden review or forced GC."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import tempfile
import threading
import time

from metrics import responsible, sample
from smoke import fixture

ROOT = Path(__file__).resolve().parent.parent.parent
BINARY = ROOT / '.task/wails/ghl Prototype.app/Contents/MacOS/ghl-desktop'


class Collector(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        self.server.events.append(json.loads(body))
        self.send_response(200)
        self.send_header('Content-Length', '0')
        self.end_headers()


def wait(server, index):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if len(server.events) > index:
            event = server.events[index]
            if event['phase'] != 'ready' or event['views'] != 1:
                raise RuntimeError(event)
            return event
        time.sleep(.05)
    raise RuntimeError('Navigation probe timed out')


def main():
    report = {
        'complete': False,
        'platform': platform.platform(),
        'scope': 'macOS physical footprint: app, descendants and attributed WebKit/XPC. Three runs, two 100-line text fixtures, two modified lines per fixture; ten switches after both tabs are warmed. This is a small navigation workload, not the 40,000-line envelope benchmark or a leak proof.',
        'backend': 'in-process',
        'binary_sha256': hashlib.sha256(BINARY.read_bytes()).hexdigest(),
        'runs': [],
    }
    for iteration in range(1, 4):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Collector)
        server.events = []
        threading.Thread(target=server.serve_forever, daemon=True).start()
        pid = None
        with tempfile.TemporaryDirectory(prefix='ghl-tabs-memory-') as directory:
            folder = Path(directory).resolve()
            first, second = folder / 'a', folder / 'b'
            fixture(first, True)
            fixture(second, True)
            probe = folder / 'probe.js'
            collector = f'http://127.0.0.1:{server.server_port}/'
            probe.write_text('window.collector=' + json.dumps(collector) + ';\n' + Path(__file__).with_name('memory-probe.js').read_text())
            env = {**os.environ, 'GHL_DESKTOP_PROBE': str(probe)}

            def launch(repo):
                subprocess.run([str(BINARY), '--repo', str(repo), '--base', 'HEAD'], env=env, check=True, capture_output=True, timeout=10)

            try:
                launch(first)
                pid = wait(server, 0)['pid']
                if responsible(pid) != pid:
                    raise RuntimeError('Window attribution is not isolated')
                launch(second)
                warm = wait(server, 1)
                time.sleep(2)
                before = sample(pid)
                points = []
                for index in range(10):
                    launch(first if index % 2 == 0 else second)
                    event = wait(server, index + 2)
                    if event['tabs'] != 2:
                        raise RuntimeError('Tab duplication')
                    points.append({'event': event, 'memory': sample(pid)})
                time.sleep(2)
                after = sample(pid)
                report['runs'].append({'round': iteration, 'warm': warm, 'before': before, 'after': after, 'switches': points})
                print(iteration, round(before['footprint_mib'], 1), round(after['footprint_mib'], 1), flush=True)
            finally:
                if pid:
                    os.kill(pid, signal.SIGTERM)
                    for _ in range(100):
                        try:
                            os.kill(pid, 0)
                        except ProcessLookupError:
                            break
                        time.sleep(.1)
                server.shutdown()
                server.server_close()
    report['complete'] = True
    output = ROOT / '.task/wails/tab-memory.json'
    output.write_text(json.dumps(report, indent=2))
    print('Results:', output)


if __name__ == '__main__':
    main()
