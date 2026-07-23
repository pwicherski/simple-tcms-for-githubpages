# Test Case Management System on GitHub Pages — Architecture & Implementation Guide

## 1. Goals & constraints

- A custom-built dashboard and test case editor, fully bespoke look and feel — not GitHub's native UI.
- Runs entirely on **GitHub Pages** (static hosting).
- The repository is **private**, inside a **private company GitHub organization**.
- Hard constraint: **zero code or infrastructure outside the GitHub repository.** No external servers, no serverless functions, no third-party hosting, nothing running anywhere except what GitHub itself provides (Pages + Actions) and the browser.
- Any authorized person should be able to view the dashboard and create/edit test cases through the GUI, without needing to touch git directly.

This document is the reference for implementation. It captures the architecture we settled on, the alternatives we ruled out and why, and enough concrete detail (schemas, workflows, API calls) to start building directly from it.

---

## 2. Core mental model

GitHub Pages only serves static files — HTML, CSS, JS. There is no server-side execution, no database, nothing running on GitHub's side when someone visits the page.

Because of that, **every "edit" in this system is really just the browser calling GitHub's own REST API** (`api.github.com`) directly, using a credential the browser holds. GitHub's API is the backend. Pages is only the frontend sitting on top of it.

This has a genuinely useful side effect: test cases live as files in the git repository, so git itself becomes the database, and git's commit history becomes a full audit trail and change log for every test case — for free, with no extra tooling.

---

## 3. Why "click to log in with GitHub" (OAuth) was ruled out

This was explored in detail and rejected specifically because of the "zero code outside the repo" constraint. Recording the reasoning here so it isn't re-litigated later:

- A standard "Login with GitHub" flow requires exchanging a one-time authorization `code` for an access token. That exchange call must include a client secret, which can never be safely shipped to a browser.
- GitHub's own OAuth endpoints (`github.com/login/oauth/access_token`, and the device-flow endpoints) **do not support CORS** for direct browser requests — this applies even to the secret-less "device flow" that CLI tools use. GitHub deliberately blocks direct browser calls to the device flow for security reasons.
- Completing either flow therefore always requires *some* server-side process to sit between GitHub's redirect and the app.
- GitHub does not offer a first-party product that can fill that role while still living "in the repo": GitHub Pages is static-only, and GitHub Actions triggers on repository *events* (push, issue opened, schedule) — it has no way to receive an arbitrary incoming HTTP redirect from a browser.

**Conclusion:** given the constraint as stated, a one-click OAuth login without any code running outside the repository is not achievable. The chosen alternative is per-user **Personal Access Tokens (PATs)**, generated once by each person and stored client-side.

### 3.1 Alternatives considered and rejected

| Option | Why it was rejected |
|---|---|
| OAuth App / GitHub App + small serverless proxy (Cloudflare Worker, Vercel function, etc.) | Requires code running outside the repo — violates the hard constraint. |
| GitHub App using installation access tokens (bot-style writes, no need for users to be collaborators) | Still requires an external server to mint/serve installation tokens from the App's private key — same problem. |
| GitHub Issues + Issue Forms as the actual editing surface (native GitHub UI, zero custom code for editing) | Fully satisfies the "zero code outside the repo" constraint and is a legitimate option, but rejected here because the goal is a fully custom-branded dashboard and edit experience, not GitHub's native issue page. Worth revisiting if the custom-UI requirement ever relaxes. |
| **Per-user fine-grained Personal Access Token, pasted once, stored in the browser** | **Chosen.** No server anywhere. All calls go directly from the browser to `api.github.com`, which does support CORS. Fully custom UI for both reading and writing. |

---

## 4. Chosen architecture

- Each authorized person generates their **own fine-grained Personal Access Token**, scoped to just this one repository.
- They paste it into the app **once**. It's stored in the browser's `localStorage`.
- All reads and writes happen directly from the browser to `api.github.com`, authenticated with that token.
- No server, GitHub App, or Action is involved in authentication at all — auth is entirely client-side plus GitHub's own token infrastructure.
- Because the token acts as that person's own GitHub identity, every commit is naturally attributed to them — git blame and history work exactly as they would with any normal git workflow. This also means **each person must already be a collaborator (or on a team) with at least Write access to the repo** — a token can never grant more access than the underlying account already has.

---

## 5. Data model

Each test case is a single file, so it's git-diffable and reviewable like code.

**Format:** YAML (readable, git-friendly, easy to validate against a schema).

**Proposed fields** (adjust before building — see Section 14):

