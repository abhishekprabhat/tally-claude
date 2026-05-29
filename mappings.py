"""
Learning store: narration → ledger mapping memory, keyed per company.

Records approved/submitted transaction mappings and surfaces them as hints
for future AI suggestions. Uses normalized narration keys so "UPI/REF123/IRCTC"
and "UPI/REF456/IRCTC" both map to the same pattern "irctc".
"""

import json
import re
from pathlib import Path

_STORE_FILE = Path(__file__).parent / "mappings_store.json"

# Strip noise: transaction reference IDs, mode prefixes, separators
_NOISE = re.compile(
    r'\b(upi|neft|rtgs|nach|ecs|imps|nocs|cr|dr|wdl|atm|txn|ref|no|id|vide|being|to|by|for|the|a|of)\b'
    r'|[/\-_|#@:]'
    r'|\b\d{5,}\b',   # long digit sequences (reference numbers)
    re.IGNORECASE,
)


def _normalize(narration: str) -> str:
    """Reduce narration to a stable key by removing reference IDs and noise."""
    s = _NOISE.sub(' ', narration)
    s = re.sub(r'\s+', ' ', s).strip().lower()
    return s[:60]


def _co_key(company: str) -> str:
    return re.sub(r'[^a-zA-Z0-9]', '_', company)[:40]


def _load() -> dict:
    if _STORE_FILE.exists():
        try:
            return json.loads(_STORE_FILE.read_text())
        except Exception:
            return {}
    return {}


def _save(data: dict):
    _STORE_FILE.write_text(json.dumps(data, indent=2))


def record_mappings(company: str, transactions: list[dict]):
    """Persist narration→ledger mappings from approved+submitted transactions."""
    co = _co_key(company)
    store = _load()
    mappings = store.setdefault(co, {})

    new = 0
    for t in transactions:
        narration = t.get("narration", "")
        dr = t.get("dr_ledger", "")
        cr = t.get("cr_ledger", "")
        vtype = t.get("voucher_type", "")
        if not narration or not dr or not cr:
            continue
        norm = _normalize(narration)
        if not norm or len(norm) < 3:
            continue

        entry = mappings.get(norm)
        if entry is None:
            entry = {"dr": dr, "cr": cr, "type": vtype, "count": 0, "examples": []}
            new += 1
        entry["count"] += 1
        entry["dr"] = dr
        entry["cr"] = cr
        entry["type"] = vtype
        examples = entry.get("examples", [])
        if narration not in examples:
            entry["examples"] = (examples + [narration])[:3]
        mappings[norm] = entry

    store[co] = mappings
    _save(store)
    print(f"Mappings: recorded {len(transactions)} transactions ({new} new patterns), "
          f"total={len(mappings)} for company={co}")


def get_hints(company: str, narrations: list[str]) -> list[dict]:
    """
    Return past mappings relevant to the given narrations.
    Matches by exact normalized key first, then by shared keywords.
    Returns at most 30 unique (dr, cr) pairs, sorted by frequency.
    """
    co = _co_key(company)
    store = _load()
    mappings = store.get(co, {})
    if not mappings:
        return []

    # Pre-split all stored keys for word overlap matching
    stored_words = {k: set(k.split()) for k in mappings}

    hints_map: dict[tuple, dict] = {}  # (dr,cr) → best hint

    for narration in narrations:
        norm = _normalize(narration)
        if not norm:
            continue

        # Exact match
        if norm in mappings:
            m = mappings[norm]
            pair = (m["dr"], m["cr"])
            if pair not in hints_map or m["count"] > hints_map[pair]["count"]:
                hints_map[pair] = {
                    "pattern": norm,
                    "dr_ledger": m["dr"],
                    "cr_ledger": m["cr"],
                    "voucher_type": m["type"],
                    "count": m["count"],
                    "examples": m.get("examples", []),
                }
            continue

        # Partial: at least 2 significant words in common
        words = set(norm.split())
        for stored_key, sw in stored_words.items():
            overlap = words & sw
            if len(overlap) >= 2:
                m = mappings[stored_key]
                pair = (m["dr"], m["cr"])
                if pair not in hints_map or m["count"] > hints_map[pair]["count"]:
                    hints_map[pair] = {
                        "pattern": stored_key,
                        "dr_ledger": m["dr"],
                        "cr_ledger": m["cr"],
                        "voucher_type": m["type"],
                        "count": m["count"],
                        "examples": m.get("examples", []),
                    }
                break

    result = sorted(hints_map.values(), key=lambda x: -x["count"])
    return result[:30]


def format_hints_for_prompt(hints: list[dict]) -> str:
    """Format hints as a compact reference section for the AI prompt."""
    if not hints:
        return ""
    lines = ["Past approved mappings (use as reference — match by narration pattern):"]
    for h in hints:
        ex = h["examples"][0] if h.get("examples") else h["pattern"]
        lines.append(
            f'  - "{ex}" → Dr: {h["dr_ledger"]}, Cr: {h["cr_ledger"]} '
            f'({h["voucher_type"]}) [used {h["count"]}x]'
        )
    return "\n".join(lines)
