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
  document.getElementById("tabBank").style.display = tab === "bank" ? "" : "none";
  document.getElementById("tabRecon").style.display = tab === "recon" ? "" : "none";
  document.querySelectorAll(".tab-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab)
  );
  // Show/hide bank-specific fields in setup bar
  const bankOnly = ["bankInfoField", "bankLedgerField"];
  bankOnly.forEach((id) => {
    const el = document.getElementById(id);
    if (el && tab !== "bank") el.style.display = "none";
  });
  if (tab === "bank" && detectedBankInfo) updateBankLedgerField();
}

// ── Reconciliation ────────────────────────────────────────────────────────────

let reconData = null;
let reconFilter = "all";

async function runReconciliation() {
  const company = document.getElementById("companySelect").value;
  if (!company) return toast("Select a company first", "error");
  const sheetUrl = document.getElementById("sheetUrl").value.trim();
  if (!sheetUrl) return toast("Enter the Google Sheet URL", "error");

  const btn = document.getElementById("reconBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Reconciling...';

  try {
    reconData = await apiFetch("/api/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company,
        sheet_url: sheetUrl,
        sheet_name: document.getElementById("sheetTab").value,
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
    document.getElementById("reconSummaryBar").style.display = "flex";
    document.getElementById("reconFilterBar").style.display = "flex";
    document.getElementById("reconExportBtn").style.display = "inline-flex";
    document.querySelectorAll(".recon-filter-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.filter === "all")
    );
    renderReconTable();
    toast(`Done — ${s.matched} matched, ${s.sheet_only} missing from Tally, ${s.tally_only} not in sheet`,
      s.sheet_only > 0 ? "error" : "success");
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

function getFilteredReconRows() {
  if (!reconData) return [];
  const all = [
    ...reconData.matched.map((r) => ({ ...r, _type: "matched" })),
    ...reconData.sheet_only.map((r) => ({ ...r, _type: "sheet_only" })),
    ...reconData.tally_only.map((r) => ({ ...r, _type: "tally_only" })),
  ].sort((a, b) => (a.date_key || "").localeCompare(b.date_key || ""));
  return reconFilter === "all" ? all : all.filter((r) => r._type === reconFilter);
}

function renderReconTable() {
  const rows = getFilteredReconRows();
  const wrap = document.getElementById("reconTableWrap");

  if (!rows.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="icon">✅</div><p>No records in this category</p></div>`;
    return;
  }

  const tbody = rows.map((r) => {
    const rowClass = r._type === "matched" ? "row-matched"
      : r._type === "sheet_only" ? "row-sheet-only"
      : "row-tally-only";
    const badge = r._type === "matched"
      ? `<span class="status-badge badge-matched">Matched</span>`
      : r._type === "sheet_only"
      ? `<span class="status-badge badge-sheet-only">Missing from Tally</span>`
      : `<span class="status-badge badge-tally-only">Not in Sheet</span>`;
    const description = esc(r.nature || r.tally_narration || "");
    const formStatus = r.status
      ? `<span class="status-badge" style="background:#e0e7ff;color:#3730a3">${esc(r.status)}</span>`
      : `<span style="color:#aaa">—</span>`;
    return `<tr class="${rowClass}">
      <td>${badge}</td>
      <td style="white-space:nowrap">${esc(r.date_raw || r.date_key)}</td>
      <td class="amount-cell">₹${Number(r.amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
      <td><span style="font-family:monospace;font-size:12px">${esc(r.prf_id)}</span></td>
      <td class="narration-cell" title="${esc(r.vendor)}">${esc(r.vendor) || "<span style='color:#aaa'>—</span>"}</td>
      <td class="narration-cell" title="${description}">${description || "<span style='color:#aaa'>—</span>"}</td>
      <td>${esc(r.category) || "<span style='color:#aaa'>—</span>"}</td>
      <td style="font-size:12px;color:#555">${esc(r.location)}</td>
      <td class="narration-cell" title="${esc(r.tally_narration)}">${esc(r.tally_narration) || "<span style='color:#aaa'>—</span>"}</td>
      <td>${formStatus}</td>
    </tr>`;
  }).join("");

  wrap.innerHTML = `<table>
    <thead>
      <tr>
        <th>Status</th><th>Date</th><th>Amount</th><th>PRF ID</th>
        <th>Vendor</th><th>Description</th><th>Category</th>
        <th>Location</th><th>Tally Narration</th><th>Form Status</th>
      </tr>
    </thead>
    <tbody>${tbody}</tbody>
  </table>`;
}

function exportReconCSV() {
  const rows = getFilteredReconRows();
  if (!rows.length) return;
  const headers = ["Status", "Date", "Amount", "PRF ID", "Vendor", "Description", "Category", "Location", "Tally Narration", "Form Status"];
  const csvLines = [
    headers.join(","),
    ...rows.map((r) => [
      r._type === "matched" ? "Matched" : r._type === "sheet_only" ? "Missing from Tally" : "Not in Sheet",
      r.date_raw || r.date_key,
      r.amount,
      r.prf_id,
      `"${(r.vendor || "").replace(/"/g, '""')}"`,
      `"${(r.nature || r.tally_narration || "").replace(/"/g, '""')}"`,
      `"${(r.category || "").replace(/"/g, '""')}"`,
      `"${(r.location || "").replace(/"/g, '""')}"`,
      `"${(r.tally_narration || "").replace(/"/g, '""')}"`,
      `"${(r.status || "").replace(/"/g, '""')}"`,
    ].join(","))
  ];
  const blob = new Blob([csvLines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `reconciliation_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}
