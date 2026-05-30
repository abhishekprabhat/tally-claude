import sqlite3
import uuid
import os

DB = os.path.join(os.path.dirname(__file__), "payments.db")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS payment_records (
    id           TEXT PRIMARY KEY,
    company      TEXT NOT NULL,
    date         TEXT NOT NULL,
    amount       REAL NOT NULL DEFAULT 0,
    prf_id       TEXT DEFAULT '',
    location     TEXT DEFAULT '',
    sub_division TEXT DEFAULT '',
    raised_by    TEXT DEFAULT '',
    mail_id      TEXT DEFAULT '',
    nature       TEXT DEFAULT '',
    payment_done_required  TEXT DEFAULT '',
    payment_type           TEXT DEFAULT '',
    payment_head           TEXT DEFAULT '',
    total_invoice_amount   REAL DEFAULT 0,
    invoice_type           TEXT DEFAULT '',
    invoice_ref            TEXT DEFAULT '',
    payment_mode_available TEXT DEFAULT '',
    payment_priority       TEXT DEFAULT '',
    vendor_type   TEXT DEFAULT '',
    vendor        TEXT DEFAULT '',
    vendor_mobile TEXT DEFAULT '',
    approved_by   TEXT DEFAULT '',
    remarks       TEXT DEFAULT '',
    payment_status   TEXT DEFAULT '',
    payment_mode     TEXT DEFAULT '',
    category         TEXT DEFAULT '',
    accounts_remarks TEXT DEFAULT '',
    narration        TEXT DEFAULT '',
    source       TEXT DEFAULT 'manual',
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now'))
);
"""

# Columns added after initial schema — migrated via ALTER TABLE
_NEW_COLUMNS = [
    ("sub_division",           "TEXT DEFAULT ''"),
    ("raised_by",              "TEXT DEFAULT ''"),
    ("mail_id",                "TEXT DEFAULT ''"),
    ("payment_done_required",  "TEXT DEFAULT ''"),
    ("payment_type",           "TEXT DEFAULT ''"),
    ("payment_head",           "TEXT DEFAULT ''"),
    ("total_invoice_amount",   "REAL DEFAULT 0"),
    ("invoice_type",           "TEXT DEFAULT ''"),
    ("invoice_ref",            "TEXT DEFAULT ''"),
    ("payment_mode_available", "TEXT DEFAULT ''"),
    ("vendor_type",            "TEXT DEFAULT ''"),
    ("vendor_mobile",          "TEXT DEFAULT ''"),
    ("payment_priority",       "TEXT DEFAULT ''"),
    ("approved_by",            "TEXT DEFAULT ''"),
    ("remarks",                "TEXT DEFAULT ''"),
    ("payment_status",         "TEXT DEFAULT ''"),
    ("accounts_remarks",       "TEXT DEFAULT ''"),
]

_FIELDS = [
    "company", "date", "amount",
    "prf_id", "location", "sub_division", "raised_by", "mail_id",
    "nature", "payment_done_required", "payment_type", "payment_head",
    "total_invoice_amount", "invoice_type", "invoice_ref",
    "payment_mode_available", "payment_priority",
    "vendor_type", "vendor", "vendor_mobile",
    "approved_by", "remarks",
    "payment_status", "payment_mode", "category", "accounts_remarks", "narration",
    "source",
]


def _conn():
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    return c


def init_db():
    with _conn() as c:
        c.executescript(_SCHEMA)
        for col, defn in _NEW_COLUMNS:
            try:
                c.execute(f"ALTER TABLE payment_records ADD COLUMN {col} {defn}")
            except sqlite3.OperationalError:
                pass  # column already exists


def get_records(company: str, from_date: str = "", to_date: str = "",
                status: str = "", location: str = "", source: str = "") -> list[dict]:
    q = "SELECT * FROM payment_records WHERE company = ?"
    params: list = [company]
    if from_date:
        q += " AND date >= ?"
        params.append(from_date.replace("-", ""))
    if to_date:
        q += " AND date <= ?"
        params.append(to_date.replace("-", ""))
    if status:
        q += " AND payment_status = ?"
        params.append(status)
    if location:
        q += " AND location = ?"
        params.append(location)
    if source:
        q += " AND source = ?"
        params.append(source)
    q += " ORDER BY date DESC"
    with _conn() as c:
        rows = c.execute(q, params).fetchall()
    return [dict(r) for r in rows]


def get_by_prf_id(company: str, prf_id: str) -> dict | None:
    with _conn() as c:
        row = c.execute(
            "SELECT * FROM payment_records WHERE company = ? AND prf_id = ?",
            (company, prf_id),
        ).fetchone()
    return dict(row) if row else None


def upsert_record(data: dict) -> dict:
    is_new = not data.get("id")
    rec_id = data.get("id") or str(uuid.uuid4())

    vals = {f: data.get(f) or "" for f in _FIELDS}
    vals["date"] = str(vals["date"]).replace("-", "").replace("/", "")
    try:
        vals["amount"] = float(vals["amount"])
    except (ValueError, TypeError):
        vals["amount"] = 0.0
    try:
        vals["total_invoice_amount"] = float(vals["total_invoice_amount"]) if vals["total_invoice_amount"] else 0.0
    except (ValueError, TypeError):
        vals["total_invoice_amount"] = 0.0

    with _conn() as c:
        existing = c.execute("SELECT * FROM payment_records WHERE id = ?", (rec_id,)).fetchone()

        if is_new and not vals["prf_id"]:
            rows = c.execute(
                "SELECT prf_id FROM payment_records WHERE company = ? AND prf_id LIKE 'REC-%'",
                (vals["company"],),
            ).fetchall()
            nums = []
            for row in rows:
                try:
                    nums.append(int(str(row[0])[4:]))
                except Exception:
                    pass
            vals["prf_id"] = f"REC-{(max(nums) + 1 if nums else 1):04d}"
        elif existing and not vals["prf_id"]:
            vals["prf_id"] = dict(existing).get("prf_id", "") or ""

        if existing:
            set_clause = ", ".join(f"{f} = ?" for f in _FIELDS) + ", updated_at = datetime('now')"
            c.execute(
                f"UPDATE payment_records SET {set_clause} WHERE id = ?",
                [vals[f] for f in _FIELDS] + [rec_id],
            )
        else:
            cols = "id, " + ", ".join(_FIELDS)
            placeholders = ", ".join("?" * (len(_FIELDS) + 1))
            c.execute(
                f"INSERT INTO payment_records ({cols}) VALUES ({placeholders})",
                [rec_id] + [vals[f] for f in _FIELDS],
            )

    return {"id": rec_id, **vals}


def delete_record(record_id: str) -> bool:
    with _conn() as c:
        result = c.execute("DELETE FROM payment_records WHERE id = ?", (record_id,))
        return result.rowcount > 0
