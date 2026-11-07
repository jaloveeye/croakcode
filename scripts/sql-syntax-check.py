#!/usr/bin/env python3
"""Validate every ```sql fenced block in a markdown file by executing it
against an in-memory SQLite database. Exits non-zero on any SQL error."""
import sqlite3
import re
import sys

path = sys.argv[1]
body = open(path, encoding="utf-8").read()
blocks = re.findall(r"```sql\n(.*?)```", body, re.S)
if not blocks:
    print("no sql blocks found", file=sys.stderr)
    sys.exit(1)

conn = sqlite3.connect(":memory:")
try:
    for block in blocks:
        conn.executescript(block)
except sqlite3.Error as exc:
    print("SQL ERROR: " + str(exc), file=sys.stderr)
    sys.exit(1)

print("schema ok", len(blocks), "blocks")
