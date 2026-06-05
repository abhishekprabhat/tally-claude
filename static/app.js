const API = "";
let transactions = [];
let ledgers = [];
let selectedFile = null;
let detectedBankInfo = "";
let detectedBankLedger = "";

// ── Init ────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  loadCompanies();
  bindEvents();
});

function bindEvents() {
  document.getElementById("uploadZone").addEventListener("click", () =>
    document.getElementById("fileInput").click()
  );
  document.getElementById("fileInput").addEventListener("change", (e) => {
    if (e.target.files[0]) selectFile(e.target.files[0]);
  });
  const zone = document.getElementById("uploadZone");
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drag-over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag-over");
    if (e.dataTransfer.files[0]) selectFile(e.dataTransfer.files[0]);
  });

  document.getElementById("companySelect").addEventListener("change", onCompanyChange);
  document.getElementById("refreshBtn").addEventListener("click", loadCompanies);
  document.getElementById("bankLedgerInput").addEventListener("change", (e) => {
    detectedBankLedger = e.target.value.trim();
  });
  document.getElementById("parseBtn").addEventListener("click", parseStatement);
  document.getElementById("suggestBtn").addEventListener("click", getSuggestions);
  document.getElementById("selectAllBtn").addEventListener("click", () => setAllApproved(true));
  document.getElementById("deselectAllBtn").addEventListener("click", () => setAllApproved(false));
  document.getElementById("submitBtn").addEventListener("click", submitToTally);

  // Tabs
  document.querySelectorAll(".tab-btn").forEach((btn) =>
    btn.addEventListener("click", () => switchTab(btn.dataset.tab))
  );

  // Reconciliation
  document.getElementById("reconBtn").addEventListener("click", runReconciliation);
  document.getElementById("reconExportBtn").addEventListener("click", exportReconCSV);
  document.querySelectorAll(".recon-filter-btn").forEach((btn) =>
    btn.addEventListener("click", () => setReconFilter(btn.dataset.filter))
  );

  // Records tab
  document.getElementById("newRecordBtn").addEventListener("click", () => {
    openRecordModal({}, null, "records_new");
  });
  document.getElementById("recordSearch").addEventListener("input", renderRecordsTable);
  document.getElementById("recordsExportBtn").addEventListener("click", exportRecordsCSV);

  // Payment History tab
  document.getElementById("historyApplyBtn").addEventListener("click", loadHistoryTab);
  document.getElementById("historyClearBtn").addEventListener("click", clearHistoryFilters);
  document.getElementById("historyExportBtn").addEventListener("click", exportHistoryCSV);

  // Modal
  document.getElementById("modalCancelBtn").addEventListener("click", closeRecordModal);
  document.getElementById("modalSaveBtn").addEventListener("click", saveRecord);
  document.getElementById("recordModal").addEventListener("click", (e) => {
    if (e.target.id === "recordModal") closeRecordModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.getElementById("recordModal").style.display === "flex")
      closeRecordModal();
  });
  // Dynamic sub-division based on selected location
  document.getElementById("modalLocation").addEventListener("input", updateSubDivisionList);
  document.getElementById("modalLocation").addEventListener("change", updateSubDivisionList);
}

// ── Companies & Ledgers ─────────────────────────────────────────────────────

async function loadCompanies() {
  const sel = document.getElementById("companySelect");
  sel.innerHTML = "<option>Loading...</option>";
  try {
    const data = await apiFetch("/api/tally/companies");
    sel.innerHTML = '<option value="">-- Select Company --</option>';
    data.forEach((c) => {
      const o = document.createElement("option");
      o.value = c.name;
      o.textContent = c.name;
      sel.appendChild(o);
    });
    if (data.length === 1) {
      sel.value = data[0].name;
      onCompanyChange();
    }
  } catch (e) {
    sel.innerHTML = '<option value="">Failed to load (is Tally running?)</option>';
    toast("Could not reach Tally at localhost:9000", "error");
  }
}

async function onCompanyChange() {
  const company = document.getElementById("companySelect").value;
  ledgers = [];
  if (!company) return;
  try {
    ledgers = await apiFetch(`/api/tally/ledgers?company=${encodeURIComponent(company)}`);
    // Populate shared datalist once
    const dl = document.getElementById("ledgerList");
    dl.innerHTML = ledgers.map(l => `<option value="${esc(l.name)}">`).join("");
    toast(`Loaded ${ledgers.length} ledgers`, "success");
    // Re-run bank ledger detection now that ledgers are available
    if (detectedBankInfo) updateBankLedgerField();
  } catch (e) {
    toast("Failed to load ledgers: " + e.message, "error");
  }
}

// ── Bank Ledger Auto-Detection ──────────────────────────────────────────────

function detectBankLedger(ledgerList, bankInfo) {
  if (!ledgerList.length || !bankInfo) return "";

  // Only look at ledgers under bank-related parent groups
  const bankLedgers = ledgerList.filter(l =>
    /bank/i.test(l.parent || "")
  );
  if (!bankLedgers.length) return "";

  const info = bankInfo.toLowerCase();

  // Extract account number from bankInfo — take last 4 and last 6 digits
  const acctMatch = bankInfo.match(/\d{6,}/);
  const acctLast4 = acctMatch ? acctMatch[0].slice(-4) : "";
  const acctLast6 = acctMatch ? acctMatch[0].slice(-6) : "";

  // Known Indian bank name keywords
  const bankKeywords = ["hdfc", "icici", "sbi", "axis", "kotak", "yes bank",
                        "idfc", "pnb", "bob", "canara", "union", "indusind",
                        "federal", "rbl", "bandhan", "au small"];
  const matchedBank = bankKeywords.find(b => info.includes(b)) || "";

  let best = null, bestScore = -1;
  for (const l of bankLedgers) {
    const name = l.name.toLowerCase();
    let score = 0;

    if (acctLast4 && name.includes(acctLast4)) score += 10;
    if (acctLast6 && name.includes(acctLast6)) score += 6;
    if (matchedBank && name.includes(matchedBank)) score += 4;
    // Boost common current/savings/OD account keywords
    if (/current|savings|cc\/od|occ|odc|cash credit/.test(name)) score += 1;

    if (score > bestScore) { bestScore = score; best = l.name; }
  }

  // Accept match if it scored by bank name or account digits; if only one bank ledger exists, use it
  if (bestScore >= 4) return best;
  if (bankLedgers.length === 1) return bankLedgers[0].name;
  return "";
}

function updateBankLedgerField() {
  if (!detectedBankInfo || !ledgers.length) return;
  const matched = detectBankLedger(ledgers, detectedBankInfo);
  detectedBankLedger = matched;
  const field = document.getElementById("bankLedgerField");
  const input = document.getElementById("bankLedgerInput");
  if (matched) {
    input.value = matched;
    input.style.color = "#166534";
    field.style.display = "block";
    toast(`Bank ledger matched: ${matched}`, "success");
  } else if (ledgers.length) {
    input.value = "";
    input.placeholder = "Could not auto-detect — select manually";
    input.style.color = "#92400e";
    field.style.display = "block";
  }
}

// ── File Selection ──────────────────────────────────────────────────────────

function selectFile(file) {
  selectedFile = file;
  const zone = document.getElementById("uploadZone");
  zone.innerHTML = `<div class="icon">✅</div><p><strong>${file.name}</strong></p><p>${(file.size / 1024).toFixed(1)} KB — click to change</p><input type="file" id="fileInput" accept=".csv,.xlsx,.xls" />`;
  document.getElementById("fileInput").addEventListener("change", (e) => {
    if (e.target.files[0]) selectFile(e.target.files[0]);
  });
  document.getElementById("actionsBar").style.display = "flex";
  transactions = [];
  renderTable();
}

// ── Step 1: Parse ───────────────────────────────────────────────────────────

