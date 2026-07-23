// TCMS on GitHub Pages — dashboard + editor.
//
// Reads render from dashboard-data/index.json (one static fetch, no auth).
// Writes go straight from the browser to api.github.com with the user's
// fine-grained PAT (localStorage). The token is never sent anywhere else.
import { parseYaml, emitTestCase, YamlUnsupportedError } from "./yaml.js";

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const PRIORITIES = ["low", "medium", "high", "critical"];
const STATUSES = ["draft", "active", "deprecated"];
const ID_RE = /^TC-\d{4,}$/;
const SUITE_RE = /^[a-z0-9][a-z0-9-]*$/;

const state = {
  config: { owner: "", repo: "", branch: "main", title: "Test Cases" },
  token: null,
  user: null, // login of the connected user, best-effort
  index: null, // {version, test_cases: [...]} or null while loading/failed
  indexError: null,
  filters: { search: "", suite: "", priority: "", status: "" },
  returnTo: null, // route to go back to after connecting
};

class ApiError extends Error {
  constructor(status, message) {
    super(message || `GitHub API error: ${status}`);
    this.status = status;
  }
}

// --- tiny DOM helper: children are appended, strings become text nodes ---
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else if (key === "checked" || key === "disabled" || key === "readOnly" || key === "hidden" || key === "value") {
      node[key] = value;
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const $ = (sel) => document.querySelector(sel);

// --- config & repo detection ---
async function loadConfig() {
  try {
    const res = await fetch("config.json", { cache: "no-store" });
    if (res.ok) Object.assign(state.config, await res.json());
  } catch {
    /* keep defaults */
  }
  if (!state.config.owner || !state.config.repo) {
    // Standard project-pages URL: <owner>.github.io/<repo>/
    const host = location.hostname;
    if (host.endsWith(".github.io")) {
      state.config.owner = state.config.owner || host.slice(0, -".github.io".length);
      const seg = location.pathname.split("/").filter(Boolean)[0];
      if (seg && !state.config.repo) state.config.repo = seg;
    }
  }
  if (!state.config.branch) state.config.branch = "main";
}

function repoResolved() {
  return Boolean(state.config.owner && state.config.repo);
}

function repoSlug() {
  return `${state.config.owner}/${state.config.repo}`;
}

// --- token storage & GitHub API ---
function tokenKey() {
  return `tcms:${repoSlug()}:token`;
}

function loadToken() {
  state.token = repoResolved() ? localStorage.getItem(tokenKey()) : null;
}

function storeToken(token) {
  state.token = token;
  localStorage.setItem(tokenKey(), token);
}

function clearToken() {
  state.token = null;
  state.user = null;
  if (repoResolved()) localStorage.removeItem(tokenKey());
  renderHeader();
}

async function gh(path, options = {}, { token = state.token, handleAuth = true } = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res = await fetch(`${API}${path}`, { ...options, headers });
  if (handleAuth && (res.status === 401 || res.status === 403)) {
    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
      throw new ApiError(403, "GitHub API rate limit reached — try again later.");
    }
    // Expired or revoked token: clear it and fall back to the connect screen.
    clearToken();
    showBanner("Your GitHub token expired or was revoked. Connect again to keep editing.", true);
    throw new ApiError(res.status, "Authentication failed");
  }
  return res;
}

async function ghJson(path, options, extra) {
  const res = await gh(path, options, extra);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new ApiError(res.status, data && data.message);
  return data;
}

function b64encodeUtf8(text) {
  return btoa(unescape(encodeURIComponent(text)));
}

function b64decodeUtf8(b64) {
  return decodeURIComponent(escape(atob(b64.replace(/\s/g, ""))));
}

async function fetchFile(path) {
  const data = await ghJson(
    `/repos/${repoSlug()}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${state.config.branch}`
  );
  return { sha: data.sha, text: b64decodeUtf8(data.content) };
}

