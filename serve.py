"""python serve.py  ->  http://localhost:8765

Static files from ./web, plus POST /api/embed {"sequence": "..."}.
Set PROTVIS_MODEL=facebook/esm2_t33_650M_UR50D for the big model.
"""

import json
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import protvis

WEB = Path(__file__).parent / "web"
LOCK = threading.Lock()  # one forward pass at a time


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(WEB), **k)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            super().log_message(fmt, *args)

    def do_POST(self):
        if self.path != "/api/embed":
            return self.send_error(404)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            with LOCK:
                res = protvis.embed(body["sequence"])
            code, payload = 200, res
        except (ValueError, KeyError) as e:
            code, payload = 400, {"error": str(e)}
        except Exception as e:  # noqa: BLE001
            code, payload = 500, {"error": f"{type(e).__name__}: {e}"}
        data = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"loading {protvis.MODEL_NAME} …")
    protvis.load()
    print(f"ProtVis → http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
