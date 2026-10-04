// MCP server exposing the kanban board to Claude (Claude Code, Claude Desktop, claude.ai).
// Transport: Streamable HTTP at /mcp, authenticated with a per-user API token (Authorization: Bearer kb_...).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { LANES, LANE_IDS } from '../db.js';
import * as store from '../store.js';

const laneEnum = z.enum(LANE_IDS);
const priorityEnum = z.enum(store.PRIORITIES);

function text(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

function taskSummary(t) {
  return {
    id: t.id,
    title: t.title,
    project: t.project_slug,
    lane: t.lane,
    priority: t.priority,
    assignee: t.assignee,
    branch: t.branch,
    links: (t.links ?? []).map((l) => ({ kind: l.kind, url: l.url, state: l.state })),
    updated_at: t.updated_at,
  };
}

function taskDetail(t) {
  return {
    ...taskSummary(t),
    description: t.description,
    project_name: t.project_name,
    github_repo: t.github_repo,
    local_path: t.local_path,
    created_at: t.created_at,
    completed_at: t.completed_at,
    worklog: (t.worklog ?? []).map((w) => ({ at: w.created_at, author: w.author, kind: w.kind, body: w.body })),
  };
}

export function buildMcpServer(user) {
  const server = new McpServer(
    { name: 's2ok-kanban', version: '0.1.0' },
    {
      instructions: [
        'This is the company kanban board. Lanes: ' + LANES.map((l) => `${l.id} (${l.name})`).join(', ') + '.',
        'Each project may have a local_path (where its code lives on the developer machine) and a github_repo (owner/name).',
        'Workflow for working a task: claim_task → do the work in the project local_path → add_worklog for notable steps → complete_task with a summary of what was done and the PR URL (the human merges PRs).',
        'Prefer get_claude_queue to find tasks assigned to you.',
      ].join('\n'),
    },
  );

  const wrap = (fn) => async (args) => {
    try {
      return text(await fn(args ?? {}));
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  };

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'List all active projects with their slug, GitHub repo and local path.',
      inputSchema: {},
    },
    wrap(() => store.listProjects()),
  );

  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description: 'List tasks, optionally filtered by project slug, lane, or assignee. Done tasks are excluded unless include_done is true.',
      inputSchema: {
        project: z.string().optional().describe('Project slug or id'),
        lane: laneEnum.optional(),
        assignee: z.string().optional().describe("Username, or 'claude'"),
        include_done: z.boolean().optional(),
      },
    },
    wrap(({ project, lane, assignee, include_done }) =>
      store.listTasks({ project, lane, assignee, includeDone: !!include_done }).map(taskSummary),
    ),
  );

  server.registerTool(
    'get_claude_queue',
    {
      title: 'Tasks assigned to Claude',
      description: "Tasks assigned to 'claude' in lanes todo/in_progress, optionally for one project. Pick the first one unless told otherwise.",
      inputSchema: { project: z.string().optional().describe('Project slug or id') },
    },
    wrap(({ project }) => store.claudeQueue(project).map(taskSummary)),
  );

  server.registerTool(
    'get_task',
    {
      title: 'Get task',
      description: 'Full task detail including description, links, worklog, and the project local_path / github_repo.',
      inputSchema: { id: z.number().int() },
    },
    wrap(({ id }) => taskDetail(store.getTask(id))),
  );

  server.registerTool(
    'create_task',
    {
      title: 'Create task',
      description: 'Create a task in a project.',
      inputSchema: {
        project: z.string().describe('Project slug or id'),
        title: z.string(),
        description: z.string().optional(),
        lane: laneEnum.optional().describe('Default backlog'),
        priority: priorityEnum.optional(),
        assignee: z.string().optional(),
      },
    },
    wrap((args) => taskDetail(store.createTask(args, user))),
  );

  server.registerTool(
    'update_task',
    {
      title: 'Update task',
      description: 'Update title, description, priority, assignee or branch of a task.',
      inputSchema: {
        id: z.number().int(),
        title: z.string().optional(),
        description: z.string().optional(),
        priority: priorityEnum.optional(),
        assignee: z.string().nullable().optional(),
        branch: z.string().nullable().optional(),
      },
    },
    wrap(({ id, ...patch }) => taskDetail(store.updateTask(id, patch, user))),
  );

  server.registerTool(
    'move_task',
    {
      title: 'Move task',
      description: 'Move a task to another lane (appends at the end of the lane).',
      inputSchema: { id: z.number().int(), lane: laneEnum },
    },
    wrap(({ id, lane }) => taskDetail(store.moveTask(id, { lane }, user))),
  );

  server.registerTool(
    'claim_task',
    {
      title: 'Claim task (Claude starts work)',
      description: 'Mark that Claude is starting on a task: sets assignee=claude, moves it to in_progress, records a worklog entry. Returns full detail incl. local_path.',
      inputSchema: { id: z.number().int(), note: z.string().optional().describe('Optional short plan') },
    },
    wrap(({ id, note }) => taskDetail(store.claimTask(id, user, note))),
  );

  server.registerTool(
    'add_worklog',
    {
      title: 'Add worklog entry',
      description: 'Document progress, decisions or findings on a task. Use markdown. Author is recorded as claude.',
      inputSchema: { id: z.number().int(), body: z.string() },
    },
    wrap(({ id, body }) => {
      store.addWorklog(id, { author: store.CLAUDE, kind: 'claude', body });
      return { ok: true };
    }),
  );

  server.registerTool(
    'complete_task',
    {
      title: 'Complete task (Claude reports back)',
      description:
        'Finish work on a task: writes the summary of what was done to the worklog, optionally links the PR and branch, and moves the task to review (the human reviews and merges). Set lane=done only if no review is needed.',
      inputSchema: {
        id: z.number().int(),
        summary: z.string().describe('What was done, how it was verified, anything left open. Markdown.'),
        pr_url: z.string().optional(),
        branch: z.string().optional(),
        lane: z.enum(['review', 'done', 'todo']).optional().describe("Default 'review'. Use 'todo' to hand back if blocked."),
      },
    },
    wrap(({ id, ...rest }) => taskDetail(store.completeTask(id, rest, user))),
  );

  server.registerTool(
    'link_github',
    {
      title: 'Link a GitHub PR or issue',
      description: 'Attach a GitHub pull request or issue (full URL, "#123", or "owner/repo#123") to a task.',
      inputSchema: {
        id: z.number().int(),
        url: z.string(),
        kind: z.enum(['pr', 'issue', 'url']).optional().describe('Required when passing a bare number so the board knows PR vs issue'),
      },
    },
    wrap(({ id, url, kind }) => taskDetail(store.addLink(id, { url, kind }, user))),
  );

  return server;
}

/** Express handler for POST/GET/DELETE /mcp (stateless: one server instance per request). */
export async function handleMcpRequest(req, res) {
  if (!req.user) {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Authentication required: Authorization: Bearer <api token>' }, id: null });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
    return;
  }
  const server = buildMcpServer(req.user);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