```yaml
id: TC-0001
title: User can complete checkout with saved card
suite: checkout
priority: high            # low | medium | high | critical
status: active            # draft | active | deprecated
automated: false
owner: piotr.wicherski
tags:
  - regression
  - payments
linked_ticket: UMA-19870   # optional, e.g. Jira ID
preconditions:
  - User is logged in
  - User has a saved payment card
steps:
  - action: Add an item to the cart
    expected: Item appears in cart with correct price
  - action: Proceed to checkout and select the saved card
    expected: Saved card is pre-selected and order total is shown
  - action: Confirm the order
    expected: Order confirmation screen appears with order number
created_at: 2026-07-21
updated_at: 2026-07-21
```

Git history already tracks *who* changed *what* and *when* — there's no need to hand-roll a changelog field.

---

## 6. Repository structure

```
/
├── test-cases/
│   ├── checkout/
│   │   ├── TC-0001.yaml
│   │   └── TC-0002.yaml
│   ├── onboarding/
│   │   └── TC-0003.yaml
│   └── ...
├── schema/
│   └── test-case.schema.json      # JSON Schema used to validate every test case file
├── dashboard-data/
│   └── index.json                  # generated aggregate — rebuilt by Actions, never hand-edited
├── .github/
│   └── workflows/
│       ├── rebuild-index.yml       # aggregates test-cases/**.yaml into dashboard-data/index.json
│       └── validate-test-case.yml  # validates changed files against the schema
├── docs/
│   └── tcms-github-pages-architecture.md   # this document
├── index.html                      # dashboard entry point
├── app.js                          # dashboard + editor logic (auth, read, write)
└── styles.css
```

---

## 7. Read path — building the dashboard

The dashboard should **not** call the GitHub API repeatedly to build itself — with hundreds of test cases that burns through rate limits fast (5,000 requests/hour per authenticated user, 60/hour unauthenticated) and is slow.

Instead:

