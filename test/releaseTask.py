"""Task publication flow with fake external builders/validators and a fake gh.

Real archive/native verification is covered by task release:snapshot. These
fixtures exercise tag propagation, ordering and failure paths without GitHub writes.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class ReleaseTask(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ghl-release-task-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ['scripts', 'test', 'desktop', 'tools']:
            (self.root / name).mkdir()
        shutil.copyfile(ROOT / 'Taskfile.yml', self.root / 'Taskfile.yml')
        shutil.copyfile(ROOT / 'scripts/release-tag.ts', self.root / 'scripts/release-tag.ts')
        (self.root / 'package.json').write_text(json.dumps({'version': '1.2.3', 'type': 'module'}))
        (self.root / 'CHANGELOG.md').write_text('Fixture release notes\n')
        self.events = self.root / 'events.jsonl'
        self.env = {**os.environ, 'PATH': str(self.root / 'tools') + os.pathsep + os.environ['PATH'],
                    'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1',
                    'GHL_TEST_EVENTS': str(self.events)}
        self.env.pop('RELEASE_TAG', None)
        self.env.pop('TAG', None)
        self.env.pop('RELEASE_REF', None)
        self.tool('goreleaser', '''import hashlib
log('build', tag=os.environ['RELEASE_TAG'], args=sys.argv[1:])
if os.environ.get('GHL_TEST_BUILD_FAIL'): sys.exit(25)
version = os.environ['RELEASE_TAG'][1:]
folder = Path('go/dist/release')
folder.mkdir(parents=True)
metadata = {'version': version, 'tag': os.environ['RELEASE_TAG'], 'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()}
(folder / 'metadata.json').write_text(json.dumps(metadata))
sums = []
for name in [f'ghl_{version}_darwin_arm64.tar.gz', f'ghl-desktop_{version}_darwin_arm64.zip']:
    (folder / name).write_bytes(b'fixture asset')
    sums.append(hashlib.sha256(b'fixture asset').hexdigest() + '  ' + name)
(folder / 'checksums.txt').write_text('\\n'.join(sums) + '\\n')
''')
        self.tool('gh', '''log(sys.argv[2], args=sys.argv[1:])
if sys.argv[1:3] == ['release', 'create'] and os.environ.get('GHL_TEST_CREATE_FAIL'): sys.exit(26)
''')
        (self.root / 'test/goRelease.ts').write_text('''import {appendFileSync,writeFileSync} from 'node:fs'
appendFileSync(process.env.GHL_TEST_EVENTS, JSON.stringify({event:'verify-cli',tag:process.env.RELEASE_TAG})+'\\n')
if(process.env.GHL_TEST_VERIFY_FAIL) process.exit(27)
if(process.env.GHL_TEST_TAMPER) writeFileSync(`go/dist/release/ghl_${process.env.RELEASE_TAG.slice(1)}_darwin_arm64.tar.gz`,'tampered')
''')
        (self.root / 'test/releaseGuards.ts').write_text('''import {appendFileSync} from 'node:fs'
appendFileSync(process.env.GHL_TEST_EVENTS, JSON.stringify({event:'guards'})+'\\n')
''')
        (self.root / 'desktop/release.py').write_text('''import json,os
with open(os.environ['GHL_TEST_EVENTS'],'a') as f: f.write(json.dumps({'event':'verify-desktop'})+'\\n')
''')
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Release fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('add', '.')
        self.git('commit', '-qm', 'release fixture')
        self.git('tag', 'v1.2.3')

    def tool(self, name, body):
        path = self.root / 'tools' / name
        path.write_text('''#!/usr/bin/env python3
import json,os,subprocess,sys
from pathlib import Path
def log(event, **fields):
    with open(os.environ['GHL_TEST_EVENTS'],'a') as f: f.write(json.dumps({'event':event,**fields})+'\\n')
''' + body)
        path.chmod(0o755)

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, env=self.env, text=True)

    def run_release(self, *args, **env):
        result = subprocess.run(['task', 'release', *args], cwd=self.root, env={**self.env, **env}, capture_output=True, text=True, timeout=30)
        events = [json.loads(line) for line in self.events.read_text().splitlines()] if self.events.exists() else []
        return result, events

    def test_stable_release_builds_verifies_uploads_then_publishes(self):
        result, events = self.run_release()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([e['event'] for e in events], ['build', 'verify-cli', 'guards', 'verify-desktop', 'create', 'edit'])
        self.assertEqual(events[0]['tag'], 'v1.2.3')
        self.assertEqual(events[1]['tag'], 'v1.2.3')
        self.assertEqual(events[0]['args'], ['release', '--skip=publish', '--clean'])
        for flag in ['--draft', '--verify-tag', 'go/dist/release/ghl_1.2.3_darwin_arm64.tar.gz', 'go/dist/release/ghl-desktop_1.2.3_darwin_arm64.zip', 'go/dist/release/checksums.txt']:
            self.assertIn(flag, events[-2]['args'])
        self.assertIn('--draft=false', events[-1]['args'])

    def test_workflow_tag_is_propagated(self):
        result, events = self.run_release(RELEASE_TAG='v1.2.3')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events[0]['tag'], 'v1.2.3')

    def test_mismatched_tag_cannot_build_or_publish(self):
        result, events = self.run_release('TAG=v1.2.4')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events, [])

    def test_failed_build_does_not_publish(self):
        result, events = self.run_release(GHL_TEST_BUILD_FAIL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([e['event'] for e in events], ['build'])

    def test_failed_validation_does_not_publish(self):
        result, events = self.run_release(GHL_TEST_VERIFY_FAIL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([e['event'] for e in events], ['build', 'verify-cli'])

    def test_changed_asset_does_not_publish(self):
        result, events = self.run_release(GHL_TEST_TAMPER='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('create', [e['event'] for e in events])

    def test_failed_upload_does_not_publish_draft(self):
        result, events = self.run_release(GHL_TEST_CREATE_FAIL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events[-1]['event'], 'create')
        self.assertNotIn('edit', [e['event'] for e in events])

    def test_manual_prerelease_is_marked(self):
        (self.root / 'package.json').write_text(json.dumps({'version':'1.2.3-rc.1', 'type':'module'}))
        self.git('add', 'package.json')
        self.git('commit', '-qm', 'prerelease fixture')
        self.git('tag', 'v1.2.3-rc.1')
        result, events = self.run_release('TAG=v1.2.3-rc.1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--prerelease', events[-2]['args'])


if __name__ == '__main__':
    unittest.main()
