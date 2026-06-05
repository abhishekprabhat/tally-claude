import re
import requests
import xml.etree.ElementTree as ET
from datetime import datetime

TALLY_URL = "http://localhost:9000"

# Strip XML 1.0 invalid control characters (keeps tab, newline, carriage return)
_INVALID_XML_CHARS = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')


def _clean_xml(text: str) -> str:
    # Remove invalid bare control chars
    text = _INVALID_XML_CHARS.sub('', text)
    # Replace invalid numeric character references like &#4;
    text = re.sub(r'&#([0-9]+);', lambda m: '' if int(m.group(1)) < 32 and int(m.group(1)) not in (9, 10, 13) else m.group(0), text)
    # Tally UDF fields use xmlns:UDF prefix without declaring the namespace — inject it
    if 'UDF:' in text and 'xmlns:UDF' not in text:
        text = text.replace('<ENVELOPE>', '<ENVELOPE xmlns:UDF="TallyUDF">', 1)
    return text


def _post(xml: str, timeout: int = 30) -> ET.Element:
    resp = requests.post(TALLY_URL, data=xml.encode("utf-8"), timeout=timeout)
    resp.raise_for_status()
    return ET.fromstring(_clean_xml(resp.text))


def get_companies() -> list[dict]:
    xml = """<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>MyCompanyList</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="MyCompanyList" ISMODIFY="No">
            <TYPE>Company</TYPE>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>"""
    root = _post(xml)
    companies = []
    for c in root.findall(".//COMPANY"):
        name = c.get("NAME") or (c.findtext("NAME") or "").strip()
        if name:
            companies.append({"name": name})
    return companies


def get_ledgers(company: str) -> list[dict]:
    xml = f"""<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>LedgerList</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVCURRENTCOMPANY>{company}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="LedgerList" ISMODIFY="No">
            <TYPE>Ledger</TYPE>
            <NATIVEMETHOD>Name, Parent</NATIVEMETHOD>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>"""
    root = _post(xml)
    ledgers = []
    for l in root.findall(".//LEDGER"):
        name = l.get("NAME") or (l.findtext("NAME") or "").strip()
        parent = (l.findtext("PARENT") or "").strip()
        if name:
            ledgers.append({"name": name, "parent": parent})
    return ledgers


def get_existing_vouchers(company: str) -> list[dict]:
    """Fetch all Payment/Receipt/Contra vouchers from Tally for duplicate detection.

    SVFROMDATE/SVTODATE do not filter NATIVEMETHOD collections — all vouchers are returned.
    Caller must filter by date range client-side.
    """
    xml = f"""<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>BV</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVCURRENTCOMPANY>{company}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="BV" ISMODIFY="No">
            <TYPE>Voucher</TYPE>
            <NATIVEMETHOD>Date, Narration, VoucherTypeName, Amount</NATIVEMETHOD>
            <FILTER>BankTypes</FILTER>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="BankTypes">
            $VoucherTypeName = "Payment" OR $VoucherTypeName = "Receipt" OR $VoucherTypeName = "Contra"
          </SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>"""

    try:
        root = _post(xml, timeout=60)
        entries = []
        skipped_zero = 0
        for v in root.findall(".//VOUCHER"):
            date = (v.findtext("DATE") or "").strip()
            narration = (v.findtext("NARRATION") or "").strip()
            vtype = (v.findtext("VOUCHERTYPENAME") or "").strip()
            amount_str = (v.findtext("AMOUNT") or "0").strip()
            try:
                # Handle Indian comma-formatted numbers like "1,23,456.78"
                amount = abs(float(amount_str.replace(",", "")))
            except Exception:
                amount = 0.0
            if date and amount > 0:
                entries.append({"date": date, "narration": narration, "type": vtype, "amount": amount})
            elif date:
                skipped_zero += 1
        print(f"Fetched {len(entries)} bank vouchers from Tally (skipped {skipped_zero} zero-amount) for company={company!r}")
        if entries:
            print(f"  Sample Tally vouchers: {entries[:3]}")
        return entries
    except Exception as e:
        print(f"Warning: Could not fetch existing vouchers from Tally: {e}")
        return []


def get_payment_vouchers(company: str, bank_ledger: str = "") -> list[dict]:
    """Fetch only Payment vouchers for reconciliation, optionally filtered to a specific bank ledger.

    Tries ledger-level filtering first; falls back to all Payment vouchers if the filter returns 0
    (which happens when $$IsLedgerEntry is unsupported by the Tally version).
    """
    def _fetch(filter_formula: str) -> list[dict]:
        xml = f"""<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>PV</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVCURRENTCOMPANY>{company}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="PV" ISMODIFY="No">
            <TYPE>Voucher</TYPE>
            <NATIVEMETHOD>Date, Narration, VoucherTypeName, Amount, Reference, GUID</NATIVEMETHOD>
            <FILTER>PayFilter</FILTER>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="PayFilter">
            {filter_formula}
          </SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>"""
        root = _post(xml, timeout=60)
        entries = []
        for v in root.findall(".//VOUCHER"):
            date = (v.findtext("DATE") or "").strip()
            narration = (v.findtext("NARRATION") or "").strip()
            reference = (v.findtext("REFERENCE") or "").strip()
            guid = (v.findtext("GUID") or v.get("GUID") or "").strip()
            amount_str = (v.findtext("AMOUNT") or "0").strip()
            try:
                amount = abs(float(amount_str.replace(",", "")))
            except Exception:
                amount = 0.0
            if date and amount > 0:
                entries.append({"date": date, "narration": narration, "reference": reference, "guid": guid, "type": "Payment", "amount": amount})
        return entries

    try:
        if bank_ledger:
            safe = bank_ledger.replace('"', '')
            entries = _fetch(f'$VoucherTypeName = "Payment" AND $$IsLedgerEntry:"{safe}"')
            if entries:
                print(f"Fetched {len(entries)} Payment vouchers for ledger='{bank_ledger}'")
                return entries
            # $$IsLedgerEntry not supported — fall back to all Payment vouchers
            print(f"Note: ledger filter unsupported, fetching all Payment vouchers")

        entries = _fetch('$VoucherTypeName = "Payment"')
        print(f"Fetched {len(entries)} Payment vouchers (all) for company={company!r}")
        return entries
    except Exception as e:
        print(f"Warning: Could not fetch payment vouchers: {e}")
        return []


