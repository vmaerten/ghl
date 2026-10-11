"""Exercise archive corruption and unsafe shapes before extraction/execution."""
import hashlib
from pathlib import Path
import tempfile
import unittest
import zipfile

from release import APP, EXECUTABLE, FILES, extract_bundle, verify_checksums


class ReleaseGuards(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / 'bundle.zip'

    def bundle(self, extra=None, missing=None, link=False, executable=True):
        with zipfile.ZipFile(self.archive, 'w') as zipped:
            for name in sorted(FILES - {missing}):
                info = zipfile.ZipInfo(name)
                info.create_system = 3
                info.external_attr = (0o100755 if name == EXECUTABLE and executable else 0o100644) << 16
                if name == EXECUTABLE and link:
                    info.external_attr = 0o120777 << 16
                zipped.writestr(info, 'fixture')
            if extra:
                zipped.writestr(extra, 'unexpected')

    def test_complete_bundle_restores_executable_mode(self):
        self.bundle()
        self.assertEqual(extract_bundle(self.archive, self.root / 'out'), self.root / 'out' / APP)
        self.assertTrue((self.root / 'out' / EXECUTABLE).stat().st_mode & 0o111)

    def test_unsafe_or_extra_members_rejected_before_extraction(self):
        for name in ['../escape', '/absolute', 'ghl Desktop.app/../escape', 'node_modules/package.json']:
            with self.subTest(name=name):
                self.bundle(extra=name)
                with self.assertRaisesRegex(ValueError, 'Unexpected'):
                    extract_bundle(self.archive, self.root / 'out')
                self.assertFalse((self.root / 'out').exists())

    def test_links_and_missing_files_are_rejected(self):
        for options, error in [({'link': True}, 'regular'), ({'missing': EXECUTABLE}, 'Incomplete'), ({'executable': False}, 'executable mode')]:
            with self.subTest(options=options):
                self.bundle(**options)
                with self.assertRaisesRegex(ValueError, error):
                    extract_bundle(self.archive, self.root / 'out')

    def test_checksums_cover_both_archives_and_reject_corruption(self):
        names = ['ghl_1.2.3_darwin_arm64.tar.gz', 'ghl-desktop_1.2.3_darwin_arm64.zip']
        lines = []
        for name in names:
            (self.root / name).write_bytes(b'candidate')
            lines.append(f'{hashlib.sha256(b"candidate").hexdigest()}  {name}')
        sums = self.root / 'checksums.txt'
        sums.write_text('\n'.join(lines) + '\n')
        self.assertEqual(verify_checksums(self.root, '1.2.3').name, names[1])
        for content, error in [(lines[0] + '\n', 'Both'), ('\n'.join(lines + [lines[0]]), 'duplicate')]:
            with self.subTest(error=error):
                sums.write_text(content)
                with self.assertRaisesRegex(ValueError, error):
                    verify_checksums(self.root, '1.2.3')
        sums.write_text('\n'.join(lines))
        (self.root / names[1]).write_bytes(b'corrupted')
        with self.assertRaisesRegex(ValueError, 'Checksum mismatch'):
            verify_checksums(self.root, '1.2.3')


if __name__ == '__main__':
    unittest.main()
