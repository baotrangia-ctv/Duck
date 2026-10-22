const state = { messages: [], google: null, user: null };
const $ = (selector) => document.querySelector(selector);

$("#webhookUrl").textContent = `${window.location.origin}/callback`;

async function apiFetch(input, options) {
  const response = await fetch(input, options);
  if (response.status === 401) window.location.assign("/login");
  return response;
}

function applyUser(user) {
  state.user = user;
  const sessionPanel = $("#sessionPanel");
  sessionPanel.hidden = !user;
  if (user) {
    const roleLabel = user.role === "owner" ? "Chủ sở hữu" : "Người xem";
    $("#userIdentity").textContent = `${user.email} · ${roleLabel}`;
  }
  const owner = user?.role === "owner";
  $("#clearButton").hidden = !owner;
  $("#testButton").hidden = !owner;
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Không rõ thời gian";
  return new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function initials(value) {
  return String(value || "ST").split(/[.\s@_-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "ST";
}

function processingMarkup(result) {
  if (!result) return "";
  const extraction = result.extraction || {};
  const sheet = result.sheet || {};
  const confirmation = result.confirmation || {};
  const extractionLabels = { queued: "Đang xếp hàng", extracting: "Đang trích xuất", rules: "Rule fallback", complete: "Đã trích xuất", failed: "Lỗi" };
  const sheetLabels = { queued: "Chờ ghi", awaiting_confirmation: "Chờ Confirm", writing: "Đang ghi", written: "Đã ghi vào Sheet", skipped: "Bỏ qua khi test", paused: "Tạm thời bỏ qua", missing_required_fields: "Thiếu field bắt buộc", not_configured: "Chưa cấu hình", auth_required: "Cần cấp quyền Sheet", failed: "Ghi lỗi", not_attempted: "Chưa ghi" };
  const confirmationLabels = { queued: "Đang chuẩn bị", sending: "Đang gửi card", sent: "Đã gửi card Confirm", sent_text_fallback: "Đã gửi text trong thread", confirmed: "Đã Confirm", needs_revision: "Cần bổ sung field", blocked: "Chưa thể ghi", not_configured: "Chưa cấu hình outbound", failed: "Gửi card lỗi", not_attempted: "Không gửi khi test" };
  const extractionStatus = extraction.status || "queued";
  const sheetStatus = sheet.status || "queued";
  const value = (field) => field ? escapeHtml(field) : "—";
  const error = extraction.error || sheet.error || confirmation.error;
  return `<div class="task-result ${escapeHtml(extractionStatus)}">
    <div class="task-result-head"><span class="task-label">TASK EXTRACTION · ${escapeHtml(extraction.provider || "AI")}</span><span>${escapeHtml(extractionLabels[extractionStatus] || extractionStatus)}</span></div>
    <div class="task-fields">
      <div><span>ID</span><strong>${value(extraction.taskId)}</strong></div>
      <div><span>STATUS</span><strong>${value(extraction.taskStatus || "TODO")}</strong></div>
      <div><span>PIC</span><strong>${value(extraction.pic)}</strong></div>
      <div><span>CREATOR</span><strong>${value(extraction.creator)}</strong></div>
      <div><span>DEADLINE</span><strong>${value(extraction.deadline)}</strong></div>
      <div><span>PRIORITY</span><strong class="priority-value">${value(extraction.priority)}</strong></div>
      <div class="task-content-field"><span>NỘI DUNG CÔNG VIỆC</span><strong>${value(extraction.taskContent)}</strong></div>
    </div>
    <div class="sheet-status">CreatedAt: <b>${value(extraction.createdAt)}</b> · UpdatedAt: <b>${value(extraction.updatedAt)}</b></div>
    <div class="sheet-status">Google Sheet: <b>${escapeHtml(sheetLabels[sheetStatus] || sheetStatus)}</b>${sheet.rowNumber ? ` · dòng ${escapeHtml(sheet.rowNumber)}` : ""}</div>
    ${result.confirmation ? `<div class="sheet-status">SeaTalk: <b>${escapeHtml(confirmationLabels[result.confirmation.status] || result.confirmation.status || "—")}</b></div>` : ""}
    ${error ? `<p class="task-error">${escapeHtml(error)}</p>` : ""}
  </div>`;
}

function renderExtractedTasks() {
  const table = $("#tasksTable");
  const body = $("#tasksTableBody");
  const empty = $("#tasksEmpty");
  const extracted = state.messages.filter((item) => item.parsed?.kind === "message" && item.processing?.extraction?.status === "complete");

  $("#extractedTaskCount").textContent = extracted.length;
  table.style.display = extracted.length ? "table" : "none";
  empty.style.display = extracted.length ? "none" : "grid";
  body.innerHTML = extracted.map((item) => {
    const extraction = item.processing.extraction;
    const source = extraction.source || extraction.provider || "rules";
    return `<tr>
      <td>${escapeHtml(extraction.taskId || "—")}</td>
      <td>${escapeHtml(extraction.task || extraction.taskContent || "—")}<span class="task-table-source">${escapeHtml(source)}</span></td>
      <td>${escapeHtml(extraction.pic || "—")}</td>
      <td>${escapeHtml(extraction.creator || "—")}</td>
      <td>${escapeHtml(extraction.deadline || "—")}</td>
      <td class="priority-cell">${escapeHtml(extraction.priority || "—")}</td>
      <td>${escapeHtml(extraction.taskStatus || "TODO")}</td>
      <td>${escapeHtml(formatDate(extraction.createdAt) || "—")}</td>
      <td>${escapeHtml(formatDate(extraction.updatedAt) || "—")}</td>
    </tr>`;
  }).join("");
}

function render() {
  const feed = $("#feed");
  $("#messageCount").textContent = state.messages.length;
  const latest = state.messages[0];
  $("#lastEvent").textContent = latest?.parsed?.eventType || "Chưa có";
  $("#lastEventTime").textContent = latest ? `Nhận lúc ${formatDate(latest.receivedAt)}` : "Đang chờ callback";
  $("#emptyState").style.display = state.messages.length ? "none" : "grid";
  renderExtractedTasks();

  for (const item of [...feed.querySelectorAll(".message-item")]) item.remove();
  for (const item of state.messages) {
    const isSystem = item.parsed?.kind !== "message";
    const article = document.createElement("article");
    article.className = `message-item${isSystem ? " system" : ""}`;
    article.innerHTML = `
      <div class="message-avatar" aria-hidden="true">${escapeHtml(initials(item.parsed?.sender))}</div>
      <div>
        <div class="message-meta">
          <span class="message-sender">${escapeHtml(item.parsed?.sender || "SeaTalk")}</span>
          <span class="message-type">${escapeHtml(item.parsed?.eventType || "event")}</span>
        </div>
        <p class="message-text">${escapeHtml(item.parsed?.title || "Sự kiện không có nội dung")}</p>
      </div>
      <time class="message-time" datetime="${escapeHtml(item.receivedAt)}">${escapeHtml(formatTime(item.receivedAt))}</time>
      ${processingMarkup(item.processing)}
      <details class="raw-details">
        <summary>Xem payload gốc</summary>
        <pre>${escapeHtml(JSON.stringify(item.payload, null, 2))}</pre>
      </details>`;
    feed.append(article);
  }
}

function setConnection(stateName, label) {
  const status = $("#connectionState");
  status.dataset.state = stateName;
  $("#connectionLabel").textContent = label;
  $("#footerStatus").textContent = stateName === "online" ? "Realtime connected" : "Đang thử kết nối";
}

function applySnapshot(messages) {
  state.messages = Array.isArray(messages) ? messages : [];
  render();
}

function renderGoogleStatus() {
  const status = state.google || {};
  const title = $("#googleStatusTitle");
  const text = $("#googleStatusText");
  const icon = $("#googleStatusIcon");
  const pill = $("#sheetsModePill");
  if (!title || !text) return;

  if (!status.configured) {
    title.textContent = "Chưa cấu hình";
    text.textContent = "Chưa cấu hình service account.";
    icon.textContent = "!";
    if (pill) pill.textContent = "GOOGLE SHEETS · CHƯA CẤU HÌNH";
    return;
  }

  if (status.authorized && status.sheetAccess) {
    title.textContent = "Đã truy cập được Google Sheet";
    text.textContent = `Đã truy cập được Google Sheet bằng ${status.accountEmail}.`;
    icon.textContent = "✓";
    if (pill) pill.textContent = "GOOGLE SHEETS · ĐÃ CẤP QUYỀN";
    return;
  }

  title.textContent = "Chưa truy cập được Google Sheet";
  text.textContent = `Chưa truy cập được Google Sheet. Hãy share Sheet cho ${status.accountEmail} với quyền Editor.`;
  icon.textContent = "!";
  if (pill) pill.textContent = "GOOGLE SHEETS · CẦN CẤP QUYỀN";
}

async function loadGoogleStatus() {
  try {
    const response = await apiFetch("/api/google/status");
    if (!response.ok) throw new Error("Unable to load Google Sheets status");
    state.google = await response.json();
    renderGoogleStatus();
  } catch {
    state.google = null;
  }
}

async function loadMessages() {
  const response = await apiFetch("/api/messages");
  if (!response.ok) throw new Error("Unable to load dashboard messages");
  const data = await response.json();
  applySnapshot(data.messages);
}

function connectStream() {
  const stream = new EventSource("/api/stream");
  stream.onopen = () => setConnection("online", "Đang lắng nghe");
  stream.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "snapshot") applySnapshot(payload.messages);
    if (payload.type === "message") {
      state.messages = [payload.message, ...state.messages].slice(0, 100);
      render();
    }
    if (payload.type === "processing") {
      const item = state.messages.find((message) => message.id === payload.id);
      if (item) { item.processing = payload.processing; render(); }
    }
    if (payload.type === "clear") applySnapshot([]);
  };
  stream.onerror = () => {
    setConnection("offline", "Mất kết nối · đang thử lại");
    void apiFetch("/api/me").then(async (response) => {
      if (response.status === 401) return;
      if (!response.ok) {
        stream.close();
        setTimeout(connectStream, 2500);
        return;
      }
      applyUser(await response.json());
      stream.close();
      setTimeout(connectStream, 2500);
    }).catch(() => {
      stream.close();
      setTimeout(connectStream, 2500);
    });
  };
}

$("#testButton").addEventListener("click", async () => {
  const button = $("#testButton");
  button.disabled = true;
  button.innerHTML = "Đang gửi…";
  try { await apiFetch("/api/test-message", { method: "POST" }); } finally {
    button.disabled = false;
    button.innerHTML = "<span>＋</span> Gửi tin nhắn thử";
  }
});

$("#clearButton").addEventListener("click", async () => {
  if (!state.messages.length || !confirm("Xóa toàn bộ lịch sử đang hiển thị?")) return;
  await apiFetch("/api/messages", { method: "DELETE" });
});

$("#copyButton").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#webhookUrl").textContent);
  const button = $("#copyButton");
  button.textContent = "✓";
  setTimeout(() => { button.textContent = "⧉"; }, 1400);
});

$("#logoutButton").addEventListener("click", async () => {
  const response = await apiFetch("/auth/logout", { method: "POST" });
  if (response.ok) window.location.assign("/login");
});

async function initializeDashboard() {
  const response = await apiFetch("/api/me");
  if (!response.ok) {
    setConnection("offline", "Không xác thực được phiên đăng nhập");
    return;
  }
  applyUser(await response.json());
  await Promise.all([
    loadMessages().catch(() => setConnection("offline", "Không kết nối được")),
    loadGoogleStatus(),
  ]);
  connectStream();
}

initializeDashboard().catch(() => setConnection("offline", "Không kết nối được"));
