import csv
import io
import re
import requests
from datetime import datetime

_DATE_FMTS = (
    "%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d",
    "%d %b %Y", "%d-%b-%Y", "%d/%m/%y", "%d-%m-%y",
    "%d-%b-%y",                           # Zoho format: "04-Feb-25"
    "%m/%d/%Y", "%B %d, %Y", "%d %B %Y",
)


def _parse_date(s: str) -> str:
    s = re.split(r'[\sT]', s.strip())[0]
    for fmt in _DATE_FMTS:
        try:
            return datetime.strptime(s, fmt).strftime("%Y%m%d")
        except ValueError:
            continue
    return ""


def _parse_amount(s: str) -> float:
    cleaned = re.sub(r'[^\d.]', '', s.replace(',', ''))
    try:
        return abs(float(cleaned))
    except Exception:
        return 0.0


def _csv_url(sheet_url: str, sheet_name: str = "") -> str:
    m = re.search(r'/spreadsheets/d/([a-zA-Z0-9_-]+)', sheet_url)
    if not m:
        raise ValueError("Invalid Google Sheets URL")
    sid = m.group(1)
    if sheet_name:
        from urllib.parse import quote
        return f"https://docs.google.com/spreadsheets/d/{sid}/gviz/tq?tqx=out:csv&sheet={quote(sheet_name)}"
    gid_m = re.search(r'gid=(\d+)', sheet_url)
    gid = gid_m.group(1) if gid_m else "0"
    return f"https://docs.google.com/spreadsheets/d/{sid}/gviz/tq?tqx=out:csv&gid={gid}"


def fetch_sheet_payments(sheet_url: str, sheet_name: str = "") -> list[dict]:
    url = _csv_url(sheet_url, sheet_name)
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    reader = csv.DictReader(io.StringIO(resp.text))
    rows = []
    for row in reader:
        date_raw = row.get("Payment Date", "").strip()
        amount_str = row.get("Amount Paid (Accounts)", "").strip()
        if not date_raw or not amount_str:
            continue
        date_key = _parse_date(date_raw)
        amount = _parse_amount(amount_str)
        if not date_key or amount <= 0:
            continue
        rows.append({
            "date_key": date_key,
            "date_raw": date_raw,
            "amount": amount,
            "status": row.get("Payment Status (Accounts)", "").strip(),
            "prf_id": row.get("Unique ID", "").strip(),
            "vendor": row.get("Vendor Name", "").strip(),
            "nature": row.get("Nature of Work", "").strip(),
            "category": row.get("Expense Category", "").strip(),
            "location": row.get("Payment For Location/Division", "").strip(),
            "payment_mode": row.get("Payment Mode (Accounts)", "").strip(),
        })
    print(f"Fetched {len(rows)} payment rows with date+amount from sheet")
    return rows


def reconcile(sheet_payments: list[dict], tally_vouchers: list[dict]) -> dict:
    # Index Tally vouchers: (date_yyyymmdd, rounded_amount) → [indices]
    t_idx: dict[tuple, list[int]] = {}
    for i, v in enumerate(tally_vouchers):
        key = (v["date"], round(v["amount"], 2))
        t_idx.setdefault(key, []).append(i)

    matched_set: set[int] = set()
    matched, sheet_only = [], []

    for p in sheet_payments:
        key = (p["date_key"], round(p["amount"], 2))
        free = [i for i in t_idx.get(key, []) if i not in matched_set]
        if free:
            idx = free[0]
            matched_set.add(idx)
            tv = tally_vouchers[idx]
            matched.append({**p, "tally_narration": tv.get("narration", ""), "tally_type": tv.get("type", "")})
        else:
            sheet_only.append({**p, "tally_narration": "", "tally_type": ""})

    tally_only = [
        {
            "date_key": v["date"], "date_raw": v["date"], "amount": v["amount"],
            "tally_narration": v.get("narration", ""), "tally_type": v.get("type", ""),
            "status": "", "prf_id": "", "vendor": "", "nature": "",
            "category": "", "location": "", "payment_mode": "",
        }
        for i, v in enumerate(tally_vouchers) if i not in matched_set
    ]

    return {
        "matched": matched,
        "sheet_only": sheet_only,
        "tally_only": tally_only,
        "summary": {
            "total_sheet": len(sheet_payments),
            "total_tally": len(tally_vouchers),
            "matched": len(matched),
            "sheet_only": len(sheet_only),
            "tally_only": len(tally_only),
        },
    }
