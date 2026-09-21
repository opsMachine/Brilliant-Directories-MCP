# BD Claude Setup — Initial Configuration

This project manages Brilliant Directories widgets via their REST API. You need two environment variables to get started.

## Step 1: Get Your Credentials

1. Log into your Brilliant Directories admin panel
2. Navigate to **Developer Hub** → **API Documentation** (or **Settings** → **API Key**)
3. Copy your **API Key**
4. Note your **site URL** (e.g., `https://www.yoursite.com/`)

## Step 2: Set Environment Variables (Windows)

Open **PowerShell as Administrator** and run these commands:

```powershell
[System.Environment]::SetEnvironmentVariable("BD_API_KEY", "YOUR_API_KEY_HERE", "User")
[System.Environment]::SetEnvironmentVariable("BD_SITE_URL", "https://www.yoursite.com/", "User")
```

Replace:
- `YOUR_API_KEY_HERE` with the key from Step 1
- `https://www.yoursite.com/` with your site URL (must include `https://`, trailing slash, and `www.` if applicable)

**Important:** The URL must use `https://` and include the full domain. Examples:
- ✅ `https://www.example.com/`
- ✅ `https://example.com/`
- ❌ `http://example.com` (missing https and trailing slash)

## Step 3: Restart Claude Code

After setting the environment variables, close and reopen Claude Code so it picks up the new variables.

## Step 4: Verify Setup

Claude will automatically test the connection. You should see your widgets listed when you ask to "list widgets" or "render widgets".

---

## Multiple sites on one computer: `--project-root` and `.env`

Global environment variables only hold one site's credentials. To manage several sites, give each project folder its own `.env` file and tell the MCP which folder to use.

1. In each site's project folder, copy `.env.example` to `.env` and fill in that site's `BD_API_KEY` and `BD_SITE_URL`.
2. In that folder's `.mcp.json`, pass the folder with `--project-root`:

```json
{
  "mcpServers": {
    "Brilliant Directories Widgets MCP": {
      "command": "node",
      "args": ["C:\\path\\to\\Brilliant-Directories-MCP\\mcp-server\\index.js", "--project-root", "C:\\path\\to\\Site A"]
    }
  }
}
```

The project root decides where `workspace/`, `snapshots/` and `previews/` live, and which `.env` is loaded. Values in the project's `.env` override global environment variables. The MCP logs the project root and site URL it connected to at startup.

**How the project root is chosen** (first match wins):

1. `--project-root <path>` argument (relative paths resolve from the folder Claude Code starts the server in)
2. `BD_PROJECT_ROOT` environment variable
3. The folder above `mcp-server/` (this repo)

Restart Claude Code after changing `.mcp.json` or `.env`.

---

## Automatic snapshots (before risky operations)

The MCP copies `workspace/{widget}/` into `snapshots/{ISO-timestamp}_{widget_id}_{widget-name}/` **before**:

- **`push_widget`** — pre-push backup of exactly what is about to go live.
- **`get_widget`** — when it overwrites an existing (but empty) workspace folder, or after you manually cleared the folder — see below.

Each snapshot includes **`snapshot-meta.json`** (`reason`, `widget_id`, `widget_name`, `created_at`).

## Re-fetching a widget when `workspace/` already has code

**There is no `force` flag.** If `workspace/{widget-name}/` already contains non-empty widget files, **`get_widget` will refuse** to overwrite them.

To replace local files with the live BD version:

1. **Manually delete or rename** `workspace/{widget-name}/` (in Explorer, or `rm -rf` in a terminal).
2. Call **`get_widget`** again.

This stops assistants from silently wiping local widget work.

**Rollback (local):** copy files from a snapshot folder back into `workspace/{widget-name}/`, then `push_widget` if you need to restore production.

**Git commits** are still recommended for intentional history and PRs; snapshots are automatic filesystem backups that do not require git.

---

## Troubleshooting

**"BD_API_KEY and BD_SITE_URL must be set in ... .env or as environment variables"**
- The message shows which `.env` path it looked for — check that file exists and has both values
- Close Claude Code completely and reopen it
- Verify the environment variables are set: open PowerShell and run `$env:BD_API_KEY` — you should see your key

**"Widget not found" or "Invalid Request Method"**
- Ensure your `BD_SITE_URL` starts with `https://` (not `http://`)
- Ensure the URL ends with `/`
- If your domain redirects (e.g., `example.com` → `www.example.com`), use the target URL

**API key invalid**
- Verify you copied the full key with no extra spaces
- Regenerate the key in your BD admin panel if unsure
