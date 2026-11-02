"""Append-only local transcript history for Voice Center."""

import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path


class TranscriptStore:
    def __init__(self, file_path=None, now=None):
        root = Path(os.environ.get("VOICE_CENTER_DATA_DIR", Path(__file__).resolve().parent / "data"))
        self.path = Path(file_path or os.environ.get("VOICE_CENTER_TRANSCRIPT_DB") or root / "transcripts.sqlite")
        self.now = now or (lambda: datetime.now(timezone.utc).isoformat())
        self.lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.connection() as db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS transcripts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at TEXT NOT NULL,
                    role TEXT NOT NULL,
                    text TEXT NOT NULL,
                    source TEXT NOT NULL,
                    identity_json TEXT,
                    metadata_json TEXT
                )
            """)
            db.execute("CREATE INDEX IF NOT EXISTS transcripts_created_at ON transcripts(created_at)")

    def connection(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.execute("PRAGMA journal_mode=WAL")
        return db

    def append(self, role, text, *, source="voice", identity=None, metadata=None):
        if role not in {"user", "assistant", "system"}:
            raise ValueError("invalid transcript role")
        value = str(text or "").strip()
        if not value:
            return None
        if len(value) > 12000:
            value = value[:12000]
        with self.lock, self.connection() as db:
            cursor = db.execute(
                "INSERT INTO transcripts(created_at, role, text, source, identity_json, metadata_json) VALUES (?,?,?,?,?,?)",
                (
                    self.now(), role, value, source,
                    json.dumps(identity or {}, ensure_ascii=False),
                    json.dumps(metadata or {}, ensure_ascii=False),
                ),
            )
            return cursor.lastrowid

    def recent(self, limit=20):
        count = max(1, min(100, int(limit)))
        with self.lock, self.connection() as db:
            rows = db.execute(
                "SELECT id, created_at, role, text, source FROM transcripts ORDER BY id DESC LIMIT ?",
                (count,),
            ).fetchall()
        return [
            {"id": row[0], "created_at": row[1], "role": row[2], "text": row[3], "source": row[4]}
            for row in reversed(rows)
        ]
