"""Local server for Lightspeed (stdlib only).

Serves the HTML pages and a small JSON API over the SQLite DB. No LLM, no
sympy at runtime -- problems and verified answers are already in the DB.

Run:  python server.py    then open http://localhost:8000/
"""

import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import db

PORT = 8000

PAGES = {
    "/": "index.html",
    "/add-problems": "add-problems.html",
    "/set": "set.html",
}


class Handler(BaseHTTPRequestHandler):
    # -- helpers ----------------------------------------------------------
    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, filename, content_type="text/html"):
        try:
            with open(filename, "rb") as f:
                body = f.read()
        except FileNotFoundError:
            self.send_error(404, "Not found")
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def log_message(self, *args):
        pass  # quiet

    # -- routing ----------------------------------------------------------
    def do_GET(self):
        url = urlparse(self.path)
        path, qs = url.path, parse_qs(url.query)

        if path in PAGES:
            return self._send_file(PAGES[path])
        if re.fullmatch(r"/[\w.-]+\.html", path):
            return self._send_file(path.lstrip("/"))

        if path == "/api/staged":
            return self._with_conn(db.staged_batches)
        if path == "/api/types":
            return self._with_conn(db.list_types)
        if path == "/api/problems":
            return self._get_problems(qs)

        self.send_error(404, "Not found")

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            body = self._read_json()
        except json.JSONDecodeError:
            return self._send_json({"error": "invalid json"}, 400)

        m = re.fullmatch(r"/api/batches/(\d+)/approve", path)
        if m:
            bid = int(m.group(1))
            return self._with_conn(
                lambda c: {"ok": True, "approved": db.approve_batch(c, bid)},
                commit=True,
            )

        m = re.fullmatch(r"/api/batches/(\d+)/undo-approve", path)
        if m:
            bid = int(m.group(1))
            return self._with_conn(
                lambda c: {"ok": True, "restored": db.undo_approve_batch(c, bid)},
                commit=True,
            )

        m = re.fullmatch(r"/api/problems/(\d+)/reject", path)
        if m:
            pid = int(m.group(1))
            return self._with_conn(
                lambda c: (db.reject_problem(c, pid), {"ok": True})[1],
                commit=True,
            )

        if path == "/api/problem-sets":
            return self._with_conn(
                lambda c: {"id": db.create_problem_set(c)}, commit=True
            )

        if path == "/api/attempts":
            return self._save_attempts(body)

        self.send_error(404, "Not found")

    # -- handlers ---------------------------------------------------------
    def _with_conn(self, fn, commit=False, status=200):
        conn = db.connect()
        try:
            result = fn(conn)
            if commit:
                conn.commit()
        finally:
            conn.close()
        self._send_json(result, status)

    def _get_problems(self, qs):
        if "type" in qs:
            type_id = int(qs["type"][0])
            return self._with_conn(lambda c: db.problems_by_type(c, type_id))
        if "ids" in qs:
            ids = [int(i) for i in qs["ids"][0].split(",") if i]
            return self._with_conn(lambda c: db.problems_by_ids(c, ids))
        return self._send_json([], 200)

    def _save_attempts(self, body):
        def fn(conn):
            set_id = body["problem_set_id"]
            for a in body.get("attempts", []):
                db.record_attempt(
                    conn, set_id, a["problem_id"],
                    a.get("answered_correctly"), a.get("duration_seconds"),
                )
            if body.get("finish_time") is not None:
                db.set_problem_set_timing(
                    conn, set_id, body["finish_time"], body.get("time_per_problem")
                )
            db.finalize_problem_set_counts(conn, set_id)
            return {"ok": True}

        return self._with_conn(fn, commit=True)


def main():
    db.init_db()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Lightspeed running at http://localhost:{PORT}/  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
