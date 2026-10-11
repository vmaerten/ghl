"""License material and acceptance checks for the GoReleaser desktop archive."""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
APP = 'ghl Desktop.app'
ICON = f'{APP}/Contents/Resources/AppIcon.icns'
EXECUTABLE = f'{APP}/Contents/MacOS/ghl-desktop'
FILES = {
    'LICENSE',
    'THIRD_PARTY_NOTICES.txt',
    f'{APP}/Contents/Info.plist',
    EXECUTABLE,
    ICON,
    f'{APP}/Contents/_CodeSignature/CodeResources',
}
DIRECTORIES = {str(parent) for name in FILES for parent in Path(name).parents if str(parent) != '.'}


def command(*args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def linked_modules(binary):
    return [tuple(line.split()[1:3]) for line in command('go', 'version', '-m', str(binary)).splitlines() if line.split()[:1] == ['dep']]


def json_objects(text):
    decoder = json.JSONDecoder()
    while text.strip():
        text = text.lstrip()
        item, offset = decoder.raw_decode(text)
        yield item
        text = text[offset:]


def notices():
    binary = ROOT / '.task/desktop' / EXECUTABLE
    modules = {item['Path']: item for item in json_objects(command('go', 'list', '-m', '-json', 'all', cwd=ROOT / 'desktop'))}
    sections = [(ROOT / '.task/release/THIRD_PARTY_NOTICES.txt').read_text()]
    count = 0
    for path, version in sorted(linked_modules(binary)):
        if path == 'github.com/vmaerten/ghl':
            continue  # Project code is covered by the archive's LICENSE.
        module = modules[path]
        require(module['Version'] == version, f'Linked module version mismatch: {path}')
        directory = Path(module['Dir'])
        files = sorted(p for p in directory.iterdir() if p.is_file() and re.match(r'^(license|licence|copying|notice)([.-]|$)', p.name, re.I))
        require(files, f'Missing license material: {path}@{version}')
        sections.append(f'{path}@{version}\n\n' + '\n\n'.join(f'{p.name}\n\n{p.read_text().strip()}' for p in files))
        count += 1
    output = ROOT / '.task/desktop/THIRD_PARTY_NOTICES.txt'
    output.write_text(('\n\n' + '=' * 72 + '\n\n').join(sections) + '\n')
    print(f'Desktop notices: existing frontend/Go material and {count} linked Go dependencies')


def verify_checksums(dist, version):
    expected = {f'ghl_{version}_darwin_arm64.tar.gz', f'ghl-desktop_{version}_darwin_arm64.zip'}
    seen = set()
    for line in (dist / 'checksums.txt').read_text().splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  ([\w.+-]+)', line)
        require(match is not None, 'Invalid SHA-256 checksum line')
        digest, name = match.groups()
        require(name in expected and name not in seen, f'Unexpected or duplicate checksum: {name}')
        seen.add(name)
        require(hashlib.sha256((dist / name).read_bytes()).hexdigest() == digest, f'Checksum mismatch: {name}')
    require(seen == expected, 'Both CLI and desktop archives must be checksummed')
    return dist / f'ghl-desktop_{version}_darwin_arm64.zip'


def extract_bundle(archive, destination):
    """Reject unexpected members and links before writing anything outside the ZIP."""
    with zipfile.ZipFile(archive) as zipped:
        seen = set()
        for info in zipped.infolist():
            name = info.filename.rstrip('/') if info.is_dir() else info.filename
            allowed = DIRECTORIES if info.is_dir() else FILES
            require(name in allowed and info.filename not in seen, f'Unexpected or duplicate ZIP member: {info.filename}')
            seen.add(info.filename)
            mode = info.external_attr >> 16
            kind = stat.S_IFMT(mode)
            require(kind in {0, stat.S_IFDIR if info.is_dir() else stat.S_IFREG}, f'Only regular files/directories may ship: {name}')
            if name == EXECUTABLE:
                require(mode & 0o111, 'Desktop executable lost its executable mode')
        require({info.filename for info in zipped.infolist() if not info.is_dir()} == FILES, 'Incomplete desktop bundle or license material')
        for info in zipped.infolist():
            path = destination / info.filename
            if info.is_dir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                with zipped.open(info) as source, path.open('wb') as output:
                    shutil.copyfileobj(source, output)
                path.chmod(stat.S_IMODE(info.external_attr >> 16) or 0o644)
    return destination / APP


def verify(dist):
    metadata = json.loads((dist / 'metadata.json').read_text())
    require(metadata['project_name'] == 'ghl', 'Wrong release project')
    require(metadata['commit'] == command('git', 'rev-parse', 'HEAD'), 'Release must match the current commit')
    archive = verify_checksums(dist, metadata['version'])
    with tempfile.TemporaryDirectory(prefix='ghl-desktop-release-') as directory:
        folder = Path(directory)
        bundle = extract_bundle(archive, folder)
        binary = folder / EXECUTABLE
        require((folder / 'LICENSE').read_bytes() == (ROOT / 'LICENSE').read_bytes(), 'Wrong project license')
        text = (folder / 'THIRD_PARTY_NOTICES.txt').read_text()
        for marker in ['Go standard library', '@pierre/diffs@', 'react@', 'github.com/wailsapp/wails/v2@']:
            require(marker in text, f'Missing notice: {marker}')
        for path, version in linked_modules(binary):
            if path != 'github.com/vmaerten/ghl':
                require(f'{path}@{version}' in text, f'Missing linked Go notice: {path}')
        info = plistlib.loads((bundle / 'Contents/Info.plist').read_bytes())
        for key, value in {
            'CFBundleName': 'ghl Desktop', 'CFBundleIdentifier': 'dev.ghl.desktop',
            'CFBundleExecutable': 'ghl-desktop', 'CFBundleIconFile': 'AppIcon',
            'GHLReleaseVersion': metadata['version'],
            'GHLCommit': metadata['commit'], 'CFBundleShortVersionString': metadata['version'].split('-')[0],
        }.items():
            require(info.get(key) == value, f'Wrong bundle metadata: {key}')
        icon = (folder / ICON).read_bytes()
        require(icon[:4] == b'icns' and int.from_bytes(icon[4:8], 'big') == len(icon), 'Invalid macOS icon container')
        settings = command('go', 'version', '-m', str(binary))
        for setting in ['CGO_ENABLED=1', 'GOOS=darwin', 'GOARCH=arm64', '-trimpath=true', '-tags=production']:
            require(setting in settings, f'Wrong desktop build setting: {setting}')
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(bundle)], check=True)
        subprocess.run([sys.executable, str(ROOT / 'desktop/smoke.py'), '--bundle', str(bundle), '--standalone'], cwd=ROOT, check=True)
        report = json.loads((ROOT / '.task/desktop/validation.json').read_text())
        builds = [event['build'] for event in report['events'] if 'build' in event]
        require(report['complete'] and report['standalone'] and builds, 'Native release acceptance did not finish')
        commit_date = datetime.fromisoformat(command('git', 'show', '-s', '--format=%cI', metadata['commit']))
        for build in builds:
            require(build['version'] == metadata['version'] and build['commit'] == metadata['commit'], 'Native runtime has wrong release metadata')
            require(datetime.fromisoformat(build['buildDate'].replace('Z', '+00:00')) == commit_date, 'Native runtime has wrong build date')
    print(f'Desktop release verified: {archive.name} (checksums, bundle, notices, signature, standalone native UI and metadata)')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['notices', 'verify'])
    parser.add_argument('--dist', type=Path, default=ROOT / 'go/dist/release')
    args = parser.parse_args()
    if args.operation == 'notices':
        notices()
    else:
        verify(args.dist.resolve())


if __name__ == '__main__':
    main()