async function putFile({ path, text, message, sha }) {
  const body = {
    message,
    content: b64encodeUtf8(text),
    branch: state.config.branch,
    ...(sha ? { sha } : {}),
  };
  return ghJson(
    `/repos/${repoSlug()}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
    { method: "PUT", body: JSON.stringify(body) }
  );
}

async function validateToken(token) {
  // One lightweight call; also proves this token can see this repo.
  const res = await gh(`/repos/${repoSlug()}`, {}, { token, handleAuth: false });
  if (!res.ok) {
    const messages = {
      401: "GitHub rejected the token (401). Check that it was copied completely.",
      403: "The token is valid but not allowed to access this repository (403).",
      404: `The token cannot see ${repoSlug()} (404). Grant it access to this repository when creating it.`,
    };
    throw new ApiError(res.status, messages[res.status] || `GitHub API error: ${res.status}`);
  }
  const repo = await res.json();
  if (repo.permissions && !repo.permissions.push) {
    throw new ApiError(403, "This token can read the repository but not write to it. It needs Contents: Read and write.");
  }
}

// --- index (read path) ---
async function loadIndex() {
  state.index = null;
  state.indexError = null;
  try {
    const res = await fetch("dashboard-data/index.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.index = await res.json();
  } catch (err) {
    state.indexError =
      "Could not load dashboard-data/index.json. If this is a fresh deployment, " +
      "push a test case (or run the “Rebuild dashboard index” workflow) to generate it.";
  }
}

function testCases() {
  return (state.index && state.index.test_cases) || [];
}

function findCase(id) {
  return testCases().find((tc) => tc.id === id) || null;
}

function upsertLocalCase(entry) {
  if (!state.index) state.index = { version: 1, test_cases: [] };
  const list = state.index.test_cases;
  const i = list.findIndex((tc) => tc.id === entry.id);
  if (i === -1) list.push(entry);
  else list[i] = entry;
  list.sort((a, b) => a.id.localeCompare(b.id));
}

function suiteNames() {
  return [...new Set(testCases().map((tc) => tc.suite).filter(Boolean))].sort();
}

function nextId() {
  let max = 0;
  for (const tc of testCases()) {
    const m = /^TC-(\d+)$/.exec(tc.id || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `TC-${String(max + 1).padStart(4, "0")}`;
}

function casePath(tc) {
  return tc.path || `test-cases/${tc.suite}/${tc.id}.yaml`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// --- chrome: header, banner, toast, theme ---
function renderHeader() {
  $("#app-title").textContent = state.config.title || "Test Cases";
  document.title = state.config.title || "Test Cases";
  $("#repo-label").textContent = repoResolved() ? `· ${repoSlug()}` : "";
  const connected = Boolean(state.token);
  $("#btn-connect").hidden = connected;
  $("#btn-disconnect").hidden = !connected;
  $("#conn-status").textContent = connected ? (state.user ? `Connected as ${state.user}` : "Connected") : "";
}

let toastTimer = null;
function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 4500);
}

function showBanner(message, isError = false) {
  const node = $("#banner");
  node.textContent = message;
  node.className = isError ? "error" : "";
  node.hidden = false;
}

function hideBanner() {
  $("#banner").hidden = true;
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function initTheme() {
  applyTheme(localStorage.getItem("tcms:theme") || "");
  $("#theme-toggle").addEventListener("click", () => {
    const dark =
      document.documentElement.dataset.theme === "dark" ||
      (!document.documentElement.dataset.theme &&
        matchMedia("(prefers-color-scheme: dark)").matches);
    const next = dark ? "light" : "dark";
    localStorage.setItem("tcms:theme", next);
    applyTheme(next);
  });
}

// --- router ---
function route() {
  const hash = location.hash.replace(/^#\/?/, "");
  const [head, ...rest] = hash.split("/");
  if (head === "tc" && rest[0]) return { view: "detail", id: decodeURIComponent(rest[0]) };
  if (head === "edit" && rest[0]) return { view: "editor", id: decodeURIComponent(rest[0]) };
  if (head === "new") return { view: "editor", id: null };
  if (head === "connect") return { view: "connect" };
  return { view: "dashboard" };
}

function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function requireAuth(currentHash) {
  if (state.token) return true;
  state.returnTo = currentHash;
  navigate("#/connect");
  return false;
}

function render() {
  const r = route();
  for (const id of ["view-dashboard", "view-detail", "view-editor", "view-connect"]) {
    $(`#${id}`).hidden = true;
  }
  if (r.view === "dashboard") renderDashboard();
  else if (r.view === "detail") renderDetail(r.id);
  else if (r.view === "editor") renderEditor(r.id);
  else if (r.view === "connect") renderConnect();
}

