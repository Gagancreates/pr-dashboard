(async function () {
  const listEl = document.getElementById("list");
  const loadingEl = document.getElementById("loading");
  const emptyEl = document.getElementById("empty");
  const countEl = document.getElementById("pr-count");
  const updatedEl = document.getElementById("updated");
  const repoTitle = document.getElementById("repo-title");
  const refreshBtn = document.getElementById("refresh");

  // Track which PRs are currently expanded so a data refresh doesn't collapse them
  const openState = new Set();
  // Cache of user-entered draft comments so re-render doesn't lose them
  const draftComments = new Map();

  // ---- Theme ----
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
  }
  try {
    const info = await (await fetch("/_rowboat/app")).json();
    applyTheme(info.theme);
  } catch {
    applyTheme("light");
  }
  try {
    const events = new EventSource("/_rowboat/events");
    events.addEventListener("message", (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "theme") applyTheme(msg.theme);
      } catch {}
    });
  } catch {}

  // ---- Helpers ----
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function timeAgo(iso) {
    if (!iso) return "";
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return "";
    const diff = Math.max(0, Date.now() - then);
    const s = Math.round(diff / 1000);
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    if (d < 30) return `${d}d ago`;
    const mo = Math.round(d / 30);
    if (mo < 12) return `${mo}mo ago`;
    const y = Math.round(mo / 12);
    return `${y}y ago`;
  }

  function parseRepo(repoStr) {
    if (typeof repoStr !== "string") return { owner: null, repo: null };
    const [owner, repo] = repoStr.split("/");
    return { owner: owner || null, repo: repo || null };
  }

  // ---- Render ----
  function renderPR(pr) {
    const labels = (pr.labels || []).map(
      (l) => `<span class="tag label">${escapeHtml(l)}</span>`
    ).join("");
    const draft = pr.draft ? `<span class="tag draft">Draft</span>` : "";
    const avatar = pr.authorAvatar
      ? `<img class="avatar" src="${escapeHtml(pr.authorAvatar)}" alt="" />`
      : "";
    const body = (pr.body || "").trim();
    const bodyHtml = body
      ? `<div class="pr-body">${escapeHtml(body)}</div>`
      : `<div class="pr-body empty">No description.</div>`;
    const savedComment = draftComments.get(pr.number) || "";

    return `
      <article class="pr" data-pr="${escapeHtml(pr.number)}" data-open="${openState.has(pr.number) ? "true" : "false"}">
        <div class="pr-summary" data-toggle="${escapeHtml(pr.number)}">
          <svg class="chevron" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M6 4l4 4-4 4V4z"/>
          </svg>
          <div class="pr-summary-main">
            <div class="pr-head">
              <span class="pr-num">#${escapeHtml(pr.number)}</span>
              <a class="pr-title pr-title-link" href="${escapeHtml(pr.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(pr.title)}</a>
              ${draft}
              ${labels}
            </div>
            <div class="pr-meta">
              ${avatar}
              <span class="author">${escapeHtml(pr.author)}</span>
              <span>opened ${escapeHtml(timeAgo(pr.createdAt))}</span>
              <span class="dot">·</span>
              <span>updated ${escapeHtml(timeAgo(pr.updatedAt))}</span>
              <span class="branch">${escapeHtml(pr.headBranch)} → ${escapeHtml(pr.baseBranch)}</span>
            </div>
          </div>
        </div>
        <div class="pr-details">
          ${bodyHtml}
          <div class="comment-box">
            <label class="comment-label" for="comment-${escapeHtml(pr.number)}">Add a comment (Markdown supported)</label>
            <textarea class="comment-input" id="comment-${escapeHtml(pr.number)}" data-comment-input="${escapeHtml(pr.number)}" placeholder="Leave a comment on this PR…">${escapeHtml(savedComment)}</textarea>
            <div class="comment-actions">
              <button class="btn small" data-submit-comment="${escapeHtml(pr.number)}">Post comment</button>
              <span class="status info" data-status="${escapeHtml(pr.number)}"></span>
            </div>
          </div>
        </div>
      </article>
    `;
  }

  let currentRepo = null;

  function render(data) {
    loadingEl.hidden = true;
    const items = Array.isArray(data && data.items) ? data.items : [];
    if (data && data.repo) {
      repoTitle.textContent = data.repo;
      currentRepo = data.repo;
    }

    Array.from(listEl.querySelectorAll(".pr")).forEach((n) => n.remove());

    countEl.textContent = `${items.length} open (latest)`;
    if (data && data.updatedAt) {
      updatedEl.textContent = `Updated ${timeAgo(data.updatedAt)}`;
      updatedEl.title = new Date(data.updatedAt).toLocaleString();
    } else {
      updatedEl.textContent = "";
    }

    if (items.length === 0) {
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    emptyEl.insertAdjacentHTML("afterend", items.map(renderPR).join(""));
  }

  // ---- Interactions ----
  listEl.addEventListener("click", async (e) => {
    const toggle = e.target.closest("[data-toggle]");
    if (toggle) {
      // Don't collapse when clicking the title link
      if (e.target.closest(".pr-title-link")) return;
      const num = Number(toggle.dataset.toggle);
      const card = toggle.closest(".pr");
      const isOpen = card.dataset.open === "true";
      if (isOpen) {
        card.dataset.open = "false";
        openState.delete(num);
      } else {
        card.dataset.open = "true";
        openState.add(num);
      }
      return;
    }

    const submit = e.target.closest("[data-submit-comment]");
    if (submit) {
      const num = Number(submit.dataset.submitComment);
      await postComment(num, submit);
    }
  });

  // Keep draft comments in sync so a background refresh doesn't wipe typing
  listEl.addEventListener("input", (e) => {
    const ta = e.target.closest("[data-comment-input]");
    if (!ta) return;
    const num = Number(ta.dataset.commentInput);
    draftComments.set(num, ta.value);
  });

  async function postComment(prNumber, btn) {
    const card = listEl.querySelector(`.pr[data-pr="${prNumber}"]`);
    if (!card) return;
    const ta = card.querySelector(`[data-comment-input="${prNumber}"]`);
    const status = card.querySelector(`[data-status="${prNumber}"]`);
    const body = (ta.value || "").trim();
    if (!body) {
      setStatus(status, "Write something first.", "error");
      return;
    }
    const { owner, repo } = parseRepo(currentRepo);
    if (!owner || !repo) {
      setStatus(status, "Repo unknown — refresh the app.", "error");
      return;
    }

    btn.disabled = true;
    ta.disabled = true;
    setStatus(status, "Posting…", "info");

    try {
      const resp = await fetch("/_rowboat/tools/execute", {
        method: "POST",
        headers: {
          "X-Rowboat-App": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          toolkit: "github",
          slug: "GITHUB_CREATE_AN_ISSUE_COMMENT",
          arguments: {
            owner,
            repo,
            issue_number: prNumber,
            body,
          },
        }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || json.error) {
        const msg = (json.error && (json.error.message || json.error.code)) ||
          `HTTP ${resp.status}`;
        throw new Error(msg);
      }
      // Composio tool execute wraps results in a data envelope; success is
      // implicit when there's no error and status is 2xx.
      ta.value = "";
      draftComments.delete(prNumber);
      setStatus(status, "Comment posted ✓", "success");
    } catch (err) {
      setStatus(status, "Failed: " + (err && err.message ? err.message : err), "error");
    } finally {
      btn.disabled = false;
      ta.disabled = false;
    }
  }

  function setStatus(el, text, kind) {
    if (!el) return;
    el.textContent = text;
    el.className = "status " + (kind || "info");
  }

  // ---- Data ----
  async function loadData() {
    try {
      const r = await fetch("/_rowboat/data/data.json", { cache: "no-store" });
      if (!r.ok) {
        loadingEl.textContent = "No data yet. The background agent will populate it shortly.";
        return;
      }
      const data = await r.json();
      render(data);
    } catch (e) {
      loadingEl.textContent = "Failed to load data: " + (e && e.message ? e.message : e);
    }
  }

  window.addEventListener("rowboat:data-change", (e) => {
    e.preventDefault();
    loadData();
  });

  refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Refreshing…";
    await loadData();
    refreshBtn.disabled = false;
    refreshBtn.textContent = "Refresh";
  });

  await loadData();
})();
