#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { parseEnv } from 'util';

const MCP_DIR = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_PROJECT_ROOT = path.resolve(MCP_DIR, '..');

/** Value of `--project-root <path>` or `--project-root=<path>`, or null. */
function projectRootArg() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project-root') return args[i + 1] ?? null;
    if (args[i].startsWith('--project-root=')) return args[i].slice('--project-root='.length);
  }
  return null;
}

/** Precedence: --project-root arg > BD_PROJECT_ROOT env > folder above mcp-server/. */
function resolveProjectRoot() {
  for (const raw of [projectRootArg(), process.env.BD_PROJECT_ROOT]) {
    if (raw != null && String(raw).trim() !== '') {
      return path.resolve(process.cwd(), raw);
    }
  }
  return LEGACY_PROJECT_ROOT;
}

const PROJECT_ROOT = resolveProjectRoot();
const PREVIEWS_DIR  = path.join(PROJECT_ROOT, 'previews');
const WORKSPACE_DIR = path.join(PROJECT_ROOT, 'workspace');
const SNAPSHOTS_DIR = path.join(PROJECT_ROOT, 'snapshots');

// Project-local .env overrides global env vars so each site folder uses its own credentials.
const ENV_FILE = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(ENV_FILE)) {
  Object.assign(process.env, parseEnv(fs.readFileSync(ENV_FILE, 'utf8')));
}

const API_KEY  = process.env.BD_API_KEY;
const SITE_URL = process.env.BD_SITE_URL?.replace(/\/$/, '');

if (!API_KEY || !SITE_URL) {
  console.error(`Error: BD_API_KEY and BD_SITE_URL must be set in ${ENV_FILE} or as environment variables.`);
  process.exit(1);
}
console.error(`BD MCP: project root ${PROJECT_ROOT}, site ${SITE_URL}`);

const BASE_URL = `${SITE_URL}/api/v2`;

// ── Helpers ────────────────────────────────────────────────────────────────

async function bdRequest(method, endpoint, body) {
  const options = {
    method,
    headers: { 'X-Api-Key': API_KEY },
  };
  if (body) {
    options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    options.body = new URLSearchParams(body).toString();
  }

  const response = await fetch(`${BASE_URL}${endpoint}`, options);
  const data = await response.json();

  if (data.status !== 'success') {
    throw new Error(typeof data.message === 'string' ? data.message : JSON.stringify(data.message));
  }
  return data;
}

/** Strip fields BD never returns via API but may appear in error payloads. */
function sanitizeUserRecord(user) {
  if (!user || typeof user !== 'object') return user;
  const out = { ...user };
  for (const key of ['password', 'token', 'cookie']) {
    delete out[key];
  }
  return out;
}