async function parseStatement() {
  if (!selectedFile) return toast("Please upload a file first", "error");
  const company = document.getElementById("companySelect").value;
  if (!company) return toast("Please select a company", "error");

  const btn = document.getElementById("parseBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Parsing...';

  try {
    const company = document.getElementById("companySelect").value;
    const fd = new FormData();
    fd.append("file", selectedFile);
    if (company) fd.append("company", company);
    const parseResult = await apiFetch("/api/parse", { method: "POST", body: fd });
    transactions = parseResult.transactions.map(t => ({
      ...t,
      dr_ledger: "", cr_ledger: "", voucher_type: "", confidence: "", reason: "",
      approved: t.is_duplicate === true ? false : undefined,
    }));
    detectedBankInfo = parseResult.bank_info || "";

    if (detectedBankInfo) {
      document.getElementById("bankInfoField").style.display = "block";
      document.getElementById("bankInfoLabel").textContent = detectedBankInfo;
      updateBankLedgerField();
    }

    renderTable();
    updateSummary();
    document.getElementById("summaryBar").style.display = "flex";

    // Enable AI suggestion button now that we have transactions
    document.getElementById("suggestBtn").disabled = false;
    const dupCount = parseResult.duplicate_count || 0;
    const msg = dupCount
      ? `Parsed ${transactions.length} transactions (${dupCount} duplicates auto-unchecked) — click "Get AI Suggestions" to map ledgers`
      : `Parsed ${transactions.length} transactions — click "Get AI Suggestions" to map ledgers`;
    toast(msg, dupCount ? "error" : "info");
  } catch (e) {
    toast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = "⬆ Parse Statement";
  }
}

// ── Step 2: AI Suggestions ───────────────────────────────────────────────────

async function getSuggestions() {
  if (!transactions.length) return toast("Parse a statement first", "error");
  if (!ledgers.length) return toast("Ledgers not loaded yet", "error");

  const btn = document.getElementById("suggestBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Starting AI suggestions...';

  // Poll progress endpoint and update button label while waiting
  const progressInterval = setInterval(async () => {
    try {
      const p = await apiFetch("/api/suggest/progress");
      if (p.status === "running" && p.total > 0) {
        const retryNote = p.retrying ? " (rate limit — retrying…)" : "";
        btn.innerHTML = `<span class="spinner"></span> Batch ${p.batch}/${p.total}${retryNote}`;
      }
    } catch (_) {}
  }, 2000);

  try {
    const suggested = await apiFetch("/api/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transactions,
        ledgers,
        bank_info: detectedBankInfo,
        bank_ledger: detectedBankLedger,
        company: document.getElementById("companySelect").value,
      }),
    });

    transactions = suggested;
    renderTable();
    updateSummary();

    // Show select/deselect buttons
    document.getElementById("selectAllBtn").style.display = "inline-flex";
    document.getElementById("deselectAllBtn").style.display = "inline-flex";
    toast(`AI mapped ${transactions.length} transactions`, "success");
  } catch (e) {
    toast("Error: " + e.message, "error");
  } finally {
    clearInterval(progressInterval);
    btn.disabled = false;
    btn.innerHTML = "✨ Get AI Suggestions";
  }
}

// ── Table Rendering ─────────────────────────────────────────────────────────

