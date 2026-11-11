"""Release update integration. Set CROAK_UPDATE_OLD and CROAK_UPDATE_NEW to compiled test binaries."""
import functools
import fcntl
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import pty
import select
import shutil
import ssl
import struct
import subprocess
import tarfile
import tempfile
import threading
import termios
import time
import unittest


@unittest.skipUnless(os.environ.get('CROAK_UPDATE_OLD') and os.environ.get('CROAK_UPDATE_NEW'), 'test binaries not supplied')
class UpdateIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        cls.download = cls.root / 'site/download'
        cls.download.mkdir(parents=True)
        cert = cls.download / 'ca.crt'
        key = cls.root / 'key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key), '-out', str(cert), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(cls.root / 'site'))
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        cls.server.socket = ctx.wrap_socket(cls.server.socket, server_side=True)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.gate = f'https://localhost:{cls.server.server_port}'
        source = cls.root / 'files'
        (source / 'bin').mkdir(parents=True)
        (source / 'config').mkdir()
        shutil.copyfile(os.environ['CROAK_UPDATE_NEW'], source / 'bin/croakcode')
        (source / 'config/product').write_text('new config')
        archive = cls.download / 'croakcode-1.1.0-linux-x64.tar.gz'
        with tarfile.open(archive, 'w:gz') as t:
            t.add(source / 'bin/croakcode', arcname='bin/croakcode')
            t.add(source / 'config/product', arcname='config/product')
        cls.size = archive.stat().st_size
        with archive.open('rb') as stream:
            cls.digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        cls.cert = cert

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.tmp.cleanup()

    def setUp(self):
        self.home = Path(tempfile.mkdtemp(dir=self.root))
        self.binary = self.home / '.local/share/croakcode/croakcode'
        self.binary.parent.mkdir(parents=True)
        shutil.copyfile(os.environ['CROAK_UPDATE_OLD'], self.binary)
        self.binary.chmod(0o755)
        (self.home / '.croakcode').mkdir()
        (self.home / '.croakcode/product').write_text('old config')
        self.env = dict(os.environ, HOME=str(self.home), CROAK_AUTH_URL=self.gate, CROAK_CA_FILE=str(self.cert))
        self.env.pop('HTTPS_PROXY', None)
        self.env.pop('https_proxy', None)
        self.cache = self.home / '.config/croak/update-cache.json'

    def manifest(self, minimum='1.0.0', digest=None):
        data = {'product': 'croakcode', 'latest': '1.1.0', 'minimum': minimum,
                'files': {'linux-x64': {'file': 'croakcode-1.1.0-linux-x64.tar.gz', 'sha256': digest or self.digest, 'size': self.size}}}
        (self.download / 'manifest.json').write_text(json.dumps(data))

    def run_cli(self, *args):
        return subprocess.run([str(self.binary), *args], cwd=self.home, env=self.env, text=True, capture_output=True, timeout=40)

    def test_cached_optional_required_and_manual_update(self):
        self.manifest()
        self.assertEqual(self.run_cli('models', '--help').returncode, 0)
        cached = json.loads(self.cache.read_text())
        self.manifest('1.1.0')
        self.assertEqual(self.run_cli('models', '--help').returncode, 0)
        self.assertEqual(json.loads(self.cache.read_text()), cached)
        cached['checkedAt'] -= 25 * 60 * 60 * 1000
        self.cache.write_text(json.dumps(cached))
        blocked = self.run_cli('models', '--help')
        self.assertNotEqual(blocked.returncode, 0)
        self.assertIn('croakcode upgrade', blocked.stderr)
        cached = json.loads(self.cache.read_text())
        cached['checkedAt'] -= 25 * 60 * 60 * 1000
        self.cache.write_text(json.dumps(cached))
        self.env['CROAK_CA_FILE'] = str(self.home / 'missing-ca.crt')
        offline = self.run_cli('models', '--help')
        self.assertNotEqual(offline.returncode, 0)
        self.assertIn('croakcode upgrade', offline.stderr)
        self.env['CROAK_CA_FILE'] = str(self.cert)
        self.manifest('1.1.0', '0' * 64)
        rejected = self.run_cli('upgrade')
        self.assertNotEqual(rejected.returncode, 0)
        self.assertEqual(self.run_cli('--version').stdout.strip(), '1.0.0')
        self.assertEqual((self.home / '.croakcode/product').read_text(), 'old config')
        self.manifest('1.1.0')
        updated = self.run_cli('upgrade')
        self.assertEqual(updated.returncode, 0, updated.stderr)
        self.assertEqual(self.run_cli('--version').stdout.strip(), '1.1.0')
        self.assertEqual((self.home / '.croakcode/product').read_text(), 'new config')
        self.assertEqual(next(self.home.glob('.croakcode.update-backup-*/product')).read_text(), 'old config')

    def confirm(self, answer):
        self.manifest('1.1.0')
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
        process = subprocess.Popen([str(self.binary), 'models', '--help'], cwd=self.home, env=self.env, stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        output = b''
        sent = False
        deadline = time.monotonic() + 45
        try:
            while process.poll() is None and time.monotonic() < deadline:
                ready, _, _ = select.select([master], [], [], 0.5)
                if ready:
                    try:
                        output += os.read(master, 65536)
                    except OSError:
                        break
                if not sent and '업데이트할까요?'.encode() in output:
                    os.write(master, answer)
                    sent = True
            if process.poll() is None:
                process.kill()
            code = process.wait()
        finally:
            os.close(master)
        self.assertTrue(sent, output.decode(errors='replace'))
        return code, output.decode(errors='replace')

    def test_required_update_confirmation(self):
        code, output = self.confirm(b'\r')
        self.assertEqual(code, 0, output)
        self.assertEqual(self.run_cli('--version').stdout.strip(), '1.1.0')

    def test_required_update_can_be_declined(self):
        code, output = self.confirm(b'n\r')
        self.assertNotEqual(code, 0, output)
        self.assertEqual(self.run_cli('--version').stdout.strip(), '1.0.0')
        self.assertEqual((self.home / '.croakcode/product').read_text(), 'old config')

    def test_unsafe_archive_is_rejected(self):
        archive = self.download / 'croakcode-1.1.0-linux-x64.tar.gz'
        with tarfile.open(archive, 'w:gz') as release:
            for name in ('bin/croakcode', 'config/../../escaped'):
                item = tarfile.TarInfo(name)
                item.size = 1
                release.addfile(item, io.BytesIO(b'x'))
        with archive.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        self.size = archive.stat().st_size
        self.manifest('1.1.0', digest)
        rejected = self.run_cli('upgrade')
        self.assertNotEqual(rejected.returncode, 0)
        self.assertEqual(self.run_cli('--version').stdout.strip(), '1.0.0')
        self.assertFalse((self.home.parent / 'escaped').exists())
        self.assertEqual((self.home / '.croakcode/product').read_text(), 'old config')


if __name__ == '__main__':
    unittest.main()