function toSafeName(name) {
  return name.replace(/[<>:"/\\|?*\s]/g, '-');
}

function workspaceDir(widgetName) {
  return path.join(WORKSPACE_DIR, toSafeName(widgetName));
}

/**
 * Copy current workspace/{widget}/ to snapshots/{timestamp}_{id}_{name}/ before destructive ops.
 * Independent of git — rollback: copy snapshot folder contents back over workspace/{name}/.
 * Returns absolute path to snapshot dir, or null if nothing to copy.
 */
function snapshotWidgetWorkspace(widgetName, widgetId, reason) {
  const src = workspaceDir(widgetName);
  if (!fs.existsSync(src)) return null;
  const hasFiles = ['data.html', 'style.css', 'javascript.js', 'meta.json'].some((f) =>
    fs.existsSync(path.join(src, f))
  );
  if (!hasFiles) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destName = `${stamp}_${widgetId}_${toSafeName(widgetName)}`;
  let finalDest = path.join(SNAPSHOTS_DIR, destName);
  let n = 0;
  while (fs.existsSync(finalDest)) {
    n += 1;
    finalDest = path.join(SNAPSHOTS_DIR, `${destName}_${n}`);
  }

  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  fs.cpSync(src, finalDest, { recursive: true });
  fs.writeFileSync(
    path.join(finalDest, 'snapshot-meta.json'),
    JSON.stringify(
      {
        reason,
        widget_id: widgetId,
        widget_name: widgetName,
        created_at: new Date().toISOString(),
      },
      null,
      2
    ),
    'utf8'
  );
  return finalDest;
}

// ── Preview server (live-reload) ────────────────────────────────────────────

const PREVIEW_PORT = 4444;
let previewServer = null;
let lastRenderTime = 0;
const openedPreviews = new Set();

/** Open a URL in the user's default browser (Windows, macOS, Linux). */
function openInBrowser(url) {
  const cmd = process.platform === 'win32'  ? `start "" "${url}"`
            : process.platform === 'darwin' ? `open "${url}"`
            : `xdg-open "${url}"`;
  exec(cmd, err => {
    if (err) console.error(`BD MCP: could not open browser (${err.message}). Preview: ${url}`);
  });
}

function ensurePreviewServer() {
  if (previewServer) return;
  previewServer = http.createServer((req, res) => {
    if (req.url === '/last-render') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(String(lastRenderTime));
    }
    const file = decodeURIComponent(req.url.replace(/^\//, '').split('?')[0]);
    const filePath = path.join(PREVIEWS_DIR, file);
    if (!file || !fs.existsSync(filePath)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(filePath));
  });
  previewServer.on('error', () => { previewServer = null; });
  previewServer.listen(PREVIEW_PORT);
}

// ── Server ─────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'Brilliant Directories Widgets MCP', version: '1.3.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_widgets',
      description: 'List all custom widgets on the BD site with their IDs and last updated dates.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_widget',
      description: 'Fetch a single widget by ID or name, saving files to workspace/. If workspace/{name}/ already contains widget code (non-empty data.html, style.css, or javascript.js), the tool REFUSES to overwrite — the user must manually delete or rename that folder first, then call again. There is no force flag; agents cannot bypass this.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Widget ID (numeric) or exact widget name' },
        },
        required: ['id'],
      },
    },
    {
      name: 'push_widget',
      description: 'Read workspace/{name}/ files and push to BD API. Before uploading, copies the current workspace folder to snapshots/ (pre-push backup). Call after editing workspace files with the Edit tool. Content never passes through the LLM.',
      inputSchema: {
        type: 'object',
        properties: {
          widget_id:   { type: 'number', description: 'Numeric widget ID' },
          widget_name: { type: 'string', description: 'Exact widget name' },
        },
        required: ['widget_id', 'widget_name'],
      },
    },
    {
      name: 'render_widget',
      description: 'Build a local preview from workspace files and open in the browser. First render opens a new tab; subsequent renders auto-refresh the existing tab. Reads local workspace files — call get_widget first if workspace does not exist.',
      inputSchema: {
        type: 'object',
        properties: {
          widget_name: { type: 'string', description: 'Exact widget name (used for the filename)' },
        },
        required: ['widget_name'],
      },
    },
    {
      name: 'get_user',
      description:
        'Read-only lookup of BD members (API v2 user → users_data). Returns sanitized JSON (password/token/cookie omitted). Provide user_id for one member, or property + property_value to filter (e.g. email, active). Read-only — does not write to workspace/.',
      inputSchema: {
        type: 'object',
        properties: {
          user_id: {
            type: 'string',
            description: 'Numeric user_id — retrieve a single member',
          },
          property: {
            type: 'string',
            description: 'Field name to filter on (email, first_name, last_name, active, subscription_id, …)',
          },
          property_value: {
            type: 'string',
            description: 'Value to match against property',
          },
          property_operator: {
            type: 'string',
            description: 'Match operator: = (default) or LIKE',
          },
          limit: {
            type: 'number',
            description: 'Results per page when filtering (20–100, default 25)',
          },
          page: {
            type: 'string',
            description: 'Pagination token from a prior response next_page field',
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {

      case 'list_widgets': {
        // BD's /data_widgets/get is cursor-paginated (default 25/page, max 100).
        // Follow next_page until it's exhausted so we return the full catalog, not just page 1.
        const all = [];
        let page = undefined;
        let pageCount = 0;
        const MAX_PAGES = 200; // safety cap against an infinite-loop bug in the API
        do {
          const qs = new URLSearchParams({ limit: '100' });
          if (page) qs.set('page', page);
          const data = await bdRequest('GET', `/data_widgets/get?${qs.toString()}`);
          all.push(...data.message);
          page = data.next_page || null;
          pageCount += 1;
        } while (page && pageCount < MAX_PAGES);

        const widgets = all.map(w => ({
          id:      w.widget_id,
          name:    w.widget_name,
          updated: w.date_updated || '—',
        }));
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ total: widgets.length, pages_fetched: pageCount, widgets }, null, 2),
          }],
        };
      }

      case 'get_widget': {
        const data = await bdRequest('GET', `/data_widgets/get/${encodeURIComponent(args.id)}`);
        const w = data.message[0];

        // Hard guard: never overwrite non-empty local widget files (no force flag — humans delete folder to refresh)
        const dir = workspaceDir(w.widget_name);
        if (fs.existsSync(dir)) {
          const hasEdits = ['data.html', 'style.css', 'javascript.js'].some(f => {
            const fp = path.join(dir, f);
            return fs.existsSync(fp) && fs.readFileSync(fp, 'utf8').trim().length > 0;
          });
          if (hasEdits) {
            const safe = toSafeName(w.widget_name);
            const rel = path.join('workspace', safe);
            return {
              content: [{
                type: 'text',
                text:
                  `BLOCKED: Local workspace already exists for "${w.widget_name}" (${rel}/).\n\n` +
                  `To pull the live version from BD, the user must manually delete or move that folder, then call get_widget again.\n\n` +
                  `There is no programmatic overwrite — this prevents automated agents from discarding local widget work.`,
              }],
            };
          }
        }

        let snapshot_before = null;
        if (fs.existsSync(dir)) {
          const snapPath = snapshotWidgetWorkspace(w.widget_name, w.widget_id, 'pre-get_widget-overwrite');
          if (snapPath) {
            snapshot_before = path.relative(PROJECT_ROOT, snapPath);
          }
        }

        // Save code fields to workspace — content never returned to LLM
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'data.html'),       w.widget_data       ?? '', 'utf8');
        fs.writeFileSync(path.join(dir, 'style.css'),       w.widget_style      ?? '', 'utf8');
        fs.writeFileSync(path.join(dir, 'javascript.js'),   w.widget_javascript ?? '', 'utf8');
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ widget_id: w.widget_id, widget_name: w.widget_name }), 'utf8');

        const safe = toSafeName(w.widget_name);
        const payload = {
          widget_id:    w.widget_id,
          widget_name:  w.widget_name,
          date_updated: w.date_updated,
          files: {
            data:       `workspace/${safe}/data.html`,
            style:      `workspace/${safe}/style.css`,
            javascript: `workspace/${safe}/javascript.js`,
          },
        };
        if (snapshot_before) {
          payload.snapshot_of_previous_workspace = `${snapshot_before}/`;
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(payload, null, 2),
          }],
        };
      }

      case 'push_widget': {
        const dir = workspaceDir(args.widget_name);

        if (!fs.existsSync(dir)) {
          throw new Error(`No workspace found for "${args.widget_name}". Call get_widget first.`);
        }

        const snapPath = snapshotWidgetWorkspace(args.widget_name, args.widget_id, 'pre-push_widget');
        const snapRel = snapPath ? path.relative(PROJECT_ROOT, snapPath) : null;

        // Read from disk — content never passes through LLM
        const widget_data       = fs.readFileSync(path.join(dir, 'data.html'),     'utf8');
        const widget_style      = fs.readFileSync(path.join(dir, 'style.css'),     'utf8');
        const widget_javascript = fs.readFileSync(path.join(dir, 'javascript.js'), 'utf8');

        await bdRequest('PUT', '/data_widgets/update', {
          widget_id:   args.widget_id,
          widget_name: args.widget_name,
          widget_data,
          widget_style,
          widget_javascript,
        });

        const snapNote = snapRel
          ? ` Pre-push snapshot: ${snapRel}/ (copy back to workspace/${toSafeName(args.widget_name)}/ to restore locally).`
          : '';
        return {
          content: [{ type: 'text', text: `Widget "${args.widget_name}" pushed successfully.${snapNote} Remember to refresh the BD site cache.` }],
        };
      }

      case 'get_user': {
        const hasId = args.user_id != null && String(args.user_id).trim() !== '';
        const hasFilter =
          args.property != null &&
          String(args.property).trim() !== '' &&
          args.property_value != null &&
          String(args.property_value).trim() !== '';

        if (hasId && hasFilter) {
          throw new Error('Provide either user_id or property + property_value, not both.');
        }
        if (!hasId && !hasFilter) {
          throw new Error('Provide user_id, or property + property_value.');
        }

        let data;
        if (hasId) {
          data = await bdRequest('GET', `/user/get/${encodeURIComponent(String(args.user_id).trim())}`);
        } else {
          const qs = new URLSearchParams({
            property: String(args.property).trim(),
            property_value: String(args.property_value).trim(),
          });
          if (args.property_operator != null && String(args.property_operator).trim() !== '') {
            qs.set('property_operator', String(args.property_operator).trim());
          }
          if (args.limit != null) {
            qs.set('limit', String(Math.min(100, Math.max(20, Number(args.limit) || 25))));
          }
          if (args.page != null && String(args.page).trim() !== '') {
            qs.set('page', String(args.page).trim());
          }
          data = await bdRequest('GET', `/user/get?${qs.toString()}`);
        }

        const rows = Array.isArray(data.message) ? data.message : data.message ? [data.message] : [];
        const users = rows.map(sanitizeUserRecord);
        const payload = {
          count: users.length,
          users,
        };
        if (data.next_page) payload.next_page = data.next_page;
        if (data.last_page) payload.last_page = data.last_page;

        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        };
      }

      case 'render_widget': {
        const dir = workspaceDir(args.widget_name);
        if (!fs.existsSync(dir)) {
          throw new Error(`No workspace found for "${args.widget_name}". Call get_widget first.`);
        }

        // Read meta.json for widget_id (saved by get_widget)
        const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));

        // Call BD API to render PHP — gets real database content
        const renderResp = await fetch(`${BASE_URL}/data_widgets/render`, {
          method: 'POST',
          headers: { 'X-Api-Key': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `widget_id=${meta.widget_id}`,
        });
        const rawText = await renderResp.text();
        let widgetHtml;
        try {
          const renderJson = JSON.parse(rawText);
          widgetHtml = renderJson.output ?? '';
        } catch {
          // API returned raw HTML — extract body content if it's a full page
          const bodyMatch = rawText.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
          widgetHtml = bodyMatch ? bodyMatch[1] : rawText;
        }

        // Read local CSS/JS overrides — these reflect any unsaved edits
        const widgetCss = fs.readFileSync(path.join(dir, 'style.css'),    'utf8');
        const widgetJs  = fs.readFileSync(path.join(dir, 'javascript.js'),'utf8');

        ensurePreviewServer();
        lastRenderTime = Date.now();

        // Rewrite root-relative URLs so local preview loads assets from live site
        widgetHtml = widgetHtml
          .replace(/(src|href)="\//g, `$1="${SITE_URL}/`)
          .replace(/(src|href)='\//g, `$1='${SITE_URL}/`);

        const reloadScript = `<script>(function(){var t="${lastRenderTime}";setInterval(function(){fetch("/last-render").then(function(r){return r.text()}).then(function(s){if(s!==t)location.reload()})},1000)})();</script>`;

        const html = `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://maxcdn.bootstrapcdn.com/bootstrap/3.3.7/css/bootstrap.min.css">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap">
  <style>${widgetCss}</style>
  <style>body { padding: 20px; font-family: Montserrat, sans-serif; }</style>
</head><body>
<div class="container-fluid">${widgetHtml}</div>
${widgetJs}
${reloadScript}
</body></html>`;

        const safeName = toSafeName(args.widget_name);
        const filePath = path.join(PREVIEWS_DIR, `${safeName}.html`);
        fs.mkdirSync(PREVIEWS_DIR, { recursive: true });
        fs.writeFileSync(filePath, html, 'utf8');

        const url = `http://localhost:${PREVIEW_PORT}/${safeName}.html`;
        const isNew = !openedPreviews.has(args.widget_name);
        if (isNew) {
          openedPreviews.add(args.widget_name);
          openInBrowser(url);
        }

        return {
          content: [{ type: 'text', text: isNew
            ? `Opened preview at ${url} — will auto-refresh on future renders.`
            : `Preview updated — browser tab refreshed automatically.`,
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