// --- dashboard ---
function renderDashboard() {
  const section = $("#view-dashboard");
  section.hidden = false;
  if (state.indexError) showBanner(state.indexError, true);
  else if (!state.token) {
    showBanner("Read-only view. Connect a GitHub token to create or edit test cases.");
  } else hideBanner();
  renderTiles();
  renderFilterOptions();
  renderTable();
}

function renderTiles() {
  const all = testCases();
  const by = (fn) => all.filter(fn).length;
  const automated = by((tc) => tc.automated === true);
  const tiles = [
    { label: "Total test cases", value: all.length },
    { label: "Active", value: by((tc) => tc.status === "active") },
    { label: "Draft", value: by((tc) => tc.status === "draft") },
    { label: "Deprecated", value: by((tc) => tc.status === "deprecated") },
    {
      label: "Automated",
      value: all.length ? `${Math.round((automated / all.length) * 100)}%` : "—",
      sub: `${automated} of ${all.length}`,
    },
  ];
  const wrap = $("#tiles");
  wrap.replaceChildren(
    ...tiles.map((t) =>
      h("div", { class: "tile" },
        h("div", { class: "label" }, t.label),
        h("div", { class: "value" }, String(t.value)),
        t.sub ? h("div", { class: "sub" }, t.sub) : null
      )
    )
  );
}

function fillSelect(select, placeholder, values, current) {
  select.replaceChildren(
    h("option", { value: "" }, placeholder),
    ...values.map((v) => h("option", { value: v }, v))
  );
  select.value = current;
}

function renderFilterOptions() {
  fillSelect($("#f-suite"), "All suites", suiteNames(), state.filters.suite);
  fillSelect($("#f-priority"), "All priorities", PRIORITIES, state.filters.priority);
  fillSelect($("#f-status"), "All statuses", STATUSES, state.filters.status);
  $("#f-search").value = state.filters.search;
}

