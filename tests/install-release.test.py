import functools
import hashlib
import http.server
import json
import os
from pathlib import Path
import ssl
import shutil
import subprocess
import tarfile
import tempfile
import threading
import unittest
import zipfile

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/install.sh'


class InstallTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.download = cls.root / 'site/download'
        cls.download.mkdir(parents=True)
        cls.key = cls.root / 'key.pem'
        cls.cert = cls.download / 'ca.crt'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(cls.key), '-out', str(cls.cert), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        der = ssl.PEM_cert_to_DER_cert(cls.cert.read_text())
        cls.fingerprint = hashlib.sha256(der).hexdigest()
        src = cls.root / 'src'
        (src / 'bin').mkdir(parents=True)
        (src / 'config').mkdir()
        cls.binary = os.environ.get('CROAK_TEST_BINARY')
        if cls.binary:
            shutil.copyfile(cls.binary, src / 'bin/croakcode')
        else:
            (src / 'bin/croakcode').write_text('#!/bin/sh\nprintf "%s\\n" "$CROAK_AUTH_URL"\n')
        if cls.binary:
            shutil.copytree(SCRIPT.parent.parent / 'upstream/.croakcode', src / 'config', dirs_exist_ok=True)
        (src / 'config/product').write_text('fixture')
        name = 'croakcode-1.0.0-linux-x64.tar.gz'
        archive = cls.download / name
        with tarfile.open(archive, 'w:gz') as t:
            t.add(src / 'bin/croakcode', arcname='bin/croakcode')
            for file in (src / 'config').rglob('*'):
                if file.is_file() and not file.is_symlink():
                    t.add(file, arcname='config/' + str(file.relative_to(src / 'config')))
        cls.content = archive.read_bytes()
        cls.archive = archive
        zip_name = 'croakcode-1.0.0-windows-x64.zip'
        with zipfile.ZipFile(cls.download / zip_name, 'w') as z:
            z.writestr('bin/croakcode.exe', 'fixture')
            z.writestr('config/product', 'fixture')
        zip_content = (cls.download / zip_name).read_bytes()
        manifest = {'product': 'croakcode', 'latest': '1.0.0', 'files': {'linux-x64': {'file': name, 'sha256': hashlib.sha256(cls.content).hexdigest(), 'size': len(cls.content)}, 'windows-x64': {'file': zip_name, 'sha256': hashlib.sha256(zip_content).hexdigest(), 'size': len(zip_content)}}}
        (cls.download / 'manifest.json').write_text(json.dumps(manifest, indent=2))
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(cls.root / 'site'))
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cls.cert, cls.key)
        cls.server.socket = ctx.wrap_socket(cls.server.socket, server_side=True)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.gate = f'https://localhost:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def setUp(self):
        self.home = Path(tempfile.mkdtemp(dir=self.root))
        self.archive.write_bytes(self.content)

    def install(self, fingerprint):
        env = dict(os.environ, HOME=str(self.home))
        env.pop('HTTPS_PROXY', None)
        env.pop('https_proxy', None)
        return subprocess.run(['bash', str(SCRIPT), '--gate', self.gate, '--ca-sha256', fingerprint], env=env, text=True, capture_output=True)

    def test_success_and_existing_config_backup(self):
        (self.home / '.croakcode').mkdir()
        (self.home / '.croakcode/old').write_text('kept')
        result = self.install(self.fingerprint)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.home / '.croakcode/product').read_text(), 'fixture')
        self.assertEqual(next(self.home.glob('.croakcode.bak-*/old')).read_text(), 'kept')
        env = dict(os.environ, HOME=str(self.home))
        args = [str(self.home / '.local/bin/croakcode')]
        if self.binary:
            args.append('--version')
        launched = subprocess.run(args, env=env, text=True, capture_output=True, check=True)
        self.assertEqual(launched.stdout.strip(), '1.0.0' if self.binary else self.gate)
        self.assertIn('croakcode PATH', (self.home / '.profile').read_text())
        if self.binary:
            models = subprocess.run([str(self.home / '.local/bin/croakcode'), '--print-logs', '--log-level', 'INFO', 'models'], cwd=self.home, env=env, text=True, capture_output=True, timeout=60)
            self.assertEqual(models.returncode, 0, models.stderr)
            self.assertNotIn('failed to load plugin', models.stderr)
            self.assertGreaterEqual(models.stderr.count('loading plugin'), 8, models.stderr)

    def test_wrong_fingerprint_stops_before_install(self):
        result = self.install('0' * 64)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('fingerprint', result.stderr)
        self.assertFalse((self.home / '.croakcode').exists())

    def test_corrupt_archive_stops_before_install(self):
        self.archive.write_bytes(b'corrupt')
        result = self.install(self.fingerprint)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('SHA-256', result.stderr)
        self.assertFalse((self.home / '.croakcode').exists())

    @unittest.skipUnless(os.environ.get('CROAK_TEST_PWSH'), 'PowerShell not supplied')
    def test_powershell_install_with_simulated_windows_environment(self):
        mock_bin = self.home / 'mock-bin'
        mock_bin.mkdir()
        (mock_bin / 'curl.exe').symlink_to('/usr/bin/curl')
        env = dict(os.environ, HOME=str(self.home), USERPROFILE=str(self.home),
                   PROCESSOR_ARCHITECTURE='AMD64', PATH=str(mock_bin) + os.pathsep + os.environ['PATH'],
                   XDG_CACHE_HOME=str(self.home / 'cache'), XDG_CONFIG_HOME=str(self.home / 'xdg-config'),
                   XDG_DATA_HOME=str(self.home / 'data'))
        env.pop('HTTPS_PROXY', None)
        script = SCRIPT.with_suffix('.ps1')
        result = subprocess.run([env['CROAK_TEST_PWSH'], '-NoProfile', '-File', str(script), '-Gate', self.gate, '-CaSha256', self.fingerprint], env=env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.home / '.croakcode/product').read_text(), 'fixture')
        self.assertTrue((self.home / '.local/bin/croakcode.cmd').is_file())


if __name__ == '__main__':
    unittest.main()
