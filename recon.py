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


def _fetch_full_sheet(sheet_url: str, sheet_name: str) -> list[dict]:
    """Fetch all rows with all fields — used for DB import (not reconciliation)."""
    url = _csv_url(sheet_url, sheet_name)
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    reader = csv.DictReader(io.StringIO(resp.text))
    rows = []
    for row in reader:
        prf_id = row.get("Unique ID", "").strip()
        # Date: prefer Payment Date, fall back to form submission date
        pay_date = row.get("Payment Date", "").strip()
        sub_date = row.get("Date-Time", "").strip() or row.get("Added Time", "").strip()
        date_key = _parse_date(pay_date) if pay_date else _parse_date(sub_date)
        if not date_key and not prf_id:
            continue  # skip completely empty rows
        # Amount: prefer Amount Paid (Accounts), fall back to Total Invoice Amount
        amount = _parse_amount(row.get("Amount Paid (Accounts)", "").strip())
        if amount == 0:
            amount = _parse_amount(row.get("Total Invoice Amount", "").strip())
        rows.append({
            "prf_id":                prf_id,
            "date":                  date_key or "",
            "amount":                amount,
            "location":              row.get("Payment For Location/Division", "").strip(),
            "sub_division":          row.get("Sub-Division", "").strip(),
            "raised_by":             row.get("Request Raised By", "").strip(),
            "mail_id":               row.get("Mail ID", "").strip(),
            "nature":                row.get("Nature of Work", "").strip(),
            "payment_done_required": row.get("Payment Done / Required", "").strip(),
            "payment_type":          row.get("Payment Type", "").strip(),
            "payment_head":          row.get("Payment Head", "").strip(),
            "total_invoice_amount":  _parse_amount(row.get("Total Invoice Amount", "").strip()),
            "invoice_type":          row.get("Invoice Type", "").strip(),
            "invoice_ref":           row.get("Invoice OR Reference Number", "").strip(),
            "payment_mode_available":row.get("Payment Mode Available", "").strip(),
            "vendor_type":           row.get("Vendor Type (OLD / NEW)", "").strip(),
            "vendor":                row.get("Vendor Name", "").strip(),
            "vendor_mobile":         row.get("Vendor Mobile No", "").strip(),
            "payment_priority":      row.get("Payment Priority", "").strip(),
            "approved_by":           row.get("Discussed & Approved By", "").strip(),
            "remarks":               row.get("Remarks If Any", "").strip(),
            "payment_status":        row.get("Payment Status (Accounts)", "").strip(),
            "payment_mode":          row.get("Payment Mode (Accounts)", "").strip(),
            "category":              row.get("Expense Category", "").strip(),
            "accounts_remarks":      row.get("Accounts Remarks", "").strip(),
            "source":                "zoho_import",
        })
    return rows


def fetch_all_zoho_payments(sheet_url: str) -> list[dict]:
    """Fetch and merge both Zoho tabs. ER takes precedence for same PRF ID."""
    er = _fetch_full_sheet(sheet_url, "Expense Reporting")
    pr = _fetch_full_sheet(sheet_url, "Payment Request")
    merged: dict[str, dict] = {}
    for row in pr:
        key = row["prf_id"] or f"_pr_{len(merged)}"
        merged[key] = row
    for row in er:
        key = row["prf_id"] or f"_er_{len(merged)}"
        merged[key] = row
    print(f"Zoho import: {len(er)} ER + {len(pr)} PR → {len(merged)} unique rows")
    return list(merged.values())


def _fetch_one_sheet(sheet_url: str, sheet_name: str) -> list[dict]:
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
    return rows


def fetch_sheet_payments(sheet_url: str, sheet_name: str = "") -> list[dict]:
    # "both" merges all known tabs, deduplicating by PRF ID (Expense Reporting preferred)
    if sheet_name.lower() == "both":
        er = _fetch_one_sheet(sheet_url, "Expense Reporting")
        pr = _fetch_one_sheet(sheet_url, "Payment Request")
        # Build by PRF ID — Expense Reporting takes precedence
        merged: dict[str, dict] = {}
        for row in pr:
            key = row["prf_id"] or f"_nokey_{len(merged)}"
            merged[key] = row
        for row in er:
            key = row["prf_id"] or f"_nokey_{len(merged)}"
            merged[key] = row  # ER overwrites PR for same ID
        rows = list(merged.values())
        print(f"Merged both sheets: {len(er)} Expense Reporting + {len(pr)} Payment Request → {len(rows)} unique rows")
        return rows

    rows = _fetch_one_sheet(sheet_url, sheet_name)
    label = sheet_name or "gid=0"
    print(f"Fetched {len(rows)} payment rows from sheet '{label}'")
    return rows


