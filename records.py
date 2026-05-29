import sqlite3
import uuid
import os

DB = os.path.join(os.path.dirname(__file__), "payments.db")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS payment_records (
    id           TEXT PRIMARY KEY,
    company      TEXT NOT NULL,
    date         TEXT NOT NULL,
    amount       REAL NOT NULL,
    vendor       TEXT DEFAULT '',
    category     TEXT DEFAULT '',
    nature       TEXT DEFAULT '',
    location     TEXT DEFAULT '',
    payment_mode TEXT DEFAULT '',
    narration    TEXT DEFAULT '',
    prf_id       TEXT DEFAULT '',
    source       TEXT DEFAULT 'manual',
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now'))
);
"""

_FIELDS = ["company", "date", "amount", "vendor", "category", "nature",
           "location", "payment_mode", "narration", "prf_id", "source"]


def _conn():
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    return c


def init_db():
    with _conn() as c:
        c.executescript(_SCHEMA)


def get_records(company: str, from_date: str = "", to_date: str = "") -> list[dict]:
    q = "SELECT * FROM payment_records WHERE company = ?"
    params: list = [company]
    if from_date:
        q += " AND date >= ?"
        params.append(from_date.replace("-", ""))
    if to_date:
        q += " AND date <= ?"
        params.append(to_date.replace("-", ""))
    q += " ORDER BY date DESC"
    with _conn() as c:
        rows = c.execute(q, params).fetchall()
    return [dict(r) for r in rows]


def upsert_record(data: dict) -> dict:
    rec_id = data.get("id") or str(uuid.uuid4())
    vals = {f: data.get(f) or "" for f in _FIELDS}
    vals["date"] = str(vals["date"]).replace("-", "").replace("/", "")
    try:
        vals["amount"] = float(vals["amount"])
    except (ValueError, TypeError):
        vals["amount"] = 0.0

    with _conn() as c:
        exists = c.execute("SELECT 1 FROM payment_records WHERE id = ?", (rec_id,)).fetchone()
        if exists:
            set_clause = ", ".join(f"{f} = ?" for f in _FIELDS) + ", updated_at = datetime('now')"
            c.execute(f"UPDATE payment_records SET {set_clause} WHERE id = ?",
                      [vals[f] for f in _FIELDS] + [rec_id])
        else:
            cols = "id, " + ", ".join(_FIELDS)
            placeholders = ", ".join("?" * (len(_FIELDS) + 1))
            c.execute(f"INSERT INTO payment_records ({cols}) VALUES ({placeholders})",
                      [rec_id] + [vals[f] for f in _FIELDS])
    return {"id": rec_id, **vals}


def delete_record(record_id: str) -> bool:
    with _conn() as c:
        result = c.execute("DELETE FROM payment_records WHERE id = ?", (record_id,))
        return result.rowcount > 0
