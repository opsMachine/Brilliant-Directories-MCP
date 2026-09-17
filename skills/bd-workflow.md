# BD Widget Workflow

## Session Start

At the start of every session, list all available custom widgets before doing anything else.

```
GET {BD_SITE_URL}/api/v2/data_widgets/get
```

Display results as a table showing at minimum:

| widget_id | widget_name | date_updated |
|-----------|-------------|--------------|

This gives the user a clear picture of what exists before any edits begin.

---

## Git, `main`, and multiplayer BD

Brilliant Directories has **no staging environment**: `push_widget` writes **production** immediately. When the widget files also live in a **GitHub-backed repo** (separate app code, Vercel functions, *and* tracked `workspace/{widget}/` trees), treat Git as the **revision ledger** and BD as **live execution**.

### Default order: Git `main` first, then live

Use this order unless the user explicitly chooses a different emergency process:

1. **Fetch → edit → render** (this skill’s loop) on a **feature branch** when others may be working.
2. **Commit** the `workspace/{widget}/` (and any related API or config) changes to that branch.
3. **Merge to `main`** (PR or direct merge — follow the team’s gate). **`main` should contain the exact bytes you intend to go live** before you call `push_widget`, or you merge in the **same session immediately after** a live push only when fixing production under fire — in that case still land on `main` right away so the repo never lags BD.
4. **`push_widget` last** among publish steps so “what’s on `main`” and “what’s live on BD” stay aligned for forensics, rollback, and teammates.

Why: BD does not version merges for you. Two people can still collide, but **Git history on `main` should mirror intentional live state** so you are never guessing which PHP is “real.”

### Reducing collisions between humans

- **Claim a widget** for the working session (chat, ticket, or stand-up): one active editor per widget name when possible.
- **Re-list before a long session or before push:** compare `date_updated` from `list_widgets` to when you fetched. If live is newer than your local session, **clear `workspace/{name}/` and `get_widget` again** before editing or pushing.
- **Never push** after hours of idle time without confirming the widget list still matches your assumptions.

### Vercel (or any host) alongside BD

If the same Git repo deploys **serverless routes** (SMS, cron proxies, etc.) to Vercel:

- Prefer **automatic deploys from `main`** (Git integration) for production and previews. Treat **CLI deploys** (`vercel --prod`) as exceptional; if you use them, still **commit to `main` first** so the repo matches what you shipped.
- **Order of operations when a change touches both BD widgets and API routes:** merge API changes to `main`, let CI/Vercel deploy (or deploy once from `main`), then **`push_widget`** — or follow a written runbook if the product requires API-before-widget. Document exceptions per project.

---

## The Edit Loop

Every widget edit follows this exact sequence. Do not skip or reorder steps.

```
1. FETCH   → get_widget → saves files to workspace/{name}/, returns metadata + paths
2. READ    → use Read tool on the relevant file(s) — only what's needed
3. PROPOSE → show the exact changes you intend to make (diff or before/after)
4. CONFIRM → wait for explicit user approval ("yes", "go ahead", "push it", etc.)
5. EDIT    → use Edit tool on workspace/{name}/ files
6. RENDER  → render_widget → rebuilds preview from local workspace, browser auto-refreshes
7. GIT     → when using Git: commit workspace (and related) changes; merge to `main` before live push (see “Git, `main`, and multiplayer BD”)
8. PUSH    → push_widget → reads from workspace, sends PUT to BD API
9. VERIFY  → confirm response is "pushed successfully"
10. REMIND → tell user to refresh the BD site cache
```

Never jump to step 5 without completing steps 1–4.

When the project does **not** use Git for widget files, treat step 7 as “ensure backups / snapshots acceptable” and continue; otherwise **do not push live without `main` containing the same change set** (team default).

Large content never passes through the LLM as tool output — `get_widget` saves to disk,
`push_widget` reads from disk. The LLM only touches content via `Read` and `Edit` tool calls.

---

## Fetch Rules

When fetching a widget, `get_widget` returns only:

- `widget_id`, `widget_name`, `date_updated` — confirm you have the right widget
- `files` — paths to the three workspace files

Read individual files with the `Read` tool as needed. Do not read all three unless necessary.

If the widget name is ambiguous or unconfirmed, fetch the full list first and ask the user to identify which widget they mean.

**Re-fetch guard:** If `get_widget` returns **BLOCKED** (local workspace already has widget files), stop. There is **no `force` parameter**. Tell the user:

> "To pull the live widget from BD, delete or move the folder `workspace/<widget-name>/`, then ask me to run `get_widget` again."

Only the user (or the user instructing you explicitly) may delete that folder. Never run `rm -rf` on `workspace/` unless the user asked you to discard local copies.

**Push staleness risk:** There is no version check on push. If the widget was edited on BD between your fetch and your push, your push will silently overwrite those changes. Mention this to the user if the session has been open for a long time before pushing. **With Git:** this is the same risk plus branch skew — prefer a **fresh `get_widget`** (after clearing the local widget folder if needed) when `date_updated` on the list is newer than your last fetch, then re-apply edits on top of `main` before pushing.

---

## Proposing Changes

Before pushing any change:

