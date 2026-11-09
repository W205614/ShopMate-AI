import hashlib
import importlib.util
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location(
    "container_sources", Path(__file__).with_name("collect-container-sources.py")
)
sources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sources)


class ContainerSourceTests(unittest.TestCase):
    def test_reads_installed_package_identity_without_file_metadata(self):
        packages = sources.apk_packages(
            "P:busybox\nV:1.37.0-r31\nL:GPL-2.0-only\no:busybox\nc:abc123\n"
            "F:bin\nR:sh\n\nP:nginx\nV:1.30.6-r1\nL:BSD\no:nginx\n"
        )
        self.assertEqual(len(packages), 2)
        self.assertEqual(packages[0]["c"], "abc123")
        self.assertNotIn("F", packages[0])
        self.assertNotIn("c", packages[1])

    def test_downloads_real_http_bytes_and_rejects_unavailable_sources(self):
        payload = b"source-and-license\n" * 100000

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path != "/source.tar":
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                target = Path(directory) / "component/source.tar"
                base = f"http://127.0.0.1:{server.server_port}"
                receipt = sources.download(base + "/source.tar", target)
                self.assertEqual(target.read_bytes(), payload)
                self.assertEqual(receipt["sha256"], hashlib.sha256(payload).hexdigest())
                with self.assertRaises(HTTPError):
                    sources.download(base + "/missing", Path(directory) / "missing")
                self.assertFalse((Path(directory) / "missing").exists())
        finally:
            server.shutdown()
            server.server_close()
            worker.join()


if __name__ == "__main__":
    unittest.main()