def update_voucher_reference(company: str, guid: str, reference: str) -> bool:
    """Write a new REFERENCE value back into an existing Tally voucher identified by GUID."""
    ref_escaped = reference.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    xml = f"""<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>{company}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER GUID="{guid}" ACTION="Alter" OBJVIEW="Accounting Voucher View">
            <REFERENCE>{ref_escaped}</REFERENCE>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>"""
    root = _post(xml)
    error = root.findtext(".//LINEERROR") or root.findtext(".//IMPORTRESULT/ERRORS")
    if error:
        raise RuntimeError(f"Tally ALTER error: {error.strip()}")
    altered = root.findtext(".//IMPORTRESULT/ALTERED") or "0"
    return altered.strip() != "0"


def mark_tally_duplicates(company: str, transactions: list[dict]) -> bool:
    """Query Tally for existing bank vouchers and mark matching transactions as duplicates.

    Returns True if Tally was reachable (even if no duplicates found), False if Tally query failed.
    Matches on date (YYYYMMDD) + amount (within 0.01 tolerance).
    """
    if not transactions:
        return True

    dates = [_format_date(t["date"]) for t in transactions if t.get("date")]
    if not dates:
        return True
    min_date, max_date = min(dates), max(dates)

    # Log a sample of raw bank transaction keys for comparison
    sample_txns = [(t.get("date",""), _format_date(t.get("date","")), t.get("amount",0)) for t in transactions[:3]]
    print(f"  Sample bank txn keys: {sample_txns}")

    existing = get_existing_vouchers(company)
    if existing is None:
        return False

    # Build lookup: (date_yyyymmdd, rounded_amount) → True
    lookup: set[tuple] = set()
    for v in existing:
        if min_date <= v["date"] <= max_date:
            lookup.add((v["date"], round(v["amount"], 2)))

    print(f"Tally duplicate check: {len(lookup)} (date,amount) pairs in {min_date}..{max_date}")
    if lookup:
        sample = list(lookup)[:3]
        print(f"  Sample Tally lookup pairs: {sample}")

    for t in transactions:
        if t.get("is_duplicate"):
            continue
        date_key = _format_date(t.get("date", ""))
        amount_key = round(abs(float(t.get("amount", 0))), 2)
        if (date_key, amount_key) in lookup:
            t["is_duplicate"] = True
            t["approved"] = False

    return True


def submit_vouchers(company: str, vouchers: list[dict]) -> list[dict]:
    results = []
    for v in vouchers:
        result = _submit_single(company, v)
        results.append(result)
    return results


def _submit_single(company: str, v: dict) -> dict:
    try:
        date_str = _format_date(v["date"])
        amount = abs(float(v["amount"]))
        dr = v["dr_ledger"]
        cr = v["cr_ledger"]
        vtype = v.get("voucher_type", "Journal")
        narration = v.get("narration", "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

        xml = f"""<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>{company}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="{vtype}" ACTION="Create" OBJVIEW="Accounting Voucher View">
            <DATE>{date_str}</DATE>
            <NARRATION>{narration}</NARRATION>
            <VOUCHERTYPENAME>{vtype}</VOUCHERTYPENAME>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>{dr}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-{amount:.2f}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>{cr}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>{amount:.2f}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>"""

        root = _post(xml)
        # Check for errors in response
        error = root.findtext(".//LINEERROR") or root.findtext(".//IMPORTRESULT/ERRORS")
        if error:
            return {"id": v.get("id"), "success": False, "error": error.strip()}
        created = root.findtext(".//IMPORTRESULT/CREATED") or "1"
        if created.strip() == "0":
            altered = root.findtext(".//IMPORTRESULT/ALTERED") or "0"
            if altered.strip() == "0":
                return {"id": v.get("id"), "success": False, "error": "Tally returned 0 created/altered"}
        return {"id": v.get("id"), "success": True}
    except Exception as e:
        return {"id": v.get("id"), "success": False, "error": str(e)}


def _format_date(date_val) -> str:
    if isinstance(date_val, str):
        for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%Y-%m-%d", "%m/%d/%Y", "%d-%b-%Y", "%d %b %Y"):
            try:
                return datetime.strptime(date_val.strip(), fmt).strftime("%Y%m%d")
            except ValueError:
                continue
        return date_val.replace("-", "").replace("/", "")
    try:
        return date_val.strftime("%Y%m%d")
    except Exception:
        return str(date_val)