1. A GitHub Actions workflow runs on every push that touches `test-cases/**`.
2. It walks every YAML file, parses it, and aggregates everything into one file: `dashboard-data/index.json`.
3. It commits that file back to the repo.
4. The dashboard fetches only that one JSON file — either straight from Pages (since it's committed into the repo) or via `raw.githubusercontent.com`. No authentication needed just to *view* the dashboard, and only one HTTP request to render it.

**`rebuild-index.yml` (skeleton):**

```yaml
name: Rebuild dashboard index

on:
  push:
    branches: [main]
    paths:
      - "test-cases/**.yaml"

permissions:
  contents: write

jobs:
  rebuild:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build dashboard-data/index.json
        run: |
          # pseudocode — replace with a real script (Node/Python) that:
          # 1. walks test-cases/**/*.yaml
          # 2. parses each file
          # 3. writes a single JSON array to dashboard-data/index.json
          node scripts/build-index.js

      - name: Commit updated index
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add dashboard-data/index.json
          git diff --cached --quiet || git commit -m "chore: rebuild dashboard index"
          git push
```

This workflow uses the automatically-provided `GITHUB_TOKEN` — no secrets to create or manage, and it never leaves GitHub's own infrastructure.

---

## 8. Write path — creating and editing a test case

Sequence for a single edit:

1. User fills out the form in the dashboard (new test case, or editing an existing one).
2. If editing an existing file, the app first does a `GET` on the file to retrieve its current `sha` — this is required for the update call and is also how conflicts get detected.
3. The app calls the Contents API to create or update the file:

```javascript
async function saveTestCase({ owner, repo, path, content, message, sha, token }) {
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(content))), // base64-encode the YAML
    ...(sha ? { sha } : {}), // include sha only when updating an existing file
  };

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      body: JSON.stringify(body),
    }
  );

  if (res.status === 409) {
    // Someone else edited this file since we last read it.
    // Re-fetch the latest version and ask the user to reapply/merge their change.
    throw new ConflictError();
  }

  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status}`);
  }

  return res.json();
}
```

4. On success, the GitHub Actions workflow from Section 7 fires automatically and rebuilds `dashboard-data/index.json` — the dashboard can either poll briefly or just show an optimistic local update while the real index catches up.
5. On a `409` (SHA mismatch — a concurrent edit), don't silently overwrite: re-fetch the current file and prompt the user to reconcile before retrying.

**Commit message convention** (suggested): `<TC-ID>: <short summary>` — e.g. `TC-0001: update expected result for saved-card checkout`. Keeps `git log` on `test-cases/` genuinely useful as a change history.

---

## 9. Authentication & token handling

### 9.1 Token creation UX

Use GitHub's fine-grained PAT **template URLs** to pre-fill as much of the token-creation form as possible, so the person mostly just reviews and clicks Generate:

```
https://github.com/settings/personal-access-tokens/new?target_name=YOUR_ORG&contents=write&expires_in=90
```

**Known quirk:** when the token is scoped to an organization, the `target_name` parameter only visually pre-selects the org in the "Resource owner" dropdown — it doesn't fully bind until the person manually switches the dropdown away and back. Mention this in the connect-screen copy so people aren't confused when it doesn't look "done" automatically.

**Recommended permissions:** `Contents: Read and write` (and `Metadata: Read`, which GitHub requires automatically). Nothing else is needed for this use case.

### 9.2 Organization policy considerations

Two org-level defaults will affect rollout — check both with whoever administers the GitHub org before onboarding people:

- **Lifetime cap:** fine-grained PATs scoped to organization resources are capped at a maximum lifetime, 366 days by default. Org owners can shorten this but not extend it past 366 days. Practically: plan for **annual token renewal**, not "generate once, forever."
- **Approval requirement:** by default, GitHub requires an org owner to approve each new fine-grained PAT before it can access organization resources. This is a one-time click per person, done by an org admin — not something the end user can do themselves. Decide up front whether to keep this (more secure, small admin overhead) or relax it (smoother onboarding).

### 9.3 Client-side storage & lifecycle

- Store the token in `localStorage` under a clear, namespaced key.
- On app load: check for a stored token → validate it with one lightweight call (e.g. `GET /repos/{owner}/{repo}`) → if valid, go straight to the dashboard; if missing or invalid, show the connect screen.
- On any `401`/`403` during normal use: treat it as an expired or revoked token — clear it from storage and show the connect screen again, rather than surfacing a raw error.
- The token is never sent anywhere except `api.github.com` — no server, anywhere, ever sees it.
- Since anything with script execution on the Pages origin can read `localStorage`, keep the site free of any third-party or injected scripts.
- Losing access to a device (browser cleared, new machine) just means generating a fresh token — GitHub only shows a token's value once at creation, so there's nothing to "recover," only to reissue.

---

## 10. Access control

- The baseline permission model is GitHub's own repo collaborator/team permissions — only give people Write access if they should be able to save changes.
- GitHub's permissions are repo- or branch-level, **not** path-level. There's no native way to say "this person can only edit test cases under `/checkout/`."
- If path-level control turns out to matter, the way to get it is to route writes through a **branch + pull request** instead of direct commits to `main`, and use a `CODEOWNERS` file plus branch protection to require the right reviewer per folder before merge. This adds review friction (an edit becomes "propose → get approved → merged," not instant), so treat it as an optional enhancement rather than part of the initial build.

---

## 11. Automation summary (GitHub Actions)

| Workflow | Trigger | Purpose |
|---|---|---|
| `rebuild-index.yml` | Push to `test-cases/**.yaml` on `main` | Aggregate all test case files into `dashboard-data/index.json` |
| `validate-test-case.yml` (optional) | Push or PR touching `test-cases/**.yaml` | Validate each changed file against `schema/test-case.schema.json`; fail the check if invalid |

Both use the automatically-provided `GITHUB_TOKEN` scoped to the repo they run in — no secrets to create or manage, and nothing leaves GitHub's infrastructure.

---

## 12. Known limitations & operational notes

- **Rate limits:** 5,000 requests/hour per authenticated user against `api.github.com`. Not a concern for this design since dashboard reads go through the cached `index.json`, not live API calls.
- **Concurrent edits:** handled via optimistic concurrency on file `sha`. Expect occasional `409`s in practice if two people touch the same test case at once — build the "someone else changed this, refresh?" path from the start, not as an afterthought.
- **Token expiration:** annual renewal at minimum for org-scoped tokens (Section 9.2). Build graceful re-authentication in from day one (Section 9.3), don't bolt it on later.
- **File size:** GitHub recommends keeping individual files under 1MB (hard limit is far higher). Test case YAML files will be nowhere near this.
- **No cross-device sync:** the stored token lives in one browser on one device. A new browser or device means generating (or re-pasting, if still saved somewhere secure) a token again.

---

## 13. Suggested implementation phases

1. **Scaffolding:** repo structure, JSON Schema, a handful of hand-written sample test cases, and a read-only dashboard that renders a manually-committed `index.json` (no auth yet).
2. **Automate the read path:** add `rebuild-index.yml` so `index.json` is always generated from the real files.
3. **Auth:** build the connect screen, token paste-in, validation call, `localStorage` persistence, and the 401-handling re-auth path.
4. **Write path:** create/edit forms wired to the Contents API, including the `sha`-based conflict handling.
5. **Validation & polish:** add `validate-test-case.yml`, refine error states, refine the dashboard UI.
6. **Optional:** move to a PR-based review workflow with `CODEOWNERS` if path-level access control becomes necessary.

---

## 14. Open decisions to confirm before building

- Final field list for the test case schema (Section 5) — anything to add, rename, or drop.
- Direct commits to `main` vs. a PR-based review flow for every edit (affects how "instant" saving feels).
- Whether to relax the organization's fine-grained PAT approval requirement (Section 9.2).
- Folder/taxonomy convention for suites or modules under `test-cases/`.
