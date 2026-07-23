# Simple TCMS for GitHub Pages

A Test Case Management System that runs **entirely inside one GitHub repository** — no servers, no databases, no third-party services. GitHub Pages serves the dashboard, GitHub's REST API is the backend, git is the database, and git history is the audit trail.

Fork it, enable Pages, and you have a working TCMS for your team.

- **Dashboard** — stat tiles, search, and filters over all test cases; readable by anyone who can reach the page, no login needed.
- **Editor** — create and edit test cases in a form (or raw YAML); every save is a commit attributed to the editor's own GitHub account.
- **Test cases as code** — one YAML file per test case, validated against a JSON Schema in CI, reviewable and diffable like any code.

## How it works

- Each test case is a YAML file at `test-cases/<suite>/<TC-ID>.yaml`.
- On every push touching `test-cases/`, the `rebuild-index.yml` workflow aggregates all files into `dashboard-data/index.json` and commits it. The dashboard renders from that single static file — no API calls, no rate limits, no auth just to view.
- Saving from the editor calls GitHub's Contents API directly from the browser, authenticated with the user's own fine-grained Personal Access Token (stored in `localStorage`, sent only to `api.github.com`).
- Concurrent edits are detected via the file's git `sha` — a conflicting save is never silently overwritten; the editor shows the latest version and asks the user to reconcile.
- `validate-test-case.yml` checks every changed file against `schema/test-case.schema.json` plus repo conventions (file name matches `id`, folder matches `suite`, ids unique).

The full architecture — including why "Login with GitHub" OAuth is impossible under the zero-infrastructure constraint — is in [`docs/tcms-github-pages-architecture.md`](docs/tcms-github-pages-architecture.md).

## Setup (once per fork)

1. **Fork or copy this repository.** Private repos work; note that GitHub Pages on a private repo requires an Enterprise plan (on Free/Pro plans, the Pages site of a private repo is public or unavailable — check your plan).
2. **Enable GitHub Pages:** Settings → Pages → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)`.
3. **Optionally edit `config.json`:**
   - `owner` / `repo` — leave empty to auto-detect from the standard `https://<owner>.github.io/<repo>/` Pages URL. Set explicitly if you use a custom domain.
   - `branch` — the branch edits are committed to (default `main`).
   - `title` — the name shown in the dashboard header.
4. **Replace the sample data:** the files under `test-cases/` are examples — edit or delete them (the index rebuilds automatically).
5. **Give your team access:** everyone who should be able to *edit* needs Write access to the repo, plus their own token (next section).

### Per-user: connecting a token

Editing requires a fine-grained Personal Access Token, created once per person:

1. Open the dashboard → **Connect GitHub** — the link there pre-fills the token form, or go to GitHub → Settings → Developer settings → Fine-grained tokens.
2. Repository access: **only this repository**. Permissions: **Contents: Read and write** (Metadata: Read is added automatically).
3. Paste the token into the connect screen. It is stored in that browser's `localStorage` and never sent anywhere except `api.github.com`.

Organization notes (from the architecture doc, worth checking with your org admin):

- Org-scoped fine-grained PATs are capped at 366 days — plan for annual renewal. The app detects expired tokens and asks to reconnect.
- By default, an org owner must approve each new fine-grained PAT before it can access org repositories.
- The `target_name` URL parameter only *visually* pre-selects the org in the token form's Resource owner dropdown — switch it away and back to actually bind it.

## Repository layout

```
test-cases/<suite>/TC-NNNN.yaml   # one file per test case (the data)
schema/test-case.schema.json      # what a valid test case looks like
dashboard-data/index.json         # generated aggregate — never edit by hand
scripts/build_index.py            # aggregates YAML files into index.json
scripts/validate_test_cases.py    # schema + convention checks (CI)
.github/workflows/                # rebuild-index.yml, validate-test-case.yml
index.html / app.js / styles.css  # the dashboard & editor (static, no framework)
yaml.js                           # browser-side YAML subset parser/emitter
tests/                            # unit tests (node --test + python unittest)
docs/tcms-github-pages-architecture.md  # the full architecture & rationale
```

## Test case format

```yaml
id: TC-0001
title: User can complete checkout with saved card
suite: checkout
priority: high            # low | medium | high | critical
status: active            # draft | active | deprecated
automated: false
owner: sample.user
tags:
  - regression
linked_ticket: PROJ-1001  # optional
preconditions:
  - User is logged in
steps:
  - action: Add an item to the cart
    expected: Item appears in cart with correct price
created_at: "2026-07-24"
updated_at: "2026-07-24"
```

Conventions enforced by CI: the file name must equal `id`, the folder must equal `suite` (lowercase kebab-case), ids are unique, and `dashboard-data/index.json` is generated — never hand-edited. Commit messages follow `<TC-ID>: <short summary>`.

To change the fields, edit `schema/test-case.schema.json` and the editor form in `app.js` (and `FIELD_ORDER` in `yaml.js` for file ordering).

## Development

No build step. To work on the app locally:

```bash
python3 -m http.server 8000    # from the repo root
# open http://localhost:8000
```

Run the tests:

```bash
node --test tests/*.test.mjs               # YAML parser/emitter
pip install pyyaml jsonschema
python3 -m unittest discover -s tests      # index builder + validator
python3 scripts/validate_test_cases.py     # validate the real test cases
python3 scripts/build_index.py             # rebuild the index locally
```

## Security model

- The site ships zero third-party scripts and a strict Content-Security-Policy, because anything executing on the Pages origin could read tokens from `localStorage`.
- A token never grants more than its owner's own repo permissions, and every commit is attributed to the person who made it — `git blame` and history work exactly as with a normal git workflow.
- Repo permissions are the access control: give Write access only to people who should save changes. For per-folder control, route writes through PRs with `CODEOWNERS` (see Section 10 of the architecture doc).