function renderTable() {
  const wrap = document.getElementById("tableWrap");
  if (!transactions.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="icon">🏦</div><p>Upload a bank statement to get started</p></div>`;
    return;
  }

  const rows = transactions.map((t) => {
    const rowClass = t.submit_status === "ok" ? "row-submitted"
      : t.submit_status === "error" ? "row-error"
      : t.is_duplicate ? "row-duplicate"
      : t.approved ? "row-approved" : "";
    const amtClass = t.type === "debit" ? "debit" : "credit";
    const amtPrefix = t.type === "debit" ? "−" : "+";
    const statusBadge = t.submit_status === "ok"
      ? `<span class="status-badge badge-submitted">✓ Submitted</span>`
      : t.submit_status === "error"
      ? `<span class="status-badge badge-error" title="${esc(t.submit_error || '')}">✗ Error</span>`
      : t.approved
      ? `<span class="status-badge badge-approved">✓ Approved</span>`
      : `<span class="status-badge badge-pending">Pending</span>`;
    const confBadge = t.confidence
      ? `<span class="status-badge badge-${t.confidence}">${t.confidence}</span>` : "";
    const dupBadge = t.is_duplicate === true
      ? `<span class="status-badge badge-duplicate" title="Already recorded in Tally (same date &amp; amount)">Duplicate</span>`
      : t.is_duplicate === false
      ? `<span class="status-badge badge-new">New</span>`
      : `<span style="color:#aaa;font-size:11px">—</span>`;
    const disabled = t.submit_status === "ok" ? "disabled" : "";

    return `<tr class="${rowClass}" data-id="${t.id}">
      <td><input type="checkbox" class="approve-cb" data-id="${t.id}" ${t.approved ? "checked" : ""} ${disabled} /></td>
      <td>${esc(t.date)}</td>
      <td class="narration-cell" title="${esc(t.narration)}">${esc(t.narration)}</td>
      <td class="amount-cell ${amtClass}">${amtPrefix}₹${Number(t.amount).toLocaleString("en-IN", {minimumFractionDigits: 2})}</td>
      <td>${dupBadge}</td>
      <td><input type="text" class="ledger-select dr-input" list="ledgerList" data-id="${t.id}" value="${esc(t.dr_ledger || '')}" placeholder="Dr Ledger" ${disabled} /></td>
      <td><input type="text" class="ledger-select cr-input" list="ledgerList" data-id="${t.id}" value="${esc(t.cr_ledger || '')}" placeholder="Cr Ledger" ${disabled} /></td>
      <td>
        <select class="type-select vtype-select" data-id="${t.id}" ${disabled}>
          <option value="Payment" ${t.voucher_type==="Payment"?"selected":""}>Payment</option>
          <option value="Receipt" ${t.voucher_type==="Receipt"?"selected":""}>Receipt</option>
          <option value="Contra" ${t.voucher_type==="Contra"?"selected":""}>Contra</option>
          <option value="Journal" ${t.voucher_type==="Journal"?"selected":""}>Journal</option>
        </select>
      </td>
      <td>${confBadge}</td>
      <td class="reason-tip" title="${esc(t.reason || '')}">${esc(t.reason || '')}</td>
      <td>${statusBadge}</td>
    </tr>`;
  }).join("");

  wrap.innerHTML = `<table>
    <thead>
      <tr>
        <th>✓</th>
        <th>Date</th>
        <th>Narration</th>
        <th>Amount</th>
        <th>In Tally?</th>
        <th>Dr Ledger</th>
        <th>Cr Ledger</th>
        <th>Type</th>
        <th>Confidence</th>
        <th>AI Reason</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;

  // Bind change handlers
  wrap.querySelectorAll(".approve-cb").forEach((cb) =>
    cb.addEventListener("change", (e) => {
      const id = +e.target.dataset.id;
      const txn = transactions.find((t) => t.id === id);
      if (txn) txn.approved = e.target.checked;
      updateSubmitBtn();
      updateSummary();
      e.target.closest("tr").className = txn?.approved ? "row-approved" : "";
    })
  );
  wrap.querySelectorAll(".dr-input").forEach((inp) =>
    inp.addEventListener("change", (e) => {
      const txn = transactions.find((t) => t.id === +e.target.dataset.id);
      if (txn) txn.dr_ledger = e.target.value;
    })
  );
  wrap.querySelectorAll(".cr-input").forEach((inp) =>
    inp.addEventListener("change", (e) => {
      const txn = transactions.find((t) => t.id === +e.target.dataset.id);
      if (txn) txn.cr_ledger = e.target.value;
    })
  );
  wrap.querySelectorAll(".vtype-select").forEach((sel) =>
    sel.addEventListener("change", (e) => {
      const txn = transactions.find((t) => t.id === +e.target.dataset.id);
      if (txn) txn.voucher_type = e.target.value;
    })
  );

  updateSubmitBtn();
}

// ── Submit ───────────────────────────────────────────────────────────────────

async function submitToTally() {
  const company = document.getElementById("companySelect").value;
  if (!company) return toast("Select a company first", "error");

  const approved = transactions.filter((t) => t.approved && t.submit_status !== "ok");
  if (!approved.length) return toast("No approved transactions to submit", "error");

  // Validate
  const invalid = approved.filter((t) => !t.dr_ledger || !t.cr_ledger);
  if (invalid.length) return toast(`${invalid.length} transaction(s) missing Dr or Cr ledger`, "error");

  const btn = document.getElementById("submitBtn");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Submitting ${approved.length} vouchers...`;

  try {
    const results = await apiFetch("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company, vouchers: approved, bank_info: detectedBankInfo }),
    });

    let ok = 0, errors = 0;
    results.forEach((r) => {
      const txn = transactions.find((t) => t.id === r.id);
      if (!txn) return;
      if (r.success) {
        txn.submit_status = "ok";
        txn.approved = true;
        ok++;
      } else {
        txn.submit_status = "error";
        txn.submit_error = r.error;
        errors++;
      }
    });

    renderTable();
    updateSummary();

    if (errors === 0) toast(`All ${ok} vouchers submitted successfully!`, "success");
    else toast(`${ok} submitted, ${errors} failed`, errors > 0 ? "error" : "success");
  } catch (e) {
    toast("Submit failed: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = "▶ Submit to Tally";
    updateSubmitBtn();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function setAllApproved(val) {
  transactions.forEach((t) => {
    // "Select All" skips duplicates; "Deselect All" clears everything
    if (t.submit_status !== "ok" && (!val || !t.is_duplicate)) t.approved = val;
  });
  renderTable();
  updateSummary();
}

function updateSubmitBtn() {
  const hasApproved = transactions.some((t) => t.approved && t.submit_status !== "ok");
  document.getElementById("submitBtn").disabled = !hasApproved;
}

function updateSummary() {
  document.getElementById("sumTotal").textContent = transactions.length;
  document.getElementById("sumDuplicates").textContent = transactions.filter((t) => t.is_duplicate).length;
  document.getElementById("sumApproved").textContent = transactions.filter((t) => t.approved).length;
  document.getElementById("sumSubmitted").textContent = transactions.filter((t) => t.submit_status === "ok").length;
  document.getElementById("sumErrors").textContent = transactions.filter((t) => t.submit_status === "error").length;
}

async function apiFetch(path, opts = {}) {
  const resp = await fetch(API + path, opts);
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(text || resp.statusText); }
  if (!resp.ok) throw new Error(data.error || resp.statusText);
  return data;
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let toastTimer;
function toast(msg, type = "info") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ""; }, 3500);
}

// ── Tab Switching ─────────────────────────────────────────────────────────────

function switchTab(tab) {
  ["bank", "recon", "records", "history"].forEach((t) => {
    document.getElementById("tab" + t.charAt(0).toUpperCase() + t.slice(1)).style.display =
      t === tab ? "" : "none";
  });
  document.querySelectorAll(".tab-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab)
  );
  const bankOnly = ["bankInfoField", "bankLedgerField"];
  bankOnly.forEach((id) => {
    const el = document.getElementById(id);
    if (el && tab !== "bank") el.style.display = "none";
  });
  if (tab === "bank" && detectedBankInfo) updateBankLedgerField();
  if (tab === "records") loadRecordsTab();
  if (tab === "history") loadHistoryTab();
}

// ── Reconciliation ────────────────────────────────────────────────────────────

let reconData = null;
let reconFilter = "all";

async function runReconciliation() {
  const company = document.getElementById("companySelect").value;
  if (!company) return toast("Select a company first", "error");

  const btn = document.getElementById("reconBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Reconciling...';

  try {
    reconData = await apiFetch("/api/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company,
        bank_ledger: document.getElementById("reconBankLedger").value.trim(),
        from_date: document.getElementById("reconFrom").value,
        to_date: document.getElementById("reconTo").value,
      }),
    });

    reconFilter = "all";
    const s = reconData.summary;
    document.getElementById("reconSumSheet").textContent = s.total_sheet;
    document.getElementById("reconSumTally").textContent = s.total_tally;
    document.getElementById("reconSumMatched").textContent = s.matched;
    document.getElementById("reconSumSheetOnly").textContent = s.sheet_only;
    document.getElementById("reconSumTallyOnly").textContent = s.tally_only;
    document.getElementById("reconSumMismatch").textContent = s.amount_mismatch || 0;
    document.getElementById("reconSummaryBar").style.display = "flex";
    document.getElementById("reconFilterBar").style.display = "flex";
    document.getElementById("reconExportBtn").style.display = "inline-flex";
    document.querySelectorAll(".recon-filter-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.filter === "all")
    );
    renderReconTable();
    const mm = s.amount_mismatch || 0;
    toast(
      `Done — ${s.matched} matched, ${s.sheet_only} pending, ${s.tally_only} tally only${mm ? ", " + mm + " amt mismatch" : ""}`,
      (s.tally_only > 0 || mm > 0) ? "error" : "success"
    );
  } catch (e) {
    toast("Reconciliation failed: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = "Reconcile";
  }
}

function setReconFilter(f) {
  reconFilter = f;
  document.querySelectorAll(".recon-filter-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.filter === f)
  );
  renderReconTable();
}

function isTentative(r) {
  if (r._type !== "matched") return false;
  const tallyAmt  = r.tally_amount ?? r.amount;
  return Math.abs(tallyAmt - r.amount) >= 1;
}

function getFilteredReconRows() {
  if (!reconData) return [];
  const tallyRows = [
    ...reconData.matched.map((r) => ({ ...r, _type: "matched" })),
    ...reconData.tally_only.map((r) => ({ ...r, _type: "tally_only" })),
    ...(reconData.amount_mismatch || []).map((r) => ({ ...r, _type: "amount_mismatch" })),
  ].sort((a, b) => (a.date_key || "").localeCompare(b.date_key || ""));
  const pendingRows = (reconData.sheet_only || [])
    .map((r) => ({ ...r, _type: "pending" }))
    .sort((a, b) => (a.date_key || "").localeCompare(b.date_key || ""));

  if (reconFilter === "all")             return tallyRows;
  if (reconFilter === "pending")         return pendingRows;
  if (reconFilter === "tentative")       return tallyRows.filter(isTentative);
  if (reconFilter === "matched")         return tallyRows.filter((r) => r._type === "matched" && !isTentative(r));
  if (reconFilter === "tally_only")      return tallyRows.filter((r) => r._type === "tally_only");
  if (reconFilter === "amount_mismatch") return tallyRows.filter((r) => r._type === "amount_mismatch");
  return tallyRows;
}

let reconRowMap = {};

function _fmtAmt(n) {
  return "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 });
}

function renderReconTable() {
  const rows = getFilteredReconRows();
  const wrap = document.getElementById("reconTableWrap");

  if (!rows.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="icon">✅</div><p>No records in this category</p></div>`;
    return;
  }

  reconRowMap = {};

  const isPending = reconFilter === "pending";

  const tbody = rows.map((r) => {
    const type      = r._type;
    const tentative = isTentative(r);

    // ── Badge ──────────────────────────────────────────────────────────
    const badge = tentative
      ? `<span class="status-badge badge-tentative">Tentative</span>`
      : type === "matched"
      ? `<span class="status-badge badge-matched">Matched</span>`
      : type === "amount_mismatch"
      ? `<span class="status-badge badge-amount-mismatch">Amt Mismatch</span>`
      : type === "tally_only"
      ? `<span class="status-badge badge-tally-only">Tally Only</span>`
      : `<span class="status-badge badge-sheet-only">Pending</span>`;

    // ── Tally side ─────────────────────────────────────────────────────
    const tallyDate    = esc(r.date_raw || r.date_key || "");
    const tallyAmt     = type === "pending" ? "" : _fmtAmt(r.tally_amount ?? r.amount);
    const tallyPrf     = esc(r.tally_reference || "");
    const tallyNarr    = esc(r.tally_narration || "");

    let tallyAmtCell;
    if (type === "amount_mismatch") {
      tallyAmtCell = `<span class="mismatch-amt">${_fmtAmt(r.amount)}</span>`;
    } else if (type === "pending") {
      tallyAmtCell = `<span style="color:#bbb">—</span>`;
    } else {
      tallyAmtCell = tallyAmt;
    }

    const tallyNarrCell = type === "pending"
      ? `<span style="color:#bbb;font-style:italic">No Tally entry</span>`
      : `<span class="narration-cell" title="${tallyNarr}">${tallyNarr || "<span style='color:#bbb'>—</span>"}</span>`;

    // ── Record side ────────────────────────────────────────────────────
    const recPrf    = esc(r.prf_id || "");
    const recAmt    = (type === "matched" || type === "amount_mismatch" || type === "pending")
                      ? _fmtAmt(type === "amount_mismatch" ? r.record_amount : r.amount)
                      : "";
    const vendor    = esc(r.vendor || "");
    const nature    = esc(r.nature || "");
    const category  = esc(r.category || "");
    const location  = esc(r.location || "");
    const payStat   = r.status
      ? `<span class="status-badge" style="background:#e0e7ff;color:#3730a3;font-size:11px">${esc(r.status)}</span>`
      : "";

    const rcClass = tentative ? "rc-tentative"
      : type === "matched" ? "rc-matched"
      : type === "amount_mismatch" ? "rc-mismatch"
      : type === "pending" ? "rc-pending"
      : "rc-empty";

    let recContent, action;
    if (type === "tally_only") {
      recContent = `<td class="rc-empty recon-create-cell" colspan="3">
        <button class="btn btn-sm btn-outline add-inline-record-btn"
          data-date="${r.date_key}" data-amount="${r.amount}"
          data-guid="${esc(r.guid || '')}"
          data-narration="${esc(r.tally_narration || '')}">+ Create Record</button>
      </td><td class="rc-empty"></td>`;
    } else {
      if (r.record_id) {
        reconRowMap[r.record_id] = r;
        action = `<button class="btn btn-sm btn-outline edit-recon-record-btn" data-record-id="${r.record_id}">Edit</button>`;
      } else {
        action = "";
      }

      let recAmtCell = "";
      if (type === "amount_mismatch") {
        recAmtCell = `<span class="mismatch-rec-amt">${_fmtAmt(r.record_amount)}</span>`;
      } else if (type === "pending") {
        recAmtCell = `<span>${_fmtAmt(r.amount)}</span>`;
      }

      const subDiv    = esc(r.sub_division || "");
      const recAmtFmt = type === "amount_mismatch"
        ? `<span class="mismatch-rec-amt">${_fmtAmt(r.record_amount)}</span>`
        : tentative
        ? `<span>${_fmtAmt(r.amount)}</span><br><span class="tentative-tally-amt">Tally: ${_fmtAmt(r.tally_amount)}</span>`
        : `<span>${_fmtAmt(r.amount)}</span>`;

      // Build fine-print: Location · Sub-Division · Capital/Revenue
      const fpParts = [location, subDiv, category].filter(Boolean);
      const finePrint = fpParts.length
        ? `<div class="rec-fineprint">${fpParts.join(" · ")}</div>`
        : "";

      recContent = `
        <td class="${rcClass}" style="white-space:nowrap">${recAmtFmt}</td>
        <td class="${rcClass}"><span style="font-family:monospace;font-size:12px">${recPrf}</span></td>
        <td class="${rcClass} narration-cell" title="${nature}">${nature || "<span style='color:#bbb'>—</span>"}${finePrint}</td>
        <td class="${rcClass}">${action}</td>`;
    }

    return `<tr class="recon-row-${tentative ? "tentative" : type}">
      <td class="tc">${badge}</td>
      <td class="tc" style="white-space:nowrap">${tallyDate}</td>
      <td class="tc amount-cell">${tallyAmtCell}</td>
      <td class="tc"><span style="font-family:monospace;font-size:12px">${tallyPrf}</span></td>
      <td class="tc tc-sep narration-cell" title="${tallyNarr}">${tallyNarrCell}</td>
      ${recContent}
    </tr>`;
  }).join("");

  wrap.innerHTML = `<table class="recon-table">
    <thead>
      <tr class="recon-header-group">
        <th colspan="5" class="tally-group-header">Tally Entry</th>
        <th colspan="4" class="record-group-header">Matched Record</th>
      </tr>
      <tr>
        <th class="tc">Status</th>
        <th class="tc">Date</th>
        <th class="tc">Amount</th>
        <th class="tc">Tally PRF</th>
        <th class="tc tc-sep">Narration</th>
        <th>Amount</th>
        <th>PRF ID</th>
        <th>Nature of Work</th>
        <th></th>
      </tr>
    </thead>
    <tbody>${tbody}</tbody>
  </table>`;

  wrap.querySelectorAll(".add-inline-record-btn").forEach((btn) =>
    btn.addEventListener("click", () => openInlineForm(btn))
  );

  wrap.querySelectorAll(".edit-recon-record-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      const rec = reconRowMap[btn.dataset.recordId];
      if (rec) openRecordModal({ date: rec.date_key, ...rec }, rec.record_id, "recon_edit");
    })
  );
}

