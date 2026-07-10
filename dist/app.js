(async function () {
  const listEl = document.getElementById("list");
  const loadingEl = document.getElementById("loading");
  const emptyEl = document.getElementById("empty");
  const countEl = document.getElementById("pr-count");
  const updatedEl = document.getElementById("updated");
  const repoTitle = document.getElementById("repo-title");
  const refreshBtn = document.getElementById("refresh");
  const settingsBtn = document.getElementById("settings");
  const searchEl = document.getElementById("search");
  const viewAllEl = document.getElementById("view-all");
  const setupEl = document.getElementById("setup");
  const setupForm = document.getElementById("setup-form");
  const repoInput = document.getElementById("repo-input");
  const setupSave = document.getElementById("setup-save");
  const setupStatus = document.getElementById("setup-status");

  // Expanded cards survive re-renders; draft comments survive refreshes.
  const openState = new Set();
  const draftComments = new Map();
  let lastData = null;
  let filter = "";
  let repo = null; // "owner/repo" from data/config.json

  const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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
    return `${Math.round(mo / 12)}y ago`;
  }
  function hue(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
  }

  async function putData(file, payload) {
    const r = await fetch(`/_rowboat/data/${file}`, {
      method: "PUT",
      headers: { "X-Rowboat-App": "1", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error((j.error && j.error.message) || `HTTP ${r.status}`);
    }
  }

  // ---- Tiny markdown renderer (escape-first; headings, lists, code, links) ----
  function inlineMd(escaped) {
    return escaped
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  }
  function renderMarkdown(raw) {
    const lines = escapeHtml(raw).split(/\r?\n/);
    const out = [];
    let inCode = false;
    let inList = false;
    let para = [];
    const flushPara = () => {
      if (para.length) {
        out.push(`<p>${inlineMd(para.join(" "))}</p>`);
        para = [];
      }
    };
    const closeList = () => {
      if (inList) { out.push("</ul>"); inList = false; }
    };
    for (const line of lines) {
      if (line.trim().startsWith("```")) {
        flushPara(); closeList();
        out.push(inCode ? "</code></pre>" : "<pre><code>");
        inCode = !inCode;
        continue;
      }
      if (inCode) { out.push(line + "\n"); continue; }
      const h = line.match(/^(#{1,3})\s+(.*)/);
      if (h) { flushPara(); closeList(); out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`); continue; }
      const li = line.match(/^\s*[-*]\s+(.*)/);
      if (li) {
        flushPara();
        if (!inList) { out.push("<ul>"); inList = true; }
        out.push(`<li>${inlineMd(li[1])}</li>`);
        continue;
      }
      if (!line.trim()) { flushPara(); closeList(); continue; }
      para.push(line.trim());
    }
    flushPara(); closeList();
    if (inCode) out.push("</code></pre>");
    return out.join("");
  }

  // ---- Render ----
  function renderPR(pr) {
    const labels = (pr.labels || []).map(
      (l) => `<span class="tag label" style="--h:${hue(l)}">${escapeHtml(l)}</span>`
    ).join("");
    const draft = pr.draft ? `<span class="tag draft">Draft</span>` : "";
    const reviewers = pr.requestedReviewers || [];
    const reviewChip = reviewers.length ? `<span class="tag review-req">Review requested</span>` : "";
    const avatar = pr.authorAvatar
      ? `<img class="avatar" src="${escapeHtml(pr.authorAvatar)}" alt="" loading="lazy" />`
      : `<span class="avatar"></span>`;
    const body = (pr.body || "").trim();
    const bodyHtml = body
      ? `<div class="pr-body">${renderMarkdown(body)}</div>`
      : `<div class="pr-body empty">No description.</div>`;
    const reviewerChips = reviewers.map((r) => `<span class="reviewer">${escapeHtml(r)}</span>`).join("");
    const savedComment = draftComments.get(pr.number) || "";

    return `
      <article class="pr" data-pr="${escapeHtml(pr.number)}" data-open="${openState.has(pr.number) ? "true" : "false"}">
        <div class="pr-summary" data-toggle="${escapeHtml(pr.number)}">
          <svg class="chevron" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M6 4l4 4-4 4V4z"/></svg>
          ${avatar}
          <div class="pr-summary-main">
            <div class="pr-head">
              <span class="pr-num">#${escapeHtml(pr.number)}</span>
              <a class="pr-title pr-title-link" href="${escapeHtml(pr.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(pr.title)}</a>
              ${draft}${reviewChip}${labels}
            </div>
            <div class="pr-meta">
              <span class="author">${escapeHtml(pr.author)}</span>
              <span>opened ${escapeHtml(timeAgo(pr.createdAt))}</span>
              <span class="dot">·</span>
              <span data-updated="${escapeHtml(pr.updatedAt)}">updated ${escapeHtml(timeAgo(pr.updatedAt))}</span>
              <span class="branch" title="${escapeHtml(pr.headBranch)} → ${escapeHtml(pr.baseBranch)}">${escapeHtml(pr.headBranch)} → ${escapeHtml(pr.baseBranch)}</span>
            </div>
          </div>
        </div>
        <div class="pr-details">
          <div class="detail-row">
            ${reviewers.length ? `<span>Reviewers:</span>${reviewerChips}` : `<span class="muted">No reviewers requested.</span>`}
            <a class="open-gh" href="${escapeHtml(pr.url)}" target="_blank" rel="noopener noreferrer">Open on GitHub ↗</a>
          </div>
          ${bodyHtml}
          <div class="comment-box">
            <label class="comment-label" for="comment-${escapeHtml(pr.number)}">Comment on this PR (posts as you, via GitHub)</label>
            <textarea class="comment-input" id="comment-${escapeHtml(pr.number)}" data-comment-input="${escapeHtml(pr.number)}" placeholder="Leave a comment…">${escapeHtml(savedComment)}</textarea>
            <div class="comment-actions">
              <button class="btn small" data-submit-comment="${escapeHtml(pr.number)}">Post comment</button>
              <span class="status info" data-status="${escapeHtml(pr.number)}"></span>
            </div>
          </div>
        </div>
      </article>
    `;
  }

  function section(title, cls, items) {
    if (!items.length) return "";
    return `
      <div class="section-head ${cls}">${escapeHtml(title)} <span class="n">${items.length}</span></div>
      ${items.map(renderPR).join("")}
    `;
  }

  function matchesFilter(pr) {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      String(pr.number).includes(q) ||
      (pr.title || "").toLowerCase().includes(q) ||
      (pr.author || "").toLowerCase().includes(q) ||
      (pr.labels || []).some((l) => l.toLowerCase().includes(q)) ||
      (pr.headBranch || "").toLowerCase().includes(q)
    );
  }

  function render(data) {
    loadingEl.hidden = true;
    const all = Array.isArray(data && data.items) ? data.items : [];
    if (data && data.repo) {
      repoTitle.textContent = data.repo;
      document.title = `Open PRs — ${data.repo}`;
    }

    listEl.querySelectorAll(".pr, .section-head, .no-match").forEach((n) => n.remove());

    const needsReview = all.filter((p) => (p.requestedReviewers || []).length && !p.draft);
    countEl.textContent = `${all.length} open${needsReview.length ? ` · ${needsReview.length} awaiting review` : ""}`;
    if (data && data.updatedAt) {
      updatedEl.textContent = `Updated ${timeAgo(data.updatedAt)}`;
      updatedEl.title = new Date(data.updatedAt).toLocaleString();
    } else {
      updatedEl.textContent = "";
    }

    if (all.length === 0) {
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    const items = all.filter(matchesFilter);
    if (!items.length) {
      listEl.insertAdjacentHTML("beforeend", `<div class="no-match">Nothing matches “${escapeHtml(filter)}”.</div>`);
      return;
    }
    const review = items.filter((p) => (p.requestedReviewers || []).length && !p.draft);
    const drafts = items.filter((p) => p.draft);
    const rest = items.filter((p) => !review.includes(p) && !drafts.includes(p));

    listEl.insertAdjacentHTML(
      "beforeend",
      section("Review requested", "review", review) +
      section("Open", "", rest) +
      section("Drafts", "", drafts)
    );
  }

  // Keep relative times honest without re-rendering (typing, open cards survive).
  setInterval(() => {
    listEl.querySelectorAll("[data-updated]").forEach((el) => {
      el.textContent = `updated ${timeAgo(el.dataset.updated)}`;
    });
    if (lastData && lastData.updatedAt) updatedEl.textContent = `Updated ${timeAgo(lastData.updatedAt)}`;
  }, 60_000);

  // ---- Repo config (data/config.json) ----
  function applyRepo(r) {
    repo = r;
    repoTitle.textContent = r;
    document.title = `Open PRs — ${r}`;
    viewAllEl.href = `https://github.com/${r}/pulls`;
    viewAllEl.hidden = false;
  }

  function showSetup(prefill) {
    setupEl.hidden = false;
    listEl.hidden = true;
    repoInput.value = prefill || "";
    setupStatus.textContent = "";
    setupStatus.className = "status info";
    setTimeout(() => repoInput.focus(), 50);
  }
  function hideSetup() {
    setupEl.hidden = true;
    listEl.hidden = false;
  }

  async function loadConfig() {
    try {
      const r = await fetch("/_rowboat/data/config.json", { cache: "no-store" });
      if (r.ok) {
        const cfg = await r.json();
        if (cfg && typeof cfg.repo === "string" && REPO_RE.test(cfg.repo)) return cfg.repo;
      }
    } catch {}
    return null;
  }

  // Waiting state: repo configured, agent hasn't written its data yet (or the
  // data on disk is for a previously-tracked repo).
  function showWaiting() {
    emptyEl.hidden = true;
    listEl.querySelectorAll(".pr, .section-head, .no-match").forEach((n) => n.remove());
    loadingEl.hidden = false;
    loadingEl.textContent = `Fetching open PRs for ${repo}… the background agent is on it.`;
    countEl.textContent = "—";
    updatedEl.textContent = "";
  }

  setupForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = repoInput.value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/+$/, "");
    if (!REPO_RE.test(value)) {
      setupStatus.textContent = "That doesn't look like owner/repo.";
      setupStatus.className = "status error";
      return;
    }
    setupSave.disabled = true;
    setupStatus.textContent = "Saving…";
    setupStatus.className = "status info";
    try {
      // Writing config.json is the whole job: the host notices the change and
      // runs this app's background agent, which writes data.json; the
      // data-change event then re-renders this page.
      await putData("config.json", { repo: value });
      applyRepo(value);
      hideSetup();
      showWaiting();
    } catch (err) {
      setupStatus.textContent = "Failed to save: " + (err && err.message ? err.message : err);
      setupStatus.className = "status error";
    } finally {
      setupSave.disabled = false;
    }
  });

  settingsBtn.addEventListener("click", () => {
    if (setupEl.hidden) showSetup(repo || "");
    else if (repo) hideSetup();
  });

  setupEl.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-example]");
    if (!chip) return;
    repoInput.value = chip.dataset.example;
    repoInput.focus();
  });

  // ---- Interactions ----
  searchEl.addEventListener("input", () => {
    filter = searchEl.value.trim();
    if (lastData) render(lastData);
  });

  listEl.addEventListener("click", async (e) => {
    const toggle = e.target.closest("[data-toggle]");
    if (toggle) {
      if (e.target.closest("a")) return; // links act as links
      const num = Number(toggle.dataset.toggle);
      const card = toggle.closest(".pr");
      const isOpen = card.dataset.open === "true";
      card.dataset.open = isOpen ? "false" : "true";
      if (isOpen) openState.delete(num); else openState.add(num);
      return;
    }
    const submit = e.target.closest("[data-submit-comment]");
    if (submit) await postComment(Number(submit.dataset.submitComment), submit);
  });

  listEl.addEventListener("input", (e) => {
    const ta = e.target.closest("[data-comment-input]");
    if (!ta) return;
    draftComments.set(Number(ta.dataset.commentInput), ta.value);
  });

  async function postComment(prNumber, btn) {
    const card = listEl.querySelector(`.pr[data-pr="${prNumber}"]`);
    if (!card || !repo) return;
    const ta = card.querySelector(`[data-comment-input="${prNumber}"]`);
    const status = card.querySelector(`[data-status="${prNumber}"]`);
    const body = (ta.value || "").trim();
    if (!body) { setStatus(status, "Write something first.", "error"); return; }
    const [owner, name] = repo.split("/");

    btn.disabled = true;
    ta.disabled = true;
    setStatus(status, "Posting…", "info");
    try {
      const resp = await fetch("/_rowboat/tools/execute", {
        method: "POST",
        headers: { "X-Rowboat-App": "1", "Content-Type": "application/json" },
        body: JSON.stringify({
          toolkit: "github",
          slug: "GITHUB_CREATE_AN_ISSUE_COMMENT",
          arguments: { owner, repo: name, issue_number: prNumber, body },
        }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || json.error) {
        throw new Error((json.error && (json.error.message || json.error.code)) || `HTTP ${resp.status}`);
      }
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
        showWaiting();
        return;
      }
      const data = await r.json();
      // Data written for a previously-tracked repo is stale — keep the waiting
      // state until the agent writes data for the current repo.
      if (repo && data && data.repo && data.repo !== repo) {
        showWaiting();
        return;
      }
      lastData = data;
      render(data);
    } catch (e) {
      loadingEl.hidden = false;
      loadingEl.textContent = "Failed to load data: " + (e && e.message ? e.message : e);
    }
  }

  // Agent refreshed the data → re-render in place (no page reload).
  window.addEventListener("rowboat:data-change", (e) => {
    e.preventDefault();
    loadData();
  });

  refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    refreshBtn.classList.add("spinning");
    await loadData();
    setTimeout(() => {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove("spinning");
    }, 350);
  });

  // ---- Boot ----
  // No config → blank slate: ask for the repo. The agent does the rest.
  const configured = await loadConfig();
  if (configured) {
    applyRepo(configured);
    await loadData();
  } else {
    showSetup("");
  }
})();