def reconcile(sheet_payments: list[dict], tally_vouchers: list[dict],
              local_records: list[dict] | None = None) -> dict:
    # Build indexes for Tally vouchers
    t_prf_idx: dict[str, list[int]] = {}   # reference (PRF ID) → [indices]
    t_amt_idx: dict[tuple, list[int]] = {}  # (date, amount) → [indices]
    for i, v in enumerate(tally_vouchers):
        ref = (v.get("reference") or "").strip()
        if ref:
            t_prf_idx.setdefault(ref, []).append(i)
        t_amt_idx.setdefault((v["date"], round(v["amount"], 2)), []).append(i)

    matched_set: set[int] = set()
    matched, sheet_only = [], []

    for p in sheet_payments:
        idx = None
        # Pass 1a: match by PRF ID
        prf = (p.get("prf_id") or "").strip()
        if prf:
            free = [i for i in t_prf_idx.get(prf, []) if i not in matched_set]
            if free:
                idx = free[0]
        # Pass 1b: fall back to (date, amount)
        if idx is None:
            key = (p["date_key"], round(p["amount"], 2))
            free = [i for i in t_amt_idx.get(key, []) if i not in matched_set]
            if free:
                idx = free[0]

        if idx is not None:
            matched_set.add(idx)
            tv = tally_vouchers[idx]
            matched.append({**p, "tally_narration": tv.get("narration", ""), "tally_type": tv.get("type", ""), "tally_reference": tv.get("reference", "")})
        else:
            sheet_only.append({**p, "tally_narration": "", "tally_type": "", "tally_reference": ""})

    tally_only = [
        {
            "date_key": v["date"], "date_raw": v["date"], "amount": v["amount"],
            "tally_narration": v.get("narration", ""), "tally_type": v.get("type", ""),
            "tally_reference": v.get("reference", ""),
            "status": "", "prf_id": v.get("reference", ""), "vendor": "", "nature": "",
            "category": "", "location": "", "payment_mode": "",
        }
        for i, v in enumerate(tally_vouchers) if i not in matched_set
    ]

    # Pass 2: match remaining tally_only against local SQLite records (PRF ID first, then date+amount)
    local_record_rows: list[dict] = []
    if local_records:
        lr_prf_idx: dict[str, list[int]] = {}
        lr_amt_idx: dict[tuple, list[int]] = {}
        for i, lr in enumerate(local_records):
            prf = (lr.get("prf_id") or "").strip()
            if prf:
                lr_prf_idx.setdefault(prf, []).append(i)
            lr_amt_idx.setdefault((str(lr["date"]), round(float(lr["amount"]), 2)), []).append(i)

        lr_used: set[int] = set()
        remaining: list[dict] = []
        for row in tally_only:
            idx = None
            ref = (row.get("tally_reference") or "").strip()
            if ref:
                free = [i for i in lr_prf_idx.get(ref, []) if i not in lr_used]
                if free:
                    idx = free[0]
            if idx is None:
                key = (row["date_key"], round(row["amount"], 2))
                free = [i for i in lr_amt_idx.get(key, []) if i not in lr_used]
                if free:
                    idx = free[0]

            if idx is not None:
                lr_used.add(idx)
                lr = local_records[idx]
                local_record_rows.append({
                    **row,
                    "vendor": lr.get("vendor", ""),
                    "category": lr.get("category", ""),
                    "nature": lr.get("nature", ""),
                    "location": lr.get("location", ""),
                    "payment_mode": lr.get("payment_mode", ""),
                    "narration": lr.get("narration", ""),
                    "prf_id": lr.get("prf_id", ""),
                    "record_id": lr["id"],
                })
            else:
                remaining.append(row)
        tally_only = remaining

    return {
        "matched": matched,
        "sheet_only": sheet_only,
        "tally_only": tally_only,
        "local_record": local_record_rows,
        "summary": {
            "total_sheet": len(sheet_payments),
            "total_tally": len(tally_vouchers),
            "matched": len(matched),
            "sheet_only": len(sheet_only),
            "tally_only": len(tally_only),
            "local_record": len(local_record_rows),
        },
    }