// ── Narration similarity matching ────────────────────────────────────────────

function _titleCase(s) {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// Find the best-matched already-reconciled row by narration word overlap.
// Returns the matched row object, or null if no match scores above threshold.
function _findSimilarMatch(narration) {
  if (!narration || !reconData?.matched?.length) return null;
  const stopWords = new Set(["the","and","for","with","from","neft","imps","rtgs","upi","hdfc","icici","sbi","axis","ref","no","to"]);
  const words = narration.toLowerCase().split(/[\s\-_\/,.@#]+/)
    .filter(w => w.length > 2 && !stopWords.has(w) && !/^\d+$/.test(w));
  if (!words.length) return null;
  const wordSet = new Set(words);

  let bestScore = 0, bestMatch = null;
  for (const r of reconData.matched) {
    if (!r.tally_narration || (!r.vendor && !r.nature)) continue;
    const rWords = r.tally_narration.toLowerCase().split(/[\s\-_\/,.@#]+/)
      .filter(w => w.length > 2 && !stopWords.has(w) && !/^\d+$/.test(w));
    if (!rWords.length) continue;
    const overlap = rWords.filter(w => wordSet.has(w)).length;
    const score = overlap / Math.max(wordSet.size, rWords.length);
    if (score > bestScore) { bestScore = score; bestMatch = r; }
  }
  return bestScore >= 0.3 ? bestMatch : null;
}

// ── Inline form open/save/cancel ─────────────────────────────────────────────

function _buildSubdivisionOptions(loc, selected) {
  const subs = SUBDIVISION_MAP[loc] || [];
  const opts = [`<option value="">Sub-Division...</option>`];
  for (const s of subs) {
    opts.push(`<option value="${esc(s)}"${s === selected ? " selected" : ""}>${esc(s)}</option>`);
  }
  return opts.join("");
}

function openInlineForm(btn) {
  const tallyTr = btn.closest("tr");
  // Close any already-open inline form
  const existing = tallyTr.parentElement.querySelector(".inline-form-row");
  if (existing) existing.remove();
  // Toggle off if same row clicked again
  if (tallyTr.dataset.inlineOpen === "1") {
    delete tallyTr.dataset.inlineOpen;
    btn.textContent = "+ Create Record";
    return;
  }
  tallyTr.dataset.inlineOpen = "1";
  btn.textContent = "✕ Cancel";

  const date   = btn.dataset.date;
  const amount = parseFloat(btn.dataset.amount);
  const guid   = btn.dataset.guid || "";
  const narr   = btn.dataset.narration || "";

  // Prefill from best-matching already-reconciled entry (by narration similarity)
  const sim = _findSimilarMatch(narr);
  const vendor    = sim?.vendor    || "";
  const nature    = sim?.nature    || "";
  const category  = sim?.category  || "";
  const location  = sim?.location  || "";
  const subDiv    = sim?.sub_division || "";

  const company = document.getElementById("companySelect").value;

  // Build location options
  const locationOpts = [`<option value="">Location...</option>`,
    ...Object.keys(SUBDIVISION_MAP).map(loc =>
      `<option value="${esc(loc)}"${loc === location ? " selected" : ""}>${esc(loc)}</option>`)
  ].join("");

  const formTr = document.createElement("tr");
  formTr.className = "inline-form-row";
  formTr.innerHTML = `
    <td colspan="12" class="inline-form-cell">
      <div class="inline-form">
        <span class="if-label">${date.replace(/(\d{4})(\d{2})(\d{2})/, "$3/$2/$1")} &nbsp; <strong>${_fmtAmt(amount)}</strong></span>
        <input  class="if-input if-vendor"    placeholder="Vendor"        value="${esc(vendor)}" />
        <input  class="if-input if-nature"    placeholder="Nature of Work" value="${esc(nature)}" />
        <select class="if-input if-category">
          <option value="Revenue Expenses"${category === "Revenue Expenses" ? " selected" : ""}>Revenue Expenses</option>
          <option value="Capital Expenses"${category === "Capital Expenses" ? " selected" : ""}>Capital Expenses</option>
        </select>
        <select class="if-input if-location">${locationOpts}</select>
        <select class="if-input if-subdivision">${_buildSubdivisionOptions(location, subDiv)}</select>
        <button class="btn btn-sm btn-primary if-save-btn">Save</button>
      </div>
      ${sim ? `<div style="font-size:11px;color:#6b7280;margin-top:4px;padding-left:4px">Prefilled from similar: <em>${esc(sim.tally_narration || "")}</em></div>` : ""}
    </td>`;

  tallyTr.after(formTr);

  // Cascade location → sub-division
  formTr.querySelector(".if-location").addEventListener("change", function () {
    formTr.querySelector(".if-subdivision").innerHTML = _buildSubdivisionOptions(this.value, "");
  });

  formTr.querySelector(".if-save-btn").addEventListener("click", async () => {
    const saveBtn = formTr.querySelector(".if-save-btn");
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    const payload = {
      company,
      date,
      amount,
      vendor:          formTr.querySelector(".if-vendor").value.trim(),
      nature:          formTr.querySelector(".if-nature").value.trim(),
      category:        formTr.querySelector(".if-category").value,
      location:        formTr.querySelector(".if-location").value.trim(),
      sub_division:    formTr.querySelector(".if-subdivision").value.trim(),
      payment_status:  "Processed",
      payment_done_required: "Already Done / Auto Debit",
      source:          "manual",
    };
    try {
      // Step 1: Create record (backend auto-generates REC-XXXX prf_id)
      const saved = await apiFetch("/api/records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      // Step 2: Write generated PRF ID back to Tally voucher's REFERENCE field
      if (guid && saved.prf_id) {
        try {
          await apiFetch("/api/tally/update-reference", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ company, guid, reference: saved.prf_id }),
          });
        } catch (tallyErr) {
          // Non-fatal — record was saved, just couldn't update Tally
          toast(`Record saved as ${saved.prf_id} (Tally update failed: ${tallyErr.message})`, "info");
          formTr.remove();
          tallyTr.remove();
          const el = document.getElementById("reconSumTallyOnly");
          if (el) el.textContent = Math.max(0, parseInt(el.textContent) - 1);
          return;
        }
      }
      toast(`Record saved: ${saved.prf_id || ""}`, "success");
      formTr.remove();
      tallyTr.remove();
      const el = document.getElementById("reconSumTallyOnly");
      if (el) el.textContent = Math.max(0, parseInt(el.textContent) - 1);
    } catch (e) {
      toast("Save failed: " + e.message, "error");
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    }
  });

  // Cancel
  btn.onclick = () => {
    formTr.remove();
    delete tallyTr.dataset.inlineOpen;
    btn.textContent = "+ Create Record";
    btn.onclick = () => openInlineForm(btn);
  };
}

function exportReconCSV() {
  const rows = getFilteredReconRows();
  if (!rows.length) return;
  const headers = ["Status", "Date", "Tally Amount", "Tally PRF", "Tally Narration", "Record PRF", "Record Amount", "Vendor", "Nature", "Category", "Location", "Pay Status"];
  const statusLabel = { matched: "Matched", pending: "Pending", tally_only: "Tally Only", amount_mismatch: "Amt Mismatch" };
  const csvLines = [
    headers.join(","),
    ...rows.map((r) => [
      statusLabel[r._type] || r._type,
      r.date_raw || r.date_key,
      r._type === "pending" ? "" : (r.tally_amount ?? r.amount),
      r.tally_reference || "",
      `"${(r.tally_narration || "").replace(/"/g, '""')}"`,
      r.prf_id || "",
      r._type === "amount_mismatch" ? r.record_amount : (r._type === "pending" ? r.amount : ""),
      `"${(r.vendor || "").replace(/"/g, '""')}"`,
      `"${(r.nature || "").replace(/"/g, '""')}"`,
      `"${(r.category || "").replace(/"/g, '""')}"`,
      `"${(r.location || "").replace(/"/g, '""')}"`,
      `"${(r.status || "").replace(/"/g, '""')}"`,
    ].join(","))
  ];
  const blob = new Blob([csvLines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `reconciliation_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ── Division → Sub-Division mapping (derived from Zoho sheet history) ─────────

const SUBDIVISION_MAP = {
  "Ayodhya":        ["Ayodhya - Others","Ayodhya - Office Expense","Ayodhya - Branding","Ayodhya - Mandir Share"],
  "Bageshwar Dham": ["Bageshwar Dham - Branding","Bageshwar Dham - Office Expense","Bageshwar Dham - Others","Bageshwar Dham - Mandir Share"],
  "Bhopal-Accounts":["Accounts - Others","Accounts - TDS","Accounts - GST","Accounts - Consultancy"],
  "Bhopal-BD":      ["BD - Travel","BD - Others"],
  "Bhopal-Content": ["Content - Others","Content - Software"],
  "Bhopal-Ecommerce":["Ecommerce - Ads","Ecommerce - Shipping","Ecommerce - Others"],
  "Bhopal-HO":      ["HO - Office Expense","HO - Others","HO - Rent"],
  "Bhopal-HR":      ["HR - Online Services","HR - Others","HR - Hospitality"],
  "Bhopal-Inventory":["Inventory - Others","Inventory - 6D Machines","Inventory - VR Headsets","Inventory - Packaging","Inventory - SenseXR","Inventory - Oculus"],
  "Bhopal-Kendra HO":["Kendra HO - Travel","Kendra HO - Branding"],
  "Bhopal-Tech":    ["Tech - Software Subscription","Tech - Others","Tech - Cloud"],
  "Delhi":          ["Delhi - Branding","Delhi - Office Expense"],
  "Delhi NCR":      ["Delhi - Branding","Delhi - Office Expense"],
  "Dewas":          ["Dewas - Mandir Share","Dewas - Branding"],
  "Haridwar":       ["Haridwar - Branding","Haridwar - Others","Haridwar - Office Expense","Haridwar - Mandir Share","Haridwar - Consumables"],
  "ISKCON-Delhi":   ["Delhi - Office Expense","Delhi - Branding"],
  "Kashi":          ["Kashi - Office Expense","Kashi - Branding","Kashi - Others","Kashi - Mandir Share","Kashi - Consumables"],
  "Kurukshetra":    ["Kurukshetra - Office Expense","Kurukshetra - Mandir Share","Kurukshetra - Others","Kurukshetra - Branding"],
  "Maihar":         ["Maihar - Branding","Maihar - Others","Maihar - Office Expense","Maihar - Consumables"],
  "Nagpur":         ["Nagpur - Branding","Nagpur - Others","Nagpur - Office Expense","Nagpur - Mandir Share"],
  "Neelkanth Dham": ["Neelkanth Dham - Office Expense","Neelkanth Dham - Mandir Share","Neelkanth Dham - Others","Neelkanth Dham - Branding"],
  "Prayagraj":      ["Prayagraj - Others"],
  "Salary":         ["Salary - Others","Salary - Net Payout","Salary - PF"],
  "Shirdi":         ["Shirdi - Office Expense","Shirdi - Others","Shirdi - Branding","Shirdi - Mandir Share"],
  "Ujjain":         ["Ujjain - Office Expense","Ujjain - Others","Ujjain - Mandir Rent","Ujjain - Branding","Ujjain - Consumables"],
  "Vaishno Devi":   ["Vaishnodevi - Office Expense","Vaishnodevi - Mandir Share","Vaishnodevi - Branding","Vaishnodevi - Others"],
  "Vertical Hotel": ["Vertical Hotel - Setup","Vertical Hotel - Travelling"],
  "Vertical Vehicle":["Vertical Vehicle - Setup"],
  "Vrindavan":      ["Vrindavan - Branding"],
};

function updateSubDivisionList() {
  const loc = document.getElementById("modalLocation").value.trim();
  const subs = SUBDIVISION_MAP[loc] || [];
  const subInput = document.getElementById("modalSubDivision");

  // Populate datalist
  document.getElementById("subDivisionList").innerHTML =
    subs.map((s) => `<option value="${esc(s)}">`).join("");

  // Clear stale value when switching to a known division
  if (subs.length > 0 && subInput.value && !subs.includes(subInput.value)) {
    subInput.value = "";
  }

  // Hint text (create once, reuse)
  let hint = document.getElementById("subDivisionHint");
  if (!hint) {
    hint = document.createElement("span");
    hint.id = "subDivisionHint";
    hint.className = "field-hint";
    subInput.parentElement.appendChild(hint);
  }

  if (!loc) {
    hint.textContent = "Select a location first";
    hint.style.color = "#9ca3af";
  } else if (subs.length > 0) {
    hint.textContent = `${subs.length} options available`;
    hint.style.color = "#16a34a";
    // Flash the input to signal the list just updated
    subInput.classList.remove("field-updated");
    void subInput.offsetWidth; // force reflow to restart animation
    subInput.classList.add("field-updated");
  } else {
    hint.textContent = "No predefined options — type freely";
    hint.style.color = "#92400e";
  }
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function dateKeyToInput(d) {
  d = String(d || "").replace(/-/g, "");
  if (d.length !== 8) return "";
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function formatDateKey(d) {
  d = String(d || "").replace(/-/g, "");
  if (d.length !== 8) return d;
  return `${d.slice(6, 8)}-${d.slice(4, 6)}-${d.slice(0, 4)}`;
}

function round2(n) { return Math.round(n * 100) / 100; }

// ── Record Modal ──────────────────────────────────────────────────────────────

let currentModalContext = null;

function openRecordModal(rowData, recordId = null, mode = "recon") {
  currentModalContext = { mode, rowData, recordId };

  const isEdit = !!recordId;
  document.getElementById("modalTitle").textContent = isEdit ? "Edit Payment Record" : "Payment Request Form";

  // Show PRF ID if editing
  const prfDisp = document.getElementById("modalPrfDisplay");
  prfDisp.textContent = isEdit && rowData.prf_id ? `ID: ${rowData.prf_id}` : (isEdit ? "" : "New request — ID will be auto-assigned");

  // Section 1: Request Details
  const dateKey = rowData.date_key || rowData.date || "";
  document.getElementById("modalDate").value = dateKeyToInput(dateKey);
  document.getElementById("modalLocation").value = rowData.location || "";
  updateSubDivisionList();   // populate datalist before setting the value
  document.getElementById("modalSubDivision").value = rowData.sub_division || "";
  document.getElementById("modalRaisedBy").value = rowData.raised_by || "";
  document.getElementById("modalMailId").value = rowData.mail_id || "";
  document.getElementById("modalPaymentDoneRequired").value = rowData.payment_done_required ||
    (mode === "recon" || mode === "recon_edit" ? "Already Done / Auto Debit" : "");

  // Section 2: Payment Details
  document.getElementById("modalNature").value = rowData.nature || "";
  document.getElementById("modalPaymentType").value = rowData.payment_type || "Full Payment";
  document.getElementById("modalPaymentHead").value = rowData.payment_head || "";
  document.getElementById("modalTotalInvoiceAmount").value = rowData.total_invoice_amount || "";
  document.getElementById("modalInvoiceType").value = rowData.invoice_type || "";
  document.getElementById("modalInvoiceRef").value = rowData.invoice_ref || "";
  document.getElementById("modalPaymentModeAvailable").value = rowData.payment_mode_available || "Bank Account";
  document.getElementById("modalPaymentPriority").value = rowData.payment_priority || "";

  // Section 3: Vendor
  document.getElementById("modalVendorType").value = rowData.vendor_type || "Already Added Old Vendor";
  document.getElementById("modalVendor").value = rowData.vendor || "";
  document.getElementById("modalVendorMobile").value = rowData.vendor_mobile || "";

  // Section 4: Approval
  document.getElementById("modalApprovedBy").value = rowData.approved_by || "";
  document.getElementById("modalRemarks").value = rowData.remarks || "";

  // Section 5: Accounts
  document.getElementById("modalPaymentStatus").value = rowData.payment_status ||
    (mode === "recon" || mode === "recon_edit" ? "Processed" : "Pending");
  document.getElementById("modalPaymentDate").value = dateKeyToInput(
    rowData.date_key || rowData.date || ""
  );
  document.getElementById("modalAmount").value = rowData.amount || "";
  document.getElementById("modalPaymentMode").value = rowData.payment_mode || "Bank Transfer";
  document.getElementById("modalCategory").value = rowData.category || "Revenue Expenses";
  document.getElementById("modalAccountsRemarks").value = rowData.accounts_remarks || rowData.tally_narration || rowData.narration || "";

  document.getElementById("recordModal").style.display = "flex";
  // Ensure hint is initialised for the current location (including empty state)
  updateSubDivisionList();
  setTimeout(() => document.getElementById("modalNature").focus(), 50);
}

function closeRecordModal() {
  document.getElementById("recordModal").style.display = "none";
  currentModalContext = null;
}

async function saveRecord() {
  const company = document.getElementById("companySelect").value;
  if (!company) return toast("Select a company first", "error");

  const ctx = currentModalContext;
  if (!ctx) return;

  const dateInput = document.getElementById("modalDate").value;
  if (!dateInput) return toast("Date is required", "error");

  const amount = parseFloat(document.getElementById("modalAmount").value);
  if (!amount || amount <= 0) return toast("Valid amount required in Accounts section", "error");

  const payload = {
    company,
    // Section 1
    date: dateInput,
    location: document.getElementById("modalLocation").value.trim(),
    sub_division: document.getElementById("modalSubDivision").value.trim(),
    raised_by: document.getElementById("modalRaisedBy").value.trim(),
    mail_id: document.getElementById("modalMailId").value.trim(),
    payment_done_required: document.getElementById("modalPaymentDoneRequired").value,
    // Section 2
    nature: document.getElementById("modalNature").value.trim(),
    payment_type: document.getElementById("modalPaymentType").value,
    payment_head: document.getElementById("modalPaymentHead").value.trim(),
    total_invoice_amount: parseFloat(document.getElementById("modalTotalInvoiceAmount").value) || 0,
    invoice_type: document.getElementById("modalInvoiceType").value,
    invoice_ref: document.getElementById("modalInvoiceRef").value.trim(),
    payment_mode_available: document.getElementById("modalPaymentModeAvailable").value,
    payment_priority: document.getElementById("modalPaymentPriority").value,
    // Section 3
    vendor_type: document.getElementById("modalVendorType").value,
    vendor: document.getElementById("modalVendor").value.trim(),
    vendor_mobile: document.getElementById("modalVendorMobile").value.trim(),
    // Section 4
    approved_by: document.getElementById("modalApprovedBy").value.trim(),
    remarks: document.getElementById("modalRemarks").value.trim(),
    // Section 5 (Accounts)
    payment_status: document.getElementById("modalPaymentStatus").value,
    amount,
    payment_mode: document.getElementById("modalPaymentMode").value,
    category: document.getElementById("modalCategory").value,
    accounts_remarks: document.getElementById("modalAccountsRemarks").value.trim(),
    source: "manual",
  };
  if (ctx.recordId) payload.id = ctx.recordId;

  const btn = document.getElementById("modalSaveBtn");
  btn.disabled = true;
  btn.textContent = "Saving...";

  try {
    const method = ctx.recordId ? "PUT" : "POST";
    const url = ctx.recordId ? `/api/records/${ctx.recordId}` : "/api/records";
    const saved = await apiFetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    toast(ctx.recordId ? "Record updated" : "Record saved", "success");
    closeRecordModal();

    if (ctx.mode === "recon") {
      const dateKey = dateInput.replace(/-/g, "");
      const amt = round2(parseFloat(ctx.rowData.amount || amount));
      const idx = (reconData.tally_only || []).findIndex(
        (r) => r.date_key === dateKey && round2(r.amount) === amt
      );
      if (idx !== -1) {
        const row = reconData.tally_only.splice(idx, 1)[0];
        if (!reconData.local_record) reconData.local_record = [];
        reconData.local_record.push({ ...row, ...saved, record_id: saved.id });
        reconData.summary.tally_only = Math.max(0, (reconData.summary.tally_only || 1) - 1);
        reconData.summary.local_record = (reconData.summary.local_record || 0) + 1;
        document.getElementById("reconSumTallyOnly").textContent = reconData.summary.tally_only;
        document.getElementById("reconSumLocalRecord").textContent = reconData.summary.local_record;
        renderReconTable();
      }
    } else if (ctx.mode === "recon_edit") {
      const idx = (reconData.local_record || []).findIndex((r) => r.record_id === ctx.recordId);
      if (idx !== -1) {
        reconData.local_record[idx] = { ...reconData.local_record[idx], ...saved, record_id: saved.id };
        renderReconTable();
      }
    } else {
      await loadRecordsTab();
    }
  } catch (e) {
    toast("Save failed: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Record";
  }
}

// ── Payment Records Tab ───────────────────────────────────────────────────────

let allRecords = [];

async function loadRecordsTab() {
  const company = document.getElementById("companySelect").value;
  const wrap = document.getElementById("recordsTableWrap");
  if (!company) {
    wrap.innerHTML = `<div class="empty-state"><div class="icon">📋</div><p>Select a company to view payment records</p></div>`;
    return;
  }
  try {
    allRecords = await apiFetch(`/api/records?company=${encodeURIComponent(company)}`);
    renderRecordsTable();
  } catch (e) {
    toast("Failed to load records: " + e.message, "error");
  }
}

function renderRecordsTable() {
  const wrap = document.getElementById("recordsTableWrap");
  const q = (document.getElementById("recordSearch").value || "").toLowerCase();
  const filtered = allRecords.filter((r) =>
    !q || [r.vendor, r.category, r.nature, r.location, r.prf_id, r.payment_head, r.raised_by, r.sub_division, r.accounts_remarks]
      .some((f) => (f || "").toLowerCase().includes(q))
  );

  if (!filtered.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="icon">📋</div><p>${allRecords.length ? "No matching records" : "No records yet — use the Reconciliation tab to add records for Tally-only payments"}</p></div>`;
    return;
  }

  const statusStyle = {
    Processed: "background:#d1fae5;color:#065f46",
    Pending:   "background:#fef3c7;color:#92400e",
    Rejected:  "background:#fee2e2;color:#991b1b",
  };

  const tbody = filtered.map((r) => {
    const statusBadge = r.payment_status
      ? `<span class="status-badge" style="${statusStyle[r.payment_status] || "background:#e5e7eb;color:#374151"}">${esc(r.payment_status)}</span>`
      : `<span style="color:#aaa">—</span>`;
    const priorityBadge = r.payment_priority
      ? `<span class="status-badge" style="background:#ede9fe;color:#5b21b6;font-size:11px">${esc(r.payment_priority)}</span>`
      : "";
    return `<tr>
      <td style="white-space:nowrap"><span style="font-family:monospace;font-size:12px;color:#4f6ef7">${esc(r.prf_id)}</span></td>
      <td style="white-space:nowrap">${formatDateKey(r.date)}</td>
      <td class="amount-cell">₹${Number(r.amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
      <td class="narration-cell" title="${esc(r.vendor)}">${esc(r.vendor) || "<span style='color:#aaa'>—</span>"}</td>
      <td class="narration-cell" title="${esc(r.nature)}">${esc(r.nature) || "<span style='color:#aaa'>—</span>"}</td>
      <td>${esc(r.location) || "<span style='color:#aaa'>—</span>"}</td>
      <td style="font-size:12px;color:#555">${esc(r.sub_division) || "<span style='color:#aaa'>—</span>"}</td>
      <td>${esc(r.payment_head) || "<span style='color:#aaa'>—</span>"}</td>
      <td>${statusBadge} ${priorityBadge}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-sm btn-outline edit-record-btn" data-id="${r.id}" style="margin-right:4px">Edit</button>
        <button class="btn btn-sm del-record-btn" data-id="${r.id}" style="background:#fee2e2;color:#991b1b;border:none">Delete</button>
      </td>
    </tr>`;
  }).join("");

  wrap.innerHTML = `<table>
    <thead>
      <tr>
        <th>PRF ID</th><th>Date</th><th>Amount</th><th>Vendor</th>
        <th>Nature of Work</th><th>Location</th><th>Sub-Division</th>
        <th>Payment Head</th><th>Status</th><th>Actions</th>
      </tr>
    </thead>
    <tbody>${tbody}</tbody>
  </table>`;

  wrap.querySelectorAll(".edit-record-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      const rec = allRecords.find((r) => r.id === btn.dataset.id);
      if (rec) openRecordModal(rec, rec.id, "records_edit");
    })
  );

  wrap.querySelectorAll(".del-record-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this record?")) return;
      try {
        await apiFetch(`/api/records/${btn.dataset.id}`, { method: "DELETE" });
        allRecords = allRecords.filter((r) => r.id !== btn.dataset.id);
        renderRecordsTable();
        toast("Record deleted", "success");
      } catch (e) {
        toast("Delete failed: " + e.message, "error");
      }
    })
  );
}

