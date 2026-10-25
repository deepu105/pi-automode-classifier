"""LANCET Nano behind llama.cpp's System One endpoint, for pi-automode-classifier's classifier decider.

GET /health answers 200 once the model is loaded. POST /v1/systemone takes {"state": {"command": ...},
"questions": {"risky": ...}} and answers {"answers": {"risky": {"type": "noul", "noul": <score>}}}, where the score
is LANCET's calibrated risk from 0 to 1. LANCET reads only the command, so the question text is not used, and it
answers only the one question. Scoring is LANCET's own code: LancetNano from the bundle's classify.py.

Usage: python -I server.py --model <bundle>/model [--host 127.0.0.1] [--port 8080] [--threads 4]
"""
import argparse
import json
import signal
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

MAX_BODY = 1 << 20


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", type=Path, required=True, help="the bundle's model directory")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    # classify.py sits next to the model directory in the release bundle.
    sys.path.insert(0, str(args.model.resolve().parent))
    from classify import LancetNano

    predictor = LancetNano(args.model, args.threads)
    meta = predictor.meta
    name = f"lancet-nano-{meta['version']}"

    class Handler(BaseHTTPRequestHandler):
        def reply(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def fail(self, status, message):
            self.reply(status, {"error": {"message": message}})

        def do_GET(self):
            if self.path == "/health":
                return self.reply(200, {"status": "ok", "model": name})
            self.fail(404, "not found")

        def do_POST(self):
            if self.path.rstrip("/") != "/v1/systemone":
                return self.fail(404, "not found")
            size = int(self.headers.get("Content-Length") or 0)
            if size > MAX_BODY:
                return self.fail(413, "request too large")
            try:
                request = json.loads(self.rfile.read(size))
                questions = request["questions"]
                command = request["state"]["command"]
            except (ValueError, KeyError, TypeError):
                return self.fail(400, 'expected {"state": {"command": ...}, "questions": {...}}')
            if list(questions) != ["risky"] or questions["risky"].get("type") not in ("noul", "bool"):
                return self.fail(400, "LANCET answers one yes/no question, risky; remove classifier.levels and classifier.extraQuestions")
            result = predictor.score(command, "bash")
            if result["score"] is None:
                return self.fail(400, f"LANCET gave no score: {result['reason']}")
            tokens = len(predictor.tokenizer.encode(command).ids)
            self.reply(200, {"model": name, "answers": {"risky": {"type": "noul", "noul": result["score"]}},
                             "usage": {"input_tokens": tokens, "output_tokens": 0}})

        def log_message(self, *_):
            # One line per scored command is noise in `docker logs`.
            pass

    # As PID 1 in a container, Python ignores SIGTERM without a handler, and `docker stop` waits out its timeout.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    print(f"{name} listening on {args.host}:{args.port}", flush=True)
    HTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
