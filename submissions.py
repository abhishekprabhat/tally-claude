"""
Local submission store: tracks bank transactions that have been submitted to Tally
through this tool, keyed by company + account number.

Uses closing_balance as the primary dedup key (unique per transaction in a bank statement).
Falls back to date+amount+type if closing_balance is missing.
"""

import json
import os
import re
from pathlib import Path

_STORE_FILE = Path(__file__).parent / "submissions_store.json"


def _load() -> dict:
    if _STORE_FILE.exists():
        try:
            return json.loads(_STORE_FILE.read_text())
        except Exception:
            return {}
    return {}


def _save(data: dict):
    _STORE_FILE.write_text(json.dumps(data, indent=2))


def _account_key(company: str, bank_info: str) -> str:
    """Extract account number from bank_info for a stable store key."""
    acct = re.search(r'(\d{8,})', bank_info or "")
    acct_suffix = acct.group(1)[-10:] if acct else "unknown"
    safe_company = re.sub(r'[^a-zA-Z0-9]', '_', company)[:30]
    return f"{safe_company}|{acct_suffix}"


def record_submitted(company: str, bank_info: str, transactions: list[dict]):
    """Record successfully submitted transactions to prevent future duplicates."""
    key = _account_key(company, bank_info)
    store = _load()
    if key not in store:
        store[key] = {"closing_balances": [], "date_amount_keys": []}

    cb_set = set(store[key]["closing_balances"])
    da_set = set(store[key]["date_amount_keys"])

    for t in transactions:
        cb = t.get("closing_balance")
        if cb and cb > 0:
            cb_set.add(round(float(cb), 2))
        da_key = f"{t.get('date','')}|{round(abs(float(t.get('amount', 0))), 2)}|{t.get('type','')}"
        da_set.add(da_key)

    store[key]["closing_balances"] = sorted(cb_set)
    store[key]["date_amount_keys"] = sorted(da_set)
    _save(store)
    print(f"Stored {len(transactions)} submissions for key={key}")


def mark_duplicates(company: str, bank_info: str, transactions: list[dict]):
    """Mark transactions as duplicates if they were previously submitted via this tool."""
    key = _account_key(company, bank_info)
    store = _load()
    if key not in store:
        for t in transactions:
            t.setdefault("is_duplicate", False)
        return

    cb_set = set(store[key].get("closing_balances", []))
    da_set = set(store[key].get("date_amount_keys", []))

    for t in transactions:
        cb = t.get("closing_balance")
        if cb and round(float(cb), 2) in cb_set:
            t["is_duplicate"] = True
            t["approved"] = False
            continue
        da_key = f"{t.get('date','')}|{round(abs(float(t.get('amount', 0))), 2)}|{t.get('type','')}"
        if da_key in da_set:
            t["is_duplicate"] = True
            t["approved"] = False
            continue
        t.setdefault("is_duplicate", False)
