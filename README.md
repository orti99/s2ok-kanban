# S2OK Kanban

A small self-hosted kanban board for the company. Node 22, Express, SQLite (Node's built-in `node:sqlite`,
no native build), vanilla JS frontend, no build step. Claude connects through an MCP endpoint and can
pick up tasks, document what it did, and link the pull request for you to merge.

## Features

- Login required (username/password, scrypt-hashed, cookie sessions, login rate limit)
- Projects (seeded: Doggl, S2OK Website, CoverUp) with a GitHub repo and a local code path each
- Standard lanes: Backlog → To Do → In Progress → Review → Done, drag and drop
- Tasks with priority, assignee, branch, worklog (notes + automatic status history)
- Link GitHub pull requests and issues (full URL, `#123`, or `owner/repo#123`); state badges
  (open / draft / merged / closed) are fetched from GitHub when a token is configured
- "Give to Claude" on any task; Claude claims it, works in the project's local checkout, documents the
  result and links the PR. The human reviews and merges.
- MCP server (Streamable HTTP) with per-user API tokens

## Run it

```bash
npm install
cp .env.example .env            # optional; defaults work for local use
npm run user:add -- yourname    # prompts for a password
npm start                       # http://127.0.0.1:3000
```

Data lives in `./data/kanban.sqlite` (back it up by copying the file).

## Connect Claude

1. In the board: **Claude / MCP** → create a token (or `npm run token:create -- yourname`).
2. Register the server with Claude Code (once, user-wide):

   ```bash
   claude mcp add --transport http --scope user kanban http://127.0.0.1:3000/mcp \
     --header "Authorization: Bearer kb_…"
   ```

   `claude/mcp.example.json` shows the equivalent `.mcp.json` entry. Claude Desktop / claude.ai: add a
   custom connector pointing at the same URL once the board is reachable over HTTPS (see below).
3. Optional: copy `claude/kanban.md` to `~/.claude/commands/kanban.md`. Then, inside any project checkout,
   `/kanban` picks the next task assigned to Claude for that project (matched via the project's
   *local path*) and `/kanban 42` works a specific task.

### How Claude works a task

| Step | MCP tool | Board effect |
|---|---|---|
| You click **Give to Claude** | – | assignee = claude, lane = To Do |
| Claude starts | `claim_task` | lane = In Progress, worklog entry |
| Claude notes progress | `add_worklog` | worklog entry (author: claude) |
| Claude finishes | `complete_task` | summary in worklog, branch + PR linked, lane = Review |
| You review & merge the PR | – | move to Done (badge turns *merged*) |

Other tools: `list_projects`, `list_tasks`, `get_claude_queue`, `get_task`, `create_task`,
`update_task`, `move_task`, `link_github`.

**Where does Claude's project knowledge come from?** Not from the board. The board only stores
*where* each project lives (`local_path`) and its GitHub repo. Claude Code runs on your machine inside
that checkout, so it has the code, the project's `CLAUDE.md`, and git. The MCP server is just the
task tracker. That also means a cloud Claude (claude.ai) connected to the board can *plan and triage*
tasks but cannot *do* code work unless it also has the repo (e.g. via Claude Code on the web).

## GitHub state badges

Set `GITHUB_TOKEN` in `.env` (a fine-grained token with read access to pull requests and issues on the
company repos). The board refreshes link states when a board loads, at most every 10 minutes per link.
Without a token, public repos still work within GitHub's anonymous rate limit.

## Putting it on the internet later

The app is a single Node process listening on `127.0.0.1`. To expose it:

1. Put it behind an HTTPS reverse proxy (Caddy is the least work: `reverse_proxy 127.0.0.1:3000`),
   or a Cloudflare Tunnel / Tailscale Funnel if you don't want to open ports.
2. Set `BEHIND_PROXY=1` (secure cookies, trust `X-Forwarded-*`) and `HOST=0.0.0.0` if the proxy runs
   elsewhere.
3. Keep the SQLite file on persistent storage and back it up.
4. Rotate API tokens now and then; they are the only credential Claude holds.

A `systemd` unit or `pm2` keeps it running. Docker is not required but trivial (`node:22-slim`, copy the
repo, `npm ci --omit=dev`, `npm start`).

## Development

```bash
npm run dev    # restarts on file changes
npm test       # API + MCP tests (node:test, in-memory SQLite)
```

Layout: `src/server.js` (HTTP), `src/api.js` (REST), `src/mcp/server.js` (MCP tools), `src/store.js`
(domain logic shared by both), `src/auth.js`, `src/db.js` (schema), `src/public/` (frontend).

## Open questions

- Users: admin-created via CLI only today. Self-registration, password reset, roles?
- Should the board stay a tracker that Claude Code pulls from, or also run Claude server-side?
- GitHub write access (create issues/PRs from the board, webhook on merge) or read-only badges?
- Which GitHub org/repos per project, and who owns the token the board uses?
- Live updates: last write wins, no push to other browsers. Polling or SSE if several people work at once.
