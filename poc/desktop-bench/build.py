"""Build only throwaway desktop envelopes; downloads stay inside the prototype.

Run from any directory: python3 poc/desktop-bench/build.py
The production Go binary is built separately by Task.
"""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tarfile
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
OUT = ROOT / '.task/desktop-bench'
TINY_VERSION = 'v0.50.1'


def run(args, cwd=ROOT, env=None):
    subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, check=True)


def bundle(name, executable, identifier):
    app = OUT / 'apps' / f'{name}.app'
    binary = app / 'Contents/MacOS' / executable.name
    binary.parent.mkdir(parents=True, exist_ok=True)
    if executable.resolve() != binary.resolve():
        shutil.copy2(executable, binary)
    (app / 'Contents/Info.plist').write_bytes(plistlib.dumps({
        'CFBundleExecutable': binary.name, 'CFBundleIdentifier': identifier,
        'CFBundleName': name, 'CFBundlePackageType': 'APPL',
        'CFBundleVersion': '1', 'CFBundleShortVersionString': '0.0.0',
        'NSHighResolutionCapable': True,
        'NSAppTransportSecurity': {'NSAllowsArbitraryLoads': True},
    }))
    run(['/usr/bin/codesign', '--force', '--deep', '--sign', '-', app])
    return app


def main():
    (OUT / 'apps').mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    electron = HERE / 'electron'
    run(['pnpm', '--ignore-workspace', '--dir', electron, 'install', '--frozen-lockfile', '--ignore-scripts'])
    if not (electron / 'node_modules/electron/dist/Electron.app').exists():
        run(['node', 'node_modules/electron/install.js'], cwd=electron)
    electron_app = OUT / 'apps/GHLDesktopBenchElectron.app'
    if not electron_app.exists():
        shutil.copytree(electron / 'node_modules/electron/dist/Electron.app', electron_app, symlinks=True)
    app_resources = electron_app / 'Contents/Resources/app'
    app_resources.mkdir(exist_ok=True)
    (app_resources / 'package.json').write_text(json.dumps({
        'name': 'ghl-desktop-bench-electron', 'version': '0.0.0', 'main': 'main.cjs'}))
    shutil.copy2(electron / 'main.cjs', app_resources / 'main.cjs')
    info = electron_app / 'Contents/Info.plist'
    data = plistlib.loads(info.read_bytes())
    data.update({'CFBundleIdentifier': 'dev.ghl.desktopbench.electron',
                 'CFBundleName': 'GHLDesktopBenchElectron'})
    info.write_bytes(plistlib.dumps(data))
    run(['/usr/bin/codesign', '--force', '--deep', '--sign', '-', electron_app])

    wails_binary = OUT / 'apps/GHLDesktopBenchWails.app/Contents/MacOS/bench-wails'
    wails_binary.parent.mkdir(parents=True, exist_ok=True)
    run(['go', 'build', '-tags', 'production', '-trimpath', '-ldflags', '-s -w', '-o', wails_binary, '.'],
        cwd=HERE / 'wails', env={**os.environ, 'CGO_ENABLED': '1',
                                'CGO_LDFLAGS': '-framework UniformTypeIdentifiers'})
    wails_app = bundle('GHLDesktopBenchWails', wails_binary, 'dev.ghl.desktopbench.wails')

    run(['cargo', 'build', '--release', '--locked'], cwd=HERE / 'tauri',
        env={**os.environ, 'CARGO_TARGET_DIR': str(OUT / 'cargo-target'), 'CARGO_BUILD_JOBS': '2'})
    tauri_app = bundle('GHLDesktopBenchTauri', OUT / 'cargo-target/release/ghl-desktop-bench-tauri',
                       'dev.ghl.desktopbench.tauri')

    tool = OUT / 'tools/tinyjs'
    tool.mkdir(parents=True, exist_ok=True)
    if not (tool / 'tinyjs/tinyjs').exists():
        run(['gh', 'release', 'download', TINY_VERSION, '--repo', 'tarwin/tinyjsapp',
             '--pattern', 'tinyjs-macos-arm64.tar.gz', '--pattern', 'checksums.txt', '--dir', tool])
        archive = tool / 'tinyjs-macos-arm64.tar.gz'
        expected = next(line.split()[0] for line in (tool / 'checksums.txt').read_text().splitlines()
                        if line.split()[-1].lstrip('*') == archive.name)
        assert hashlib.sha256(archive.read_bytes()).hexdigest() == expected
        with tarfile.open(archive) as tar:
            tar.extractall(tool, filter='data')
    run([tool / 'tinyjs/tinyjs', 'build'], cwd=HERE / 'tinyjs')
    tiny_app = next((HERE / 'tinyjs/dist').glob('*.app'))
    versions = {'electron': '44.7.0', 'wails': '2.16.0', 'tauri': '2.12.3', 'tinyjs': TINY_VERSION}
    apps = {'electron': str(electron_app), 'wails': str(wails_app),
            'tauri': str(tauri_app), 'tinyjs': str(tiny_app)}
    (OUT / 'build.json').write_text(json.dumps({
        'versions': versions, 'apps': apps, 'elapsed_seconds': time.monotonic() - started}, indent=2))
    print(json.dumps(apps, indent=2))


if __name__ == '__main__':
    main()