// ── Payment History Tab ───────────────────────────────────────────────────────

let historyRecords = [];

async function importFromZoho() {
  const company = document.getElementById("companySelect").value;
  if (!company) return toast("Select a company first", "error");
  const sheetUrl = document.getElementById("historySheetUrl").value.trim();
  if (!sheetUrl) return toast("Enter the Google Sheet URL", "error");

  const btn = document.getElementById("importZohoBtn");
  const status = document.getElementById("importStatus");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Importing...';
  status.textContent = "Fetching sheet data…";

  try {
    const result = await apiFetch("/api/import/zoho", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company, sheet_url: sheetUrl }),
    });
    const msg = `✓ ${result.imported} new, ${result.updated} updated, ${result.skipped} skipped${result.errors ? ", " + result.errors + " errors" : ""}`;
    status.textContent = msg;
    status.style.color = result.errors ? "#dc2626" : "#16a34a";
    toast(msg, result.errors ? "error" : "success");
    await loadHistoryTab();
  } catch (e) {
    status.textContent = "Import failed: " + e.message;
    status.style.color = "#dc2626";
    toast("Import failed: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = "⬇ Import from Zoho Sheet";
  }
}

async function loadHistoryTab() {
  const company = document.getElementById("companySelect").value;
  if (!company) {
    document.getElementById("historyTableWrap").innerHTML =
      `<div class="empty-state"><div class="icon">📜</div><p>Select a company to view payment history</p></div>`;
    return;
  }

  const from  = document.getElementById("historyFrom").value;
  const to    = document.getElementById("historyTo").value;
  const status  = document.getElementById("historyStatus").value;
  const location = document.getElementById("historyLocation").value.trim();
  const source  = document.getElementById("historySource").value;

  const wrap = document.getElementById("historyTableWrap");
  wrap.innerHTML = `<div class="empty-state"><span class="spinner dark"></span><p style="margin-top:12px">Loading records…</p></div>`;

  try {
    const params = new URLSearchParams({ company });
    if (from)     params.set("from", from);
    if (to)       params.set("to", to);
    if (status)   params.set("status", status);
    if (location) params.set("location", location);
    if (source)   params.set("source", source);

    historyRecords = await apiFetch(`/api/records?${params}`);
    renderHistoryTable();
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state"><p style="color:#dc2626">Failed: ${esc(e.message)}</p></div>`;
    toast("Load failed: " + e.message, "error");
  }
}