1. Show the current value and the proposed new value for each field being changed
2. For unchanged fields, note "unchanged — keeping current value"
3. Ask: "Should I push this to production?"

Only proceed after an affirmative response in the chat.

---

## API Response Validation

After every API call:

1. Check that the response contains `"status": "success"`
2. If status is not `"success"`, treat the operation as failed
3. Show the full error response to the user
4. Stop — do not retry automatically

Success looks like:
```json
{ "status": "success", "message": [...] }
```

Failure looks like:
```json
{ "status": "error", "message": "Something went wrong" }
```

---

## After a Successful Widget Update

Always remind the user:

> "Widget updated successfully. Remember to refresh your BD site cache — go to BD Admin and use the cache refresh tool to make the changes visible on your site."

---

## Widget Name Rules

- Never assume or infer a widget name from context
- If unsure of the exact name, fetch the full widget list and ask the user to confirm
- Widget names are case-sensitive in the API — use the exact name as returned by GET

---

## Render Preview

`render_widget` uses a **hybrid approach**: BD's server executes the PHP to produce real content, then your local CSS and JavaScript edits are applied on top.

```
render_widget(widget_name)
  → reads workspace/{name}/meta.json for the widget ID
  → calls BD API to render the widget — PHP executes, real data loads
  → injects local style.css + javascript.js on top of the rendered output
  → builds full HTML page with Bootstrap 3
  → writes to previews/{name}.html
  → first call opens browser at localhost:4444/{name}.html
  → subsequent calls auto-refresh the existing tab
```

**What you see vs. what's live:**

| Change type | Visible in preview? | Needs push first? |
|-------------|--------------------|--------------------|
| CSS edits (`style.css`) | Yes — immediately | No |
| JS edits (`javascript.js`) | Yes — immediately | No |
| HTML edits (`data.html`) | No — BD renders from live version | Yes — push first, then re-render |

This means:
- If you're only changing styling or JavaScript, re-render to see the result before pushing
- If you're changing the HTML content (`data.html`), push first then re-render to confirm

**Explaining this to the user:**
> "The preview fetches the real content from your live site, then applies your local CSS and JavaScript changes on top. So you can see exactly how your styling changes will look with real data — without having to push first."

Notes:
- `get_widget` must be called first to populate the workspace (creates `meta.json`)
- The `previews/` folder is gitignored — throwaway files
- Re-render after every CSS/JS edit to see the change in the browser

---

## What We Never Do

- Never use the DELETE endpoint
- Never push changes without explicit user confirmation in the current session
- Never retry a failed push automatically — show the error and stop
- Never edit a widget without fetching its current state first

---

## Preview Limitations

The local preview renders real PHP/database content via BD's API, but **BD's global platform CSS is not available locally**. This causes known cosmetic issues that are NOT bugs:

- **Nav bar**: text appears white-on-white because BD's global stylesheet provides the dark nav background, which our preview doesn't load. Looks correct on the live site.
- Any styling that comes from BD's platform-level CSS (not the widget's own `style.css`) won't appear in preview.

Do not investigate or attempt to fix these — they are expected preview limitations.

---

## Site Notes

- **Site:** `https://www.example.com/` — Brilliant Directories membership site
- **Client:** Non-technical — expects plain-language guidance, not widget IDs or API terminology

---

## Quick Reference: MCP Tools

Use the MCP tools instead of calling the API directly. They handle authentication, content encoding, and file management.

```
list_widgets()                               → List all widgets
get_widget(id)                               → Fetch widget, save to workspace/
push_widget(widget_id, widget_name)          → Read workspace, push to BD API
render_widget(widget_name)                   → Build preview from local workspace, open in browser
```

The MCP server handles all content as form-encoded form-data. No manual curl requests needed.

---

## BD Database Facts

- **Active account flag**: `users_data.active = 2` = fully Active. Any other value = inactive/cancelled/etc. Do NOT use `account_status` for active detection — unreliable.
- **Parent/sub-account hierarchy**: `users_data.parent_id = 0` = main account; `!= 0` = sub-account. To query all records for parent + sub-accounts: `SELECT user_id FROM users_data WHERE parent_id = '$userId' UNION SELECT '$userId' AS user_id`.
- **Favourites table**: `users_favorite` — columns: `userId` (who saved), `ownerId` (vendor), `dataType` (10 = member listing).
- **Do NOT join `users_data` with a `users` table** — that table name doesn't exist in BD and silently returns empty rows for every query, breaking all output.

---

## JS in Widgets — Backslash Escape Stripping

**CRITICAL**: BD widget storage strips JavaScript backslash escape sequences on save. `'\r\n'` becomes `'rn'`, `'\ufeff'` becomes `'ufeff'`. This breaks CSV downloads and any string using escape sequences.

Always use `String.fromCharCode()` instead:
- CRLF: `String.fromCharCode(13, 10)`
- UTF-8 BOM: `String.fromCharCode(65279)`

---

## BD Base Theme Overrides

- **`.bookmark-number`**: BD's base theme applies `position: absolute` to this class. To keep it inline inside a button, override: `position: static !important; top: auto !important; right: auto !important; width: auto !important`.
