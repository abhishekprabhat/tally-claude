import os
import traceback
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()

import tally
import statement_parser as stmt_parser
import ai
import submissions as sub_store
import mappings as mapping_store
import recon as recon_mod

app = Flask(__name__, static_folder="static")
CORS(app)


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/api/tally/companies")
def get_companies():
    try:
        companies = tally.get_companies()
        return jsonify(companies)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/tally/ledgers")
def get_ledgers():
    company = request.args.get("company", "")
    if not company:
        return jsonify({"error": "company parameter required"}), 400
    try:
        ledgers = tally.get_ledgers(company)
        return jsonify(ledgers)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/parse", methods=["POST"])
def parse_statement():
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "No filename"}), 400
    company = request.form.get("company", "")
    try:
        transactions, bank_info = stmt_parser.parse_statement(f.read(), f.filename)
        duplicate_count = 0
        if company and transactions:
            # Primary: check against actual Tally vouchers (catches manually entered ones)
            tally.mark_tally_duplicates(company, transactions)
            # Supplement: local store catches app-submitted ones and uses closing_balance for precision
            sub_store.mark_duplicates(company, bank_info, transactions)
            duplicate_count = sum(1 for t in transactions if t.get("is_duplicate"))
            print(f"Duplicate check: {duplicate_count} duplicates found out of {len(transactions)}")
        return jsonify({"transactions": transactions, "bank_info": bank_info, "duplicate_count": duplicate_count})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/suggest/progress")
def suggest_progress():
    return jsonify(ai.get_progress())


@app.route("/api/suggest", methods=["POST"])
def suggest():
    data = request.json
    transactions = data.get("transactions", [])
    ledgers = data.get("ledgers", [])
    bank_info = data.get("bank_info", "")
    bank_ledger = data.get("bank_ledger", "")
    company = data.get("company", "")
    print(f"Suggest called: {len(transactions)} transactions, {len(ledgers)} ledgers, company='{company}', bank_ledger='{bank_ledger}'")
    if not transactions:
        return jsonify({"error": "No transactions provided"}), 400
    if not ledgers:
        return jsonify({"error": "No ledgers provided"}), 400
    try:
        suggestions = ai.suggest_ledgers(transactions, ledgers, bank_info, bank_ledger, company)
        return jsonify(suggestions)
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/submit", methods=["POST"])
def submit():
    data = request.json
    company = data.get("company", "")
    vouchers = data.get("vouchers", [])
    bank_info = data.get("bank_info", "")
    if not company:
        return jsonify({"error": "company required"}), 400
    if not vouchers:
        return jsonify({"error": "No vouchers to submit"}), 400
    try:
        results = tally.submit_vouchers(company, vouchers)
        # Record successfully submitted transactions for duplicate detection and learning
        submitted_ok = [v for v, r in zip(vouchers, results) if r.get("success")]
        if submitted_ok:
            sub_store.record_submitted(company, bank_info, submitted_ok)
            mapping_store.record_mappings(company, submitted_ok)
        return jsonify(results)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/debug/sheet")
def debug_sheet():
    url = request.args.get("url", "")
    if not url:
        return jsonify({"error": "url param required"}), 400
    try:
        csv_url = recon_mod._csv_url(url)
        import requests as req, csv, io
        resp = req.get(csv_url, timeout=30)
        resp.raise_for_status()
        reader = csv.DictReader(io.StringIO(resp.text))
        rows = list(reader)
        headers = reader.fieldnames or []
        sample = rows[:5] if rows else []
        return jsonify({"headers": headers, "total_rows": len(rows), "sample": sample})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/reconcile", methods=["POST"])
def run_reconcile():
    data = request.json
    company = data.get("company", "")
    sheet_url = data.get("sheet_url", "")
    from_date = data.get("from_date", "")
    to_date = data.get("to_date", "")
    if not company:
        return jsonify({"error": "company required"}), 400
    if not sheet_url:
        return jsonify({"error": "sheet_url required"}), 400
    try:
        sheet_name = data.get("sheet_name", "")
        sheet_payments = recon_mod.fetch_sheet_payments(sheet_url, sheet_name)
        # Apply user date filter (HTML date input gives YYYY-MM-DD)
        from_key = from_date.replace("-", "") if from_date else ""
        to_key = to_date.replace("-", "") if to_date else ""
        if from_key or to_key:
            sheet_payments = [
                p for p in sheet_payments
                if (not from_key or p["date_key"] >= from_key)
                and (not to_key or p["date_key"] <= to_key)
            ]
        # Fetch Tally vouchers, filter to the sheet's date range
        tally_vouchers = tally.get_existing_vouchers(company)
        if sheet_payments:
            dates = [p["date_key"] for p in sheet_payments if p["date_key"]]
            lo, hi = min(dates), max(dates)
        elif from_key or to_key:
            lo = from_key or "19000101"
            hi = to_key or "29991231"
        else:
            lo, hi = "", ""
        if lo and hi:
            tally_vouchers = [v for v in tally_vouchers if lo <= v["date"] <= hi]
        result = recon_mod.reconcile(sheet_payments, tally_vouchers)
        print(f"Reconcile: {result['summary']}")
        return jsonify(result)
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(debug=True, port=5000, use_reloader=False, threaded=True)
