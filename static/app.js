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
