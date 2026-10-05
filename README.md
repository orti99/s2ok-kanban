# S2OK Kanban

A small self-hosted kanban board for the company. Node 22, Express, SQLite (Node's built-in `node:sqlite`,
no native build), vanilla JS frontend, no build step. Claude connects through an MCP endpoint and can
pick up tasks, document what it did, and link the pull request for you to merge.

## Features

- Login required (username/password, scrypt-hashed, cookie sessions, login rate limit). Admin-managed
  accounts: admins add users and reset passwords in the UI, random passwords are shown once.
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
npm start                       # http://127.0.0.1:3000
```

On the very first start (empty database) the accounts in `BOOTSTRAP_USERS` are created, by default
`sebastian` (admin) and `sina`, each with a random password printed to the console **once**. Log in,
change your password under **Password**, and manage accounts under **Users** (admins only).
`npm run user:add -- --admin --random name` does the same from the CLI.

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

### If Claude reports an authentication problem

Test the token and the endpoint directly, from the same machine Claude Code runs on:

```bash
curl -i -H "Authorization: Bearer kb_…" https://kanban.your-domain.tld/api/me
```

- `200` with your user → token and server are fine; the problem is the client config. Run
  `claude mcp get kanban` and check the URL ends in `/mcp` and the header is exactly
  `Authorization: Bearer kb_…`. Then `claude mcp remove kanban` and add it again.
- `401` → the token is not known to this instance. Tokens are per instance (local vs. NAS) and are
  listed under **Claude / MCP**; create a new one there.
- `301`/`302`/`308` → you used `http://` and the proxy redirects to `https://`. Clients drop the
  Authorization header on that redirect. Register the `https://` URL.
- `000`/connection error → the hostname or port isn't reachable from that machine.

The container log shows every rejected MCP call with the reason (`[mcp] 401 …`).

### How Claude works a task

| Step | MCP tool | Board effect |
|---|---|---|
| You click **Give to Claude** | – | assignee = claude, lane = To Do |
| Claude starts | `claim_task` | lane = In Progress, worklog entry |
| Claude notes progress | `add_worklog` | worklog entry (author: claude) |
| Claude finishes | `complete_task` | summary in worklog, branch + PR linked, lane = Review |
| You review & merge the PR | – | badge turns *merged*; the task moves to Done automatically (see below) |

Other tools: `list_projects`, `list_tasks`, `get_claude_queue`, `get_task`, `create_task`,
`update_task`, `move_task`, `link_github`.

**Where does Claude's project knowledge come from?** Not from the board. The board only stores
*where* each project lives (`local_path`) and its GitHub repo. Claude Code runs on your machine inside
that checkout, so it has the code, the project's `CLAUDE.md`, and git. The MCP server is just the
task tracker. That also means a cloud Claude (claude.ai) connected to the board can *plan and triage*
tasks but cannot *do* code work unless it also has the repo (e.g. via Claude Code on the web).

## GitHub: repos, badges, auto-close

Each project has a **GitHub repository** (`owner/repo`) in *Project settings*. With it set, you can link
PRs and issues by number (`#42`), and Claude's `complete_task` can pass a bare number too. Links with a
full URL can point at any repository.

The board asks GitHub's API for the state of every linked PR/issue (open, draft, merged, closed) and shows
it as a badge on the card. When a linked PR becomes *merged* and the task is in Review (or In Progress),
the task moves to Done by itself with a worklog entry. This check runs each time someone opens the board,
at most every 10 minutes per link, so a merge shows up on the next page load.

For **private repositories GitHub refuses anonymous API calls**, so the board needs a token to read
them: on GitHub go to *Settings → Developer settings → Personal access tokens → Fine-grained*, create one
with read-only access to *Pull requests* and *Issues* on the company repos, and put it in `GITHUB_TOKEN`
(`.env` or `docker-compose.yml`). Public repos work without one, within GitHub's low anonymous rate limit.

## Synology NAS (Docker) with your own domain

`Dockerfile` and `docker-compose.yml` are included. On the NAS:

1. Copy the repo to a shared folder (e.g. `/volume1/docker/s2ok-kanban`) and create a `data` folder in it.
2. Copy `.env.example` to `.env` and set `PUID`/`PGID` to your NAS user (run `id` over SSH; typically
   `1026` and `100`). The container runs as that user so it can write the mounted `data` folder. Without
   this the log shows `unable to open database file`. Set `KANBAN_PORT` if 3000 is taken on the NAS, and
   `GITHUB_TOKEN` if you want badges for private repos.
3. *Container Manager → Project → Create*, pick that folder, it uses `docker-compose.yml` and `.env`.
   The database is stored in `./data`; back that folder up.
4. First start: open the container log, copy the two generated passwords.
5. DNS: point `kanban.your-domain.tld` at the NAS (DDNS or a fixed IP), forward port 443 on the router.
6. *DSM → Control Panel → Login Portal → Advanced → Reverse Proxy*: source `https://kanban.your-domain.tld`
   port 443 → destination `http://localhost:<KANBAN_PORT>`. Under *Security → Certificate* request a
   Let's Encrypt certificate for that hostname and assign it to the reverse-proxy entry.
7. Register the MCP server in Claude Code with the public URL
   (`claude mcp add --transport http --scope user kanban https://kanban.your-domain.tld/mcp --header "Authorization: Bearer kb_…"`).

The container runs with `BEHIND_PROXY=1`, which turns on secure cookies and trusts the proxy's
`X-Forwarded-*` headers. Do not forward the app port on the router; only the reverse proxy should reach it. API tokens are the only credential Claude holds, revoke them under **Claude / MCP** if a laptop
goes missing.

## Development

```bash
npm run dev    # restarts on file changes
npm test       # API + MCP tests (node:test, in-memory SQLite)
```

Layout: `src/server.js` (HTTP), `src/api.js` (REST), `src/mcp/server.js` (MCP tools), `src/store.js`
(domain logic shared by both), `src/auth.js`, `src/db.js` (schema), `src/public/` (frontend).

## Known limits

- No live updates between browsers: reload to see what the other person (or Claude) did. Last write wins.
- GitHub state is polled on page load, not pushed; a webhook would make auto-close instant.
- No 2FA. Passwords are at least 8 characters; login is rate-limited per IP.