function renderHistoryTable() {
  const wrap = document.getElementById("historyTableWrap");

  if (!historyRecords.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="icon">📜</div><p>No records found for the selected filters</p></div>`;
    document.getElementById("historySummaryBar").style.display = "none";
    document.getElementById("historyExportBtn").style.display = "none";
    return;
  }

  // Summary
  const total   = historyRecords.length;
  const totalAmt = historyRecords.reduce((s, r) => s + (r.amount || 0), 0);
  const processed = historyRecords.filter((r) => r.payment_status === "Processed").length;
  const pending   = historyRecords.filter((r) => !r.payment_status || r.payment_status === "Pending").length;
  const zoho      = historyRecords.filter((r) => r.source === "zoho_import").length;
  const manual    = historyRecords.filter((r) => r.source === "manual").length;

  document.getElementById("histSumTotal").textContent     = total;
  document.getElementById("histSumAmount").textContent    = "₹" + totalAmt.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  document.getElementById("histSumProcessed").textContent = processed;
  document.getElementById("histSumPending").textContent   = pending;
  document.getElementById("histSumZoho").textContent      = zoho;
  document.getElementById("histSumManual").textContent    = manual;
  document.getElementById("historySummaryBar").style.display = "flex";
  document.getElementById("historyExportBtn").style.display  = "inline-flex";

  const statusStyle = {
    Processed: "background:#d1fae5;color:#065f46",
    Pending:   "background:#fef3c7;color:#92400e",
    Rejected:  "background:#fee2e2;color:#991b1b",
  };

  const tbody = historyRecords.map((r) => {
    const statusBadge = r.payment_status
      ? `<span class="status-badge" style="${statusStyle[r.payment_status] || "background:#e5e7eb;color:#374151"}">${esc(r.payment_status)}</span>`
      : `<span style="color:#aaa">—</span>`;
    const sourceBadge = r.source === "zoho_import"
      ? `<span class="status-badge" style="background:#e0e7ff;color:#3730a3;font-size:11px">Zoho</span>`
      : `<span class="status-badge" style="background:#f0fdf4;color:#166534;font-size:11px">Manual</span>`;
    return `<tr>
      <td><span style="font-family:monospace;font-size:12px;color:#4f6ef7">${esc(r.prf_id)}</span></td>
      <td style="white-space:nowrap">${formatDateKey(r.date)}</td>
      <td class="amount-cell">₹${Number(r.amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
      <td class="narration-cell" title="${esc(r.vendor)}">${esc(r.vendor) || "<span style='color:#aaa'>—</span>"}</td>
      <td class="narration-cell" title="${esc(r.nature)}">${esc(r.nature) || "<span style='color:#aaa'>—</span>"}</td>
      <td>${esc(r.location) || "<span style='color:#aaa'>—</span>"}</td>
      <td style="font-size:12px;color:#555">${esc(r.sub_division) || "<span style='color:#aaa'>—</span>"}</td>
      <td>${esc(r.payment_head) || "<span style='color:#aaa'>—</span>"}</td>
      <td style="font-size:12px">${esc(r.raised_by) || "<span style='color:#aaa'>—</span>"}</td>
      <td>${statusBadge}</td>
      <td>${sourceBadge}</td>
    </tr>`;
  }).join("");

  wrap.innerHTML = `<table>
    <thead>
      <tr>
        <th>PRF ID</th><th>Date</th><th>Amount</th><th>Vendor</th>
        <th>Nature of Work</th><th>Location</th><th>Sub-Division</th>
        <th>Payment Head</th><th>Raised By</th><th>Status</th><th>Source</th>
      </tr>
    </thead>
    <tbody>${tbody}</tbody>
  </table>`;
}

