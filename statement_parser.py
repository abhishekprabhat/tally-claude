import io
import json
import re
import pandas as pd
import anthropic

client = anthropic.Anthropic()

# Keywords that indicate a header row in bank statements
_HEADER_KEYWORDS = {"date", "narration", "description", "particulars",
                    "withdrawal", "deposit", "debit", "credit", "amount",
                    "balance", "chq", "ref", "cheque", "transaction"}


def parse_statement(file_bytes: bytes, filename: str) -> tuple[list[dict], str]:
    if filename.lower().endswith(".csv"):
        df = _read_csv(file_bytes)
    elif filename.lower().endswith(".xls"):
        df = pd.read_excel(io.BytesIO(file_bytes), header=None, engine="xlrd", dtype=str)
    else:
        df = pd.read_excel(io.BytesIO(file_bytes), header=None, engine="openpyxl", dtype=str)

    # Extract bank info from the top rows before the header
    bank_info = _extract_bank_info(df)
    print(f"Detected bank info: {bank_info}")

    # Find the header row
    header_row = _find_header_row(df)
    print(f"Header row index: {header_row}")

    if header_row is None:
        raise ValueError("Could not find transaction header row in the statement. "
                         "Expected a row with Date/Narration/Debit/Credit columns.")

    # Set column names from header row
    df.columns = df.iloc[header_row].astype(str).str.strip()
    df = df.iloc[header_row + 1:].reset_index(drop=True)

    # Drop rows that are all-NaN or separator rows (rows of asterisks/dashes)
    df = df[~df.apply(lambda r: r.astype(str).str.match(r'^[\*\-\=\s]+$').all(), axis=1)]
    df = df.dropna(how="all")

    print(f"Columns after header: {df.columns.tolist()}")

    # Use Claude to identify which columns are date/narration/debit/credit/ref
    col_sample = df.head(5).to_csv(index=False)
    mapping = _detect_columns(df.columns.tolist(), col_sample)
    print(f"Detected mapping: {mapping}")

    transactions = []
    for i, row in df.iterrows():
        try:
            date = _cell(row, mapping.get("date_col"))
            narration = _cell(row, mapping.get("narration_col"))
            debit = _to_float(_cell(row, mapping.get("debit_col")))
            credit = _to_float(_cell(row, mapping.get("credit_col")))
            reference = _cell(row, mapping.get("ref_col"))
            closing_balance = _to_float(_cell(row, mapping.get("balance_col")))

            if not date or not narration or (debit == 0 and credit == 0):
                continue

            # Skip totals/balance rows
            if any(kw in narration.lower() for kw in
                   ("opening balance", "closing balance", "total", "brought forward")):
                continue

            # Skip if date doesn't look like a date
            if not re.search(r'\d{1,4}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}', date):
                continue

            amount = debit if debit else credit
            txn_type = "debit" if debit else "credit"

            transactions.append({
                "id": i,
                "date": date,
                "narration": narration,
                "amount": amount,
                "type": txn_type,
                "reference": reference,
                "closing_balance": closing_balance,
            })
        except Exception:
            continue

    print(f"Parsed {len(transactions)} transactions")
    return transactions, bank_info


def _cell(row, col) -> str:
    if col is None:
        return ""
    try:
        val = row[col]
        if pd.isna(val):
            return ""
        return str(val).strip()
    except (KeyError, TypeError):
        return ""


def _find_header_row(df: pd.DataFrame) -> int | None:
    for i in range(min(40, len(df))):
        row_vals = [str(v).lower().strip() for v in df.iloc[i].tolist() if pd.notna(v) and str(v).strip()]
        matches = sum(1 for v in row_vals if any(kw in v for kw in _HEADER_KEYWORDS))
        if matches >= 3:
            return i
    return None


def _extract_bank_info(df: pd.DataFrame) -> str:
    """Extract clean bank/account info from header rows."""
    text_parts = []
    for i in range(min(20, len(df))):
        row_text = " ".join(str(v).strip() for v in df.iloc[i].tolist()
                            if pd.notna(v) and str(v).strip() not in ("", "nan"))
        row_text = re.sub(r'\s+', ' ', row_text).strip()
        if row_text:
            text_parts.append(row_text)
    combined = " | ".join(text_parts)
    # Extract key fields with regex
    acct = re.search(r'Account No\s*[:\-]?\s*([\d]+)', combined, re.I)
    bank = re.search(r'(HDFC|ICICI|SBI|AXIS|KOTAK|YES|IDFC|PNB|BOB|CANARA)[^\|]*BANK', combined, re.I)
    holder = re.search(r'M/S\.?\s+([A-Z\s]+(?:PRIVATE|PUBLIC|LTD|LIMITED|PVT)[^\|]*)', combined, re.I)
    parts = []
    if bank:
        parts.append(bank.group(0).strip())
    if holder:
        parts.append(holder.group(0).strip()[:60])
    if acct:
        parts.append(f"Account No: {acct.group(1)}")
    return ", ".join(parts) if parts else combined[:200]


def _detect_columns(columns: list[str], sample_csv: str) -> dict:
    """Match columns by keywords — no API call needed for standard bank statement formats."""
    cols_lower = {c.lower().strip(): c for c in columns}

    def find(keywords):
        for kw in keywords:
            for lc, orig in cols_lower.items():
                if kw in lc:
                    return orig
        return None

    mapping = {
        "date_col":     find(["date"]),
        "narration_col": find(["narration", "description", "particular", "remarks", "details"]),
        "debit_col":    find(["withdrawal", "debit", "dr "]),
        "credit_col":   find(["deposit", "credit", "cr "]),
        "ref_col":      find(["chq", "ref", "cheque", "reference", "txn id", "utr"]),
        "balance_col":  find(["closing balance", "balance"]),
    }

    # Validate — if date or narration not found, raise clearly
    if not mapping["date_col"]:
        raise ValueError(f"Could not find date column in: {columns}")
    if not mapping["narration_col"]:
        raise ValueError(f"Could not find narration column in: {columns}")

    print(f"Keyword mapping: {mapping}")
    return mapping


def _read_csv(file_bytes: bytes) -> pd.DataFrame:
    for enc in ("utf-8", "latin-1", "cp1252"):
        try:
            return pd.read_csv(io.BytesIO(file_bytes), encoding=enc, header=None, dtype=str)
        except Exception:
            continue
    raise ValueError("Could not read CSV file")


def _to_float(val: str) -> float:
    if not val:
        return 0.0
    s = val.strip().replace(",", "").replace(" ", "")
    if not s or s in ("-", "nan", "None"):
        return 0.0
    try:
        return abs(float(s))
    except ValueError:
        return 0.0
