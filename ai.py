import json
import re
import threading
import time
import anthropic
import mappings as mapping_store

client = anthropic.Anthropic()

BATCH_SIZE = 40

# Thread-safe progress tracker (one active suggest job at a time per server)
_progress_lock = threading.Lock()
_progress = {"batch": 0, "total": 0, "status": "idle", "retrying": False}


def get_progress() -> dict:
    with _progress_lock:
        return dict(_progress)


def _set_progress(**kwargs):
    with _progress_lock:
        _progress.update(kwargs)


def _filter_ledgers(ledgers: list[dict]) -> list[dict]:
    """Keep only ledgers relevant to bank transactions.
    Excludes individual debtor/creditor accounts (too many, not useful for narration matching).
    """
    keep = []
    for l in ledgers:
        parent = (l.get("parent") or "").lower()
        # Keep bank, cash, expense, income, tax, loan ledgers
        if any(grp in parent for grp in (
            "bank account", "cash-in-hand", "cash in hand",
            "indirect expense", "direct expense",
            "indirect income", "direct income",
            "sales account", "purchase account",
            "duties & tax", "tax payable", "gst",
            "loans", "advances", "capital account",
            "reserves", "provisions",
        )):
            keep.append(l)
        # Keep top-level sundry debtors/creditors as catch-all but NOT individual accounts
        elif l["name"].lower() in ("sundry debtors", "sundry creditors", "cash"):
            keep.append(l)

    print(f"Filtered ledgers: {len(keep)} from {len(ledgers)}")
    return keep if len(keep) >= 20 else ledgers[:200]


def suggest_ledgers(transactions: list[dict], ledgers: list[dict], bank_info: str = "", bank_ledger: str = "", company: str = "") -> list[dict]:
    ledgers = _filter_ledgers(ledgers)
    print(f"Using {len(ledgers)} filtered ledgers for AI suggestions")
    ledger_list_text = "\n".join(f"- {l['name']} (under: {l['parent']})" for l in ledgers)

    system_prompt = f"""You are an expert Indian accountant who maps bank transactions to Tally Prime ledger entries.

Available ledgers in the company:
{ledger_list_text}

Rules:
- For DEBIT transactions (money going out): Dr = expense/asset ledger, Cr = bank account ledger
- For CREDIT transactions (money coming in): Dr = bank account ledger, Cr = income/liability ledger
- Voucher types: Payment (expense paid), Receipt (income received), Contra (bank/cash transfer), Journal (adjustments)
- Bank/cash transfers between accounts = Contra voucher
- Always pick ledger names EXACTLY as they appear in the list above
- If unsure, pick the closest match and set confidence = "low"
- Return ONLY a JSON array, no explanation"""

    if bank_ledger:
        bank_context = (
            f"The bank account ledger in Tally for this statement is confirmed to be: \"{bank_ledger}\"\n"
            f"Use \"{bank_ledger}\" as the bank side for ALL entries — do not substitute any other ledger."
            + (f"\n(Statement source: {bank_info})" if bank_info else "")
        )
    elif bank_info:
        bank_context = (
            f"Bank account details from statement: {bank_info}\n"
            f"Find the matching ledger from the list above for this bank account and use it consistently as the bank side of all entries."
        )
    else:
        bank_context = ""

    # Load past mapping hints for this company
    all_narrations = [t.get("narration", "") for t in transactions]
    hints = mapping_store.get_hints(company, all_narrations) if company else []
    hints_text = mapping_store.format_hints_for_prompt(hints)
    if hints:
        print(f"Loaded {len(hints)} past mapping hints for AI context")

    # Process in batches
    all_suggestions = {}
    batches = [transactions[i:i + BATCH_SIZE] for i in range(0, len(transactions), BATCH_SIZE)]
    print(f"Processing {len(transactions)} transactions in {len(batches)} batches")
    _set_progress(batch=0, total=len(batches), status="running", retrying=False)

    for batch_num, batch in enumerate(batches):
        _set_progress(batch=batch_num + 1, retrying=False)
        print(f"Processing batch {batch_num + 1}/{len(batches)} ({len(batch)} transactions)...")
        suggestions = _process_batch_with_retry(batch, system_prompt, bank_context, hints_text)
        all_suggestions.update({s["id"]: s for s in suggestions})
        # Small pause between batches to respect rate limits
        if batch_num < len(batches) - 1:
            time.sleep(5)

    _set_progress(status="idle", batch=0, total=0)

    # Merge back
    result = []
    for t in transactions:
        s = all_suggestions.get(t["id"], {})
        result.append({
            **t,
            "dr_ledger": s.get("dr_ledger", ""),
            "cr_ledger": s.get("cr_ledger", ""),
            "voucher_type": s.get("voucher_type", "Journal"),
            "confidence": s.get("confidence", "low"),
            "reason": s.get("reason", ""),
        })
    return result


def _process_batch_with_retry(batch: list[dict], system_prompt: str, bank_context: str, hints_text: str = "", retries: int = 4) -> list[dict]:
    delay = 15
    for attempt in range(retries):
        try:
            return _process_batch(batch, system_prompt, bank_context, hints_text)
        except anthropic.RateLimitError:
            if attempt == retries - 1:
                raise
            print(f"Rate limit hit, waiting {delay}s before retry {attempt + 1}/{retries}...")
            _set_progress(retrying=True)
            time.sleep(delay)
            _set_progress(retrying=False)
            delay *= 2
    return []


def _process_batch(batch: list[dict], system_prompt: str, bank_context: str, hints_text: str = "") -> list[dict]:
    transactions_text = json.dumps([
        {
            "id": t["id"],
            "date": t["date"],
            "narration": t["narration"],
            "amount": t["amount"],
            "type": t["type"],
        }
        for t in batch
    ], indent=2)

    user_prompt = f"""Map each transaction to the correct Dr and Cr ledgers.

{bank_context}

{hints_text}

Transactions:
{transactions_text}

Return a JSON array with one object per transaction:
[
  {{
    "id": <transaction id>,
    "dr_ledger": "<exact ledger name>",
    "cr_ledger": "<exact ledger name>",
    "voucher_type": "Payment|Receipt|Contra|Journal",
    "confidence": "high|medium|low",
    "reason": "<one line explanation>"
  }}
]"""

    resp = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=4096,
        system=[
            {
                "type": "text",
                "text": system_prompt,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": user_prompt}],
    )

    text = resp.content[0].text.strip()
    match = re.search(r'\[[\s\S]*\]', text)
    if not match:
        raise ValueError(f"No JSON array in Claude response: {text[:200]}")
    return json.loads(match.group(0))
