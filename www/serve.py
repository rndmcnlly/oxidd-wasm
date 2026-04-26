#!/usr/bin/env python3
"""Serve www/ for local testing.

Previously set COOP/COEP headers required for SharedArrayBuffer. Now
that we run single-threaded wasm, no special headers are needed: any
static file server will do. Kept for convenience.
"""
import http.server
import sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory="www", **kwargs)

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    http.server.HTTPServer(("", port), Handler).serve_forever()