function clearHistoryFilters() {
  ["historyFrom", "historyTo", "historyLocation"].forEach((id) => {
    document.getElementById(id).value = "";
  });
  document.getElementById("historyStatus").value = "";
  document.getElementById("historySource").value = "";
  loadHistoryTab();
}

function exportHistoryCSV() {
  if (!historyRecords.length) return;
  const headers = [
    "PRF ID", "Date", "Amount", "Vendor", "Nature of Work", "Location",
    "Sub-Division", "Payment Head", "Raised By", "Mail ID",
    "Payment Done/Required", "Payment Type", "Invoice Type", "Invoice Ref",
    "Vendor Mobile", "Payment Priority", "Approved By",
    "Payment Status", "Payment Mode (Accounts)", "Expense Category",
    "Accounts Remarks", "Source",
  ];
  const q = (r, f) => `"${(r[f] || "").replace(/"/g, '""')}"`;
  const csvLines = [
    headers.join(","),
    ...historyRecords.map((r) => [
      r.prf_id, formatDateKey(r.date), r.amount || 0,
      q(r, "vendor"), q(r, "nature"), q(r, "location"),
      q(r, "sub_division"), q(r, "payment_head"), q(r, "raised_by"), r.mail_id,
      r.payment_done_required, r.payment_type, r.invoice_type, r.invoice_ref,
      r.vendor_mobile, r.payment_priority, q(r, "approved_by"),
      r.payment_status, r.payment_mode, r.category,
      q(r, "accounts_remarks"), r.source,
    ].join(","))
  ];
  const blob = new Blob([csvLines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `payment_history_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

function exportRecordsCSV() {
  const q = (document.getElementById("recordSearch").value || "").toLowerCase();
  const filtered = allRecords.filter((r) =>
    !q || [r.vendor, r.category, r.nature, r.location, r.prf_id, r.payment_head, r.raised_by]
      .some((f) => (f || "").toLowerCase().includes(q))
  );
  if (!filtered.length) return;
  const headers = [
    "PRF ID", "Date", "Location", "Sub-Division", "Raised By", "Mail ID",
    "Nature of Work", "Payment Done/Required", "Payment Type", "Payment Head",
    "Total Invoice Amount", "Invoice Type", "Invoice Ref",
    "Vendor Type", "Vendor Name", "Vendor Mobile",
    "Payment Priority", "Approved By", "Remarks",
    "Payment Status", "Payment Date (Accounts)", "Amount Paid",
    "Payment Mode (Accounts)", "Expense Category", "Accounts Remarks",
  ];
  const q2 = (r, f) => `"${(r[f] || "").replace(/"/g, '""')}"`;
  const csvLines = [
    headers.join(","),
    ...filtered.map((r) => [
      r.prf_id, formatDateKey(r.date),
      q2(r, "location"), q2(r, "sub_division"), q2(r, "raised_by"), r.mail_id,
      q2(r, "nature"), r.payment_done_required, r.payment_type, q2(r, "payment_head"),
      r.total_invoice_amount, r.invoice_type, r.invoice_ref,
      r.vendor_type, q2(r, "vendor"), r.vendor_mobile,
      r.payment_priority, q2(r, "approved_by"), q2(r, "remarks"),
      r.payment_status, formatDateKey(r.date), r.amount,
      r.payment_mode, r.category, q2(r, "accounts_remarks"),
    ].join(","))
  ];
  const blob = new Blob([csvLines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `payment_records_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}