function filteredCases() {
  const f = state.filters;
  const needle = f.search.trim().toLowerCase();
  return testCases().filter((tc) => {
    if (f.suite && tc.suite !== f.suite) return false;
    if (f.priority && tc.priority !== f.priority) return false;
    if (f.status && tc.status !== f.status) return false;
    if (needle) {
      const hay = [tc.id, tc.title, tc.owner, tc.linked_ticket, ...(tc.tags || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

function badge(kind, value) {
  if (!value) return h("span", { class: "hint" }, "—");
  return h("span", { class: `badge ${kind}-${value}` }, value);
}

function renderTable() {
  const rows = filteredCases();
  $("#empty-state").hidden = rows.length > 0;
  $("#tc-rows").replaceChildren(
    ...rows.map((tc) =>
      h("tr", { onclick: () => navigate(`#/tc/${encodeURIComponent(tc.id)}`) },
        h("td", {}, h("span", { class: "tc-id mono" }, tc.id)),
        h("td", {}, tc.title || ""),
        h("td", {}, tc.suite || ""),
        h("td", {}, badge("priority", tc.priority)),
        h("td", {}, badge("status", tc.status)),
        h("td", {}, tc.automated === true ? "yes" : "no"),
        h("td", {}, tc.owner || ""),
        h("td", { class: "num" }, tc.updated_at || "")
      )
    )
  );
}

function initFilters() {
  $("#f-search").addEventListener("input", (e) => {
    state.filters.search = e.target.value;
    renderTable();
  });
  for (const [sel, key] of [["#f-suite", "suite"], ["#f-priority", "priority"], ["#f-status", "status"]]) {
    $(sel).addEventListener("change", (e) => {
      state.filters[key] = e.target.value;
      renderTable();
    });
  }
  $("#f-clear").addEventListener("click", () => {
    state.filters = { search: "", suite: "", priority: "", status: "" };
    renderFilterOptions();
    renderTable();
  });
}

// --- detail view ---
function metaItem(label, content) {
  return h("div", {}, h("div", { class: "label" }, label), h("div", {}, content));
}

function renderDetail(id) {
  const section = $("#view-detail");
  section.hidden = false;
  hideBanner();
  const tc = findCase(id);
  if (!tc) {
    section.replaceChildren(
      h("div", { class: "card" },
        h("h2", {}, `${id} not found`),
        h("p", { class: "hint" },
          "It is not in the dashboard index. If it was just created, the index rebuild may still be running."),
        h("p", {}, h("a", { href: "#/" }, "Back to dashboard"))
      )
    );
    return;
  }
  const path = casePath(tc);
  const fileUrl = `https://github.com/${repoSlug()}/blob/${state.config.branch}/${path}`;
  const historyUrl = `https://github.com/${repoSlug()}/commits/${state.config.branch}/${path}`;
  section.replaceChildren(
    h("div", { class: "view-head" },
      h("div", { class: "crumbs" }, h("a", { href: "#/" }, "Dashboard"), ` / ${tc.id}`),
      h("div", {},
        h("button", { onclick: () => navigate(`#/edit/${encodeURIComponent(tc.id)}`), class: "primary" }, "Edit")
      )
    ),
    h("div", { class: "card" },
      h("h2", {}, `${tc.id} — ${tc.title || ""}`),
      h("div", { class: "meta-grid" },
        metaItem("Suite", tc.suite || "—"),
        metaItem("Priority", badge("priority", tc.priority)),
        metaItem("Status", badge("status", tc.status)),
        metaItem("Automated", tc.automated === true ? "yes" : "no"),
        metaItem("Owner", tc.owner || "—"),
        metaItem("Linked ticket", tc.linked_ticket || "—"),
        metaItem("Created", tc.created_at || "—"),
        metaItem("Updated", tc.updated_at || "—")
      ),
      (tc.tags || []).length
        ? h("div", {}, h("h3", {}, "Tags"), (tc.tags || []).map((t) => h("span", { class: "tag" }, t)))
        : null,
      (tc.preconditions || []).length
        ? h("div", {}, h("h3", {}, "Preconditions"),
            h("ul", { class: "plain" }, (tc.preconditions || []).map((p) => h("li", { class: "prewrap" }, p))))
        : null,
      h("h3", {}, "Steps"),
      h("ol", { class: "steps" },
        (tc.steps || []).map((s) =>
          h("li", {},
            h("div", { class: "prewrap" }, s.action || ""),
            s.expected ? h("div", { class: "expected prewrap" }, s.expected) : null
          )
        )
      ),
      h("h3", {}, "Source"),
      h("p", { class: "hint" },
        h("a", { href: fileUrl, target: "_blank", rel: "noopener" }, "View YAML on GitHub"),
        " · ",
        h("a", { href: historyUrl, target: "_blank", rel: "noopener" }, "Change history"),
        " — git history is the audit trail."
      )
    )
  );
}

// --- editor ---
const editor = { current: null };

function emptyCase() {
  return {
    id: nextId(),
    title: "",
    suite: suiteNames()[0] || "",
    priority: "medium",
    status: "draft",
    automated: false,
    owner: state.user || "",
    tags: [],
    linked_ticket: "",
    preconditions: [],
    steps: [{ action: "", expected: "" }],
  };
}

async function renderEditor(id) {
  const section = $("#view-editor");
  section.hidden = false;
  hideBanner();
  const currentHash = id ? `#/edit/${encodeURIComponent(id)}` : "#/new";
  if (!requireAuth(currentHash)) return;
  if (!repoResolved()) {
    section.replaceChildren(h("div", { class: "card" },
      h("h2", {}, "Repository not configured"),
      h("p", {}, "Set owner and repo in config.json.")));
    return;
  }

  if (id) {
    const indexEntry = findCase(id);
    const path = indexEntry ? casePath(indexEntry) : null;
    if (!path) {
      section.replaceChildren(h("div", { class: "card" }, h("h2", {}, `${id} not found`)));
      return;
    }
    section.replaceChildren(h("div", { class: "card" }, h("p", { class: "hint" }, `Loading ${path}…`)));
    try {
      const { sha, text } = await fetchFile(path);
      let tc = null;
      let raw = null;
      try {
        tc = parseYaml(text);
      } catch (err) {
        if (!(err instanceof YamlUnsupportedError)) throw err;
        raw = text; // fall back to raw editing
      }
      editor.current = { isNew: false, path, sha, tc, rawText: raw, originalText: text };
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return; // gh() already rerouted
      section.replaceChildren(h("div", { class: "card" },
        h("h2", {}, "Could not load file"),
        h("p", { class: "form-error" }, err.message)));
      return;
    }
  } else {
    editor.current = { isNew: true, path: null, sha: null, tc: emptyCase(), rawText: null };
  }
  drawEditor();
}

function drawEditor() {
  const section = $("#view-editor");
  const ed = editor.current;
  const title = ed.isNew ? "New test case" : `Edit ${ed.tc ? ed.tc.id : ed.path}`;
  const card = h("div", { class: "card" });
  section.replaceChildren(
    h("div", { class: "view-head" },
      h("div", { class: "crumbs" }, h("a", { href: "#/" }, "Dashboard"), ` / ${title}`),
      ed.rawText === null && !ed.isNew
        ? h("button", { class: "ghost", onclick: () => { ed.rawText = ed.originalText; drawEditor(); } }, "Edit raw YAML")
        : null
    ),
    card
  );
  if (ed.rawText !== null) drawRawEditor(card);
  else drawFormEditor(card);
}

function field(labelText, input, opts = {}) {
  return h("div", { class: `field${opts.wide ? " wide" : ""}` }, h("label", {}, labelText), input, opts.hint ? h("div", { class: "hint" }, opts.hint) : null);
}

function drawFormEditor(card) {
  const ed = editor.current;
  const tc = ed.tc;

  const idInput = h("input", { value: tc.id, readOnly: !ed.isNew });
  const titleInput = h("input", { value: tc.title || "" });
  const suiteInput = h("input", {
    value: tc.suite || "",
    list: "suite-options",
    readOnly: !ed.isNew,
  });
  const suiteList = h("datalist", { id: "suite-options" }, suiteNames().map((s) => h("option", { value: s })));
  const prioritySelect = h("select", {}, PRIORITIES.map((p) => h("option", { value: p, selected: p === tc.priority }, p)));
  prioritySelect.value = tc.priority || "medium";
  const statusSelect = h("select", {}, STATUSES.map((s) => h("option", { value: s, selected: s === tc.status }, s)));
  statusSelect.value = tc.status || "draft";
  const automatedInput = h("input", { type: "checkbox", checked: tc.automated === true, id: "ed-automated" });
  const ownerInput = h("input", { value: tc.owner || "" });
  const ticketInput = h("input", { value: tc.linked_ticket || "" });
  const tagsInput = h("input", { value: (tc.tags || []).join(", "), placeholder: "comma, separated" });
  const preconditionsInput = h("textarea", { rows: 3, placeholder: "One precondition per line" },
    (tc.preconditions || []).join("\n"));

  const stepsWrap = h("div", {});
  const stepRows = [];
  function addStepRow(step = { action: "", expected: "" }) {
    const action = h("textarea", { rows: 2, placeholder: "Action" }, step.action || "");
    const expected = h("textarea", { rows: 2, placeholder: "Expected result" }, step.expected || "");
    const row = h("div", { class: "step-row" }, action, expected,
      h("button", { type: "button", class: "ghost danger", onclick: () => {
        stepRows.splice(stepRows.indexOf(entry), 1);
        row.remove();
      } }, "Remove"));
    const entry = { action, expected };
    stepRows.push(entry);
    stepsWrap.append(row);
  }
  (tc.steps && tc.steps.length ? tc.steps : [{ action: "", expected: "" }]).forEach(addStepRow);

  const summaryInput = h("input", {
    value: ed.isNew ? "create test case" : "update test case",
    placeholder: "Short commit summary",
  });
  const errorBox = h("div", { class: "form-error" });
  const saveBtn = h("button", { class: "primary", type: "button" }, ed.isNew ? "Create" : "Save");
  const conflictBox = h("div", {});

  saveBtn.addEventListener("click", async () => {
    errorBox.textContent = "";
    conflictBox.replaceChildren();
    const collected = {
      id: idInput.value.trim(),
      title: titleInput.value.trim(),
      suite: suiteInput.value.trim(),
      priority: prioritySelect.value,
      status: statusSelect.value,
      automated: automatedInput.checked,
      owner: ownerInput.value.trim(),
      tags: tagsInput.value.split(",").map((t) => t.trim()).filter(Boolean),
      linked_ticket: ticketInput.value.trim(),
      preconditions: preconditionsInput.value.split("\n").map((p) => p.trim()).filter(Boolean),
      steps: stepRows
        .map((r) => ({ action: r.action.value.trim(), expected: r.expected.value.trim() }))
        .filter((s) => s.action || s.expected),
    };
    const problems = [];
    if (!ID_RE.test(collected.id)) problems.push("id must look like TC-0001");
    if (!collected.title) problems.push("title is required");
    if (!SUITE_RE.test(collected.suite)) problems.push("suite must be lowercase kebab-case (e.g. checkout)");
    if (!collected.steps.length) problems.push("at least one step is required");
    if (collected.steps.some((s) => !s.action)) problems.push("every step needs an action");
    if (ed.isNew && findCase(collected.id)) problems.push(`${collected.id} already exists`);
    if (problems.length) {
      errorBox.textContent = problems.join(" · ");
      return;
    }
    collected.created_at = ed.isNew ? today() : tc.created_at || today();
    collected.updated_at = today();

    const path = ed.isNew ? `test-cases/${collected.suite}/${collected.id}.yaml` : ed.path;
    const summary = summaryInput.value.trim() || (ed.isNew ? "create test case" : "update test case");
    await saveFile({
      path,
      text: emitTestCase(collected),
      message: `${collected.id}: ${summary}`,
      indexEntry: { ...collected, path },
      saveBtn,
      errorBox,
      conflictBox,
    });
  });

  card.replaceChildren(
    h("div", { class: "form-grid" },
      field("ID", idInput, { hint: ed.isNew ? "Suggested next free id" : "IDs never change" }),
      field("Suite", suiteInput, {
        hint: ed.isNew ? "Folder under test-cases/ — pick existing or type a new one" : "Fixed — it is the file's folder",
      }),
      suiteList,
      field("Priority", prioritySelect),
      field("Status", statusSelect),
      field("Title", titleInput, { wide: true }),
      field("Owner", ownerInput),
      field("Linked ticket", ticketInput, { hint: "Optional, e.g. a Jira id" }),
      field("Tags", tagsInput),
      h("div", { class: "field check" }, automatedInput, h("label", { for: "ed-automated" }, "Automated")),
      field("Preconditions", preconditionsInput, { wide: true })
    ),
    h("h3", {}, "Steps"),
    stepsWrap,
    h("button", { type: "button", class: "ghost", onclick: () => addStepRow() }, "+ Add step"),
    h("div", { class: "form-actions" },
      saveBtn,
      h("button", { type: "button", class: "ghost", onclick: () => history.back() }, "Cancel"),
      field("Commit summary", summaryInput)
    ),
    errorBox,
    conflictBox
  );
}

function drawRawEditor(card) {
  const ed = editor.current;
  const textarea = h("textarea", { class: "raw-yaml", spellcheck: "false" }, ed.rawText);
  const summaryInput = h("input", { value: "update test case", placeholder: "Short commit summary" });
  const errorBox = h("div", { class: "form-error" });
  const saveBtn = h("button", { class: "primary", type: "button" }, "Save");
  const conflictBox = h("div", {});

  saveBtn.addEventListener("click", async () => {
    errorBox.textContent = "";
    conflictBox.replaceChildren();
    const text = textarea.value.endsWith("\n") ? textarea.value : textarea.value + "\n";
    let parsed = null;
    try {
      parsed = parseYaml(text);
    } catch (err) {
      if (!(err instanceof YamlUnsupportedError)) throw err;
    }
    const idMatch = /^id:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/m.exec(text);
    const id = parsed ? parsed.id : idMatch && (idMatch[1] || idMatch[2] || idMatch[3]);
    const expectedId = ed.path.split("/").pop().replace(/\.yaml$/, "");
    if (id !== expectedId) {
      errorBox.textContent = `The id field (${id || "missing"}) must stay ${expectedId} — it is the file name.`;
      return;
    }
    const summary = summaryInput.value.trim() || "update test case";
    await saveFile({
      path: ed.path,
      text,
      message: `${expectedId}: ${summary}`,
      indexEntry: parsed ? { ...parsed, path: ed.path } : null,
      saveBtn,
      errorBox,
      conflictBox,
    });
  });

  card.replaceChildren(
    h("p", { class: "hint" },
      "Raw YAML mode. The file must satisfy schema/test-case.schema.json — CI validates every change."),
    textarea,
    h("div", { class: "form-actions" },
      saveBtn,
      h("button", { type: "button", class: "ghost", onclick: () => history.back() }, "Cancel"),
      field("Commit summary", summaryInput)
    ),
    errorBox,
    conflictBox
  );
}

async function saveFile({ path, text, message, indexEntry, saveBtn, errorBox, conflictBox }) {
  const ed = editor.current;
  saveBtn.disabled = true;
  try {
    await putFile({ path, text, message, sha: ed.sha });
    if (indexEntry) upsertLocalCase(indexEntry);
    toast("Saved. The dashboard index rebuilds automatically in about a minute.");
    const id = indexEntry ? indexEntry.id : path.split("/").pop().replace(/\.yaml$/, "");
    navigate(`#/tc/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      await showConflict({ path, text, message, indexEntry, saveBtn, errorBox, conflictBox });
    } else if (err instanceof ApiError && err.status === 422 && ed.isNew) {
      errorBox.textContent = `A file already exists at ${path} — pick a different id.`;
    } else if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      // gh() already cleared the token and showed the banner.
    } else {
      errorBox.textContent = err.message || "Saving failed.";
    }
  } finally {
    saveBtn.disabled = false;
  }
}

async function showConflict(ctx) {
  // Someone else changed the file since we read it. Never silently overwrite:
  // show the latest version and make the user choose.
  const ed = editor.current;
  let remote;
  try {
    remote = await fetchFile(ctx.path);
  } catch (err) {
    ctx.errorBox.textContent = `Conflict detected, and re-fetching the file failed: ${err.message}`;
    return;
  }
  ed.sha = remote.sha; // future saves are against the latest version
  ctx.conflictBox.replaceChildren(
    h("div", { class: "conflict" },
      h("h3", {}, "Someone else changed this file"),
      h("p", {}, "It was edited since you opened it. Review the latest version below, then choose:"),
      h("pre", {}, remote.text),
      h("div", { class: "form-actions" },
        h("button", {
          type: "button",
          onclick: () => {
            // Discard local edits and reload the editor from the latest version.
            try {
              editor.current = { ...ed, tc: parseYaml(remote.text), rawText: null, originalText: remote.text };
            } catch {
              editor.current = { ...ed, tc: null, rawText: remote.text, originalText: remote.text };
            }
            drawEditor();
          },
        }, "Load latest (discard my edits)"),
        h("button", {
          type: "button",
          class: "danger",
          onclick: () => saveFile(ctx),
        }, "Overwrite with my version")
      )
    )
  );
}

// --- connect screen ---
function tokenUrl() {
  const params = new URLSearchParams({ contents: "write", expires_in: "90" });
  if (state.config.owner) params.set("target_name", state.config.owner);
  return `https://github.com/settings/personal-access-tokens/new?${params}`;
}

function renderConnect() {
  const section = $("#view-connect");
  section.hidden = false;
  hideBanner();
  const tokenInput = h("input", { type: "password", placeholder: "github_pat_…", autocomplete: "off" });
  const errorBox = h("div", { class: "form-error" });
  const connectBtn = h("button", { class: "primary", type: "button" }, "Connect");

  connectBtn.addEventListener("click", async () => {
    const token = tokenInput.value.trim();
    errorBox.textContent = "";
    if (!token) {
      errorBox.textContent = "Paste a token first.";
      return;
    }
    if (!repoResolved()) {
      errorBox.textContent = "Repository is not configured — set owner and repo in config.json.";
      return;
    }
    connectBtn.disabled = true;
    connectBtn.textContent = "Checking…";
    try {
      await validateToken(token);
      storeToken(token);
      ghJson("/user").then((u) => { state.user = u && u.login; renderHeader(); }).catch(() => {});
      renderHeader();
      toast("Connected. You can now create and edit test cases.");
      const dest = state.returnTo || "#/";
      state.returnTo = null;
      navigate(dest);
    } catch (err) {
      errorBox.textContent = err.message;
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = "Connect";
    }
  });

  section.replaceChildren(
    h("div", { class: "card connect-card" },
      h("h2", {}, "Connect your GitHub account"),
      h("p", {},
        `Editing works through GitHub's API with a fine-grained personal access token scoped to ${repoResolved() ? repoSlug() : "this repository"}. `,
        "The token stays in this browser's localStorage and is only ever sent to api.github.com."),
      h("ol", {},
        h("li", {},
          h("a", { href: tokenUrl(), target: "_blank", rel: "noopener" }, "Create a fine-grained token"),
          " — under “Repository access” select only this repository, and under Permissions grant ",
          h("strong", {}, "Contents: Read and write"), "."),
        h("li", {},
          "If the repository belongs to an organization, pick it as the Resource owner. ",
          h("span", { class: "hint" },
            "Quirk: the dropdown may only look pre-selected — switch it away and back to actually bind it. ",
            "Org policy may also require an admin to approve the token before it works.")),
        h("li", {}, "Generate the token and paste it here:")),
      h("div", { class: "token-row" }, tokenInput, connectBtn),
      errorBox,
      h("p", { class: "hint" },
        "You need Write access to the repository — the token acts as you, and every save becomes a commit under your name.")
    )
  );
}

// --- boot ---
async function boot() {
  initTheme();
  await loadConfig();
  loadToken();
  renderHeader();
  initFilters();
  $("#btn-connect").addEventListener("click", () => navigate("#/connect"));
  $("#btn-disconnect").addEventListener("click", () => {
    clearToken();
    toast("Disconnected. The token was removed from this browser.");
    navigate("#/");
  });
  $("#btn-new").addEventListener("click", () => navigate("#/new"));
  window.addEventListener("hashchange", render);

  await loadIndex();
  render();

  if (state.token) {
    // Validate the stored token once per load; drop it if it went stale.
    validateToken(state.token)
      .then(() => ghJson("/user").then((u) => { state.user = u && u.login; renderHeader(); }).catch(() => {}))
      .catch((err) => {
        if (err instanceof ApiError && [401, 403, 404].includes(err.status)) {
          clearToken();
          showBanner("Your stored GitHub token is no longer valid. Connect again to keep editing.", true);
        }
      });
  }
}

boot();
