/* S2OK Kanban – small vanilla-JS client. */
(() => {
  const $app = document.getElementById('app');
  const state = { user: null, lanes: [], priorities: [], projects: [], project: localStorage.getItem('kb.project') || '', tasks: [], modal: null };

  // ---------- helpers ----------
  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtDate = (s) => (s ? new Date(s).toLocaleString() : '');
  // Minimal markdown: paragraphs, code, links, bold. Enough for worklog notes.
  const md = (s) =>
    esc(s)
      .replace(/```([\s\S]*?)```/g, (_, c) => `<pre>${c.trim()}</pre>`)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

  async function api(method, path, body) {
    const res = await fetch('/api' + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/login') {
      state.user = null;
      render();
      throw new Error('Session expired');
    }
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  // ---------- data ----------
  async function boot() {
    try {
      const me = await api('GET', '/me');
      state.user = me.user;
      state.lanes = me.lanes;
      state.priorities = me.priorities;
      await loadProjects();
      await loadTasks();
      refreshGithub();
    } catch {
      state.user = null;
    }
    render();
  }
  async function loadProjects() {
    state.projects = (await api('GET', '/projects')).projects;
    if (!state.projects.find((p) => p.slug === state.project)) state.project = state.projects[0]?.slug ?? '';
  }
  async function loadTasks() {
    if (!state.project) return (state.tasks = []);
    state.tasks = (await api('GET', `/tasks?project=${encodeURIComponent(state.project)}`)).tasks;
  }
  async function refreshGithub() {
    try {
      const r = await api('POST', '/github/refresh', {});
      if (r.refreshed > 0) { await loadTasks(); render(); }
    } catch { /* optional feature */ }
  }
  async function reload() {
    await loadTasks();
    render();
  }

  // ---------- views ----------
  function render() {
    $app.replaceChildren(state.user ? viewBoard() : viewLogin());
    if (state.modal) $app.append(state.modal());
  }

  function viewLogin() {
    const err = h('div', { class: 'error' });
    const form = h('form', { class: 'login', onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      try {
        await api('POST', '/login', { username: form.username.value, password: form.password.value });
        await boot();
      } catch (ex) { err.textContent = ex.message; }
    } },
      h('h1', {}, 'S2OK Kanban'),
      h('label', {}, 'Username'), h('input', { name: 'username', autocomplete: 'username', autofocus: true }),
      h('label', {}, 'Password'), h('input', { name: 'password', type: 'password', autocomplete: 'current-password' }),
      err,
      h('div', { style: 'margin-top:12px' }, h('button', { class: 'primary', type: 'submit' }, 'Log in')),
    );
    return form;
  }

  function viewBoard() {
    const project = state.projects.find((p) => p.slug === state.project);
    const header = h('header', {},
      h('h1', {}, 'S2OK Kanban'),
      h('select', { onchange: async (e) => { state.project = e.target.value; localStorage.setItem('kb.project', state.project); await reload(); refreshGithub(); } },
        state.projects.map((p) => h('option', { value: p.slug, selected: p.slug === state.project }, p.name))),
      h('button', { class: 'small', onclick: () => openProjectModal(project) }, 'Project settings'),
      h('button', { class: 'small', onclick: () => openProjectModal(null) }, '+ Project'),
      h('div', { class: 'spacer' }),
      h('span', { class: 'muted' }, state.user.display_name),
      h('button', { class: 'small', onclick: openTokensModal }, 'Claude / MCP'),
      state.user.is_admin && h('button', { class: 'small', onclick: openUsersModal }, 'Users'),
      h('button', { class: 'small', onclick: openPasswordModal }, 'Password'),
      h('button', { class: 'small', onclick: async () => { await api('POST', '/logout'); state.user = null; render(); } }, 'Log out'),
    );
    const board = h('div', { class: 'board' }, state.lanes.map(viewLane));
    return h('div', {}, header, board);
  }

  function viewLane(lane) {
    const tasks = state.tasks.filter((t) => t.lane === lane.id);
    const el = h('div', { class: 'lane', 'data-lane': lane.id,
      ondragover: (e) => { e.preventDefault(); el.classList.add('over'); },
      ondragleave: () => el.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); el.classList.remove('over'); onDrop(e, lane.id, el); },
    },
      h('h2', {}, lane.name, h('span', { class: 'count' }, tasks.length)),
      tasks.map(viewCard),
      h('button', { class: 'add-card', onclick: () => openTaskModal(null, lane.id) }, '+ Add task'),
    );
    return el;
  }

  function viewCard(t) {
    const el = h('div', { class: `card prio-${t.priority}`, draggable: true, 'data-id': t.id,
      ondragstart: (e) => { e.dataTransfer.setData('text/plain', String(t.id)); el.classList.add('dragging'); },
      ondragend: () => el.classList.remove('dragging'),
      onclick: () => openTaskModal(t.id),
    },
      h('div', { class: 'title' }, t.title),
      h('div', { class: 'meta' },
        h('span', {}, '#' + t.id),
        t.priority !== 'normal' && h('span', { class: 'badge' }, t.priority),
        t.assignee && h('span', { class: 'badge ' + (t.assignee === 'claude' ? 'claude' : '') }, t.assignee),
        t.links.map((l) => h('span', { class: 'badge ' + (l.state || '') }, (l.kind === 'pr' ? 'PR' : l.kind === 'issue' ? 'Issue' : 'Link') + (l.number ? ' #' + l.number : ''))),
        t.worklog_count > 0 && h('span', {}, `✎ ${t.worklog_count}`),
      ),
    );
    return el;
  }

  async function onDrop(e, laneId, laneEl) {
    const id = Number(e.dataTransfer.getData('text/plain'));
    if (!id) return;
    // Find the card we dropped before (first card whose vertical middle is below the cursor).
    const cards = [...laneEl.querySelectorAll('.card')].filter((c) => Number(c.dataset.id) !== id);
    const before = cards.find((c) => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    const body = { lane: laneId };
    if (before) body.before = Number(before.dataset.id);
    try { await api('POST', `/tasks/${id}/move`, body); } catch (ex) { alert(ex.message); }
    await reload();
  }

  // ---------- task modal ----------
  function closeModal() { state.modal = null; render(); }
  const backdrop = (...children) => h('div', { class: 'backdrop', onclick: (e) => { if (e.target.classList.contains('backdrop')) closeModal(); } }, h('div', { class: 'modal' }, ...children));

  async function openTaskModal(id, laneId) {
    let task = id ? (await api('GET', `/tasks/${id}`)).task : null;
    state.modal = () => {
      const err = h('div', { class: 'error' });
      const f = {};
      const field = (name, label, input) => { f[name] = input; return [h('label', {}, label), input]; };
      const save = async () => {
        err.textContent = '';
        const body = { title: f.title.value, description: f.description.value, priority: f.priority.value, assignee: f.assignee.value || null, branch: f.branch.value || null };
        try {
          if (task) { task = (await api('PATCH', `/tasks/${task.id}`, body)).task; }
          else { task = (await api('POST', '/tasks', { ...body, project: state.project, lane: laneId })).task; }
          await loadTasks();
          render();
        } catch (ex) { err.textContent = ex.message; }
      };
      const act = async (fn) => { err.textContent = ''; try { await fn(); task = (await api('GET', `/tasks/${task.id}`)).task; await loadTasks(); render(); } catch (ex) { err.textContent = ex.message; } };
      const linkInput = h('input', { placeholder: 'PR/issue URL, #123, owner/repo#123' });
      const noteInput = h('textarea', { placeholder: 'Add a note (markdown ok)…', style: 'min-height:60px' });

      return backdrop(
        h('div', { class: 'row' }, h('h2', { class: 'grow' }, task ? `#${task.id} ${task.title}` : 'New task'), h('button', { class: 'small', onclick: closeModal }, '✕')),
        h('div', { class: 'cols' },
          h('div', {},
            field('title', 'Title', h('input', { value: task?.title ?? '', autofocus: !task })),
            field('description', 'Description', h('textarea', {}, task?.description ?? '')),
            task && h('div', { class: 'worklog' },
              h('label', {}, `Worklog (${task.worklog.length})`),
              h('ul', {}, task.worklog.map((w) => h('li', {},
                h('div', { class: 'who ' + (w.author === 'claude' ? 'claude' : '') }, `${w.author} · ${fmtDate(w.created_at)}`),
                h('div', { class: 'body', html: md(w.body) })))),
              noteInput,
              h('button', { class: 'small', style: 'margin-top:6px', onclick: () => act(async () => { await api('POST', `/tasks/${task.id}/worklog`, { body: noteInput.value }); }) }, 'Add note'),
            ),
          ),
          h('div', {},
            field('priority', 'Priority', h('select', {}, state.priorities.map((p) => h('option', { value: p, selected: p === (task?.priority ?? 'normal') }, p)))),
            field('assignee', 'Assignee', h('input', { value: task?.assignee ?? '', placeholder: 'username or claude', list: 'assignees' })),
            h('datalist', { id: 'assignees' }, h('option', { value: 'claude' }), h('option', { value: state.user.username })),
            field('branch', 'Branch', h('input', { value: task?.branch ?? '', placeholder: 'feature/…' })),
            task && h('div', {}, h('label', {}, 'Lane'), h('select', { onchange: (e) => act(() => api('POST', `/tasks/${task.id}/move`, { lane: e.target.value })) },
              state.lanes.map((l) => h('option', { value: l.id, selected: l.id === task.lane }, l.name)))),
            task && h('div', { class: 'links' },
              h('label', {}, 'GitHub PRs / issues'),
              h('ul', {}, task.links.map((l) => h('li', { class: 'row' },
                h('span', { class: 'badge ' + (l.state || '') }, l.kind === 'pr' ? 'PR' : l.kind === 'issue' ? 'Issue' : 'URL'),
                h('a', { href: l.url, target: '_blank', rel: 'noopener', class: 'grow' }, l.title || (l.number ? `${l.repo}#${l.number}` : l.url)),
                l.state && h('span', { class: 'muted' }, l.state),
                h('button', { class: 'small danger', onclick: () => act(() => api('DELETE', `/tasks/${task.id}/links/${l.id}`)) }, '✕')))),
              h('div', { class: 'row' }, linkInput,
                h('select', { style: 'width:auto', id: 'linkkind' }, h('option', { value: '' }, 'auto'), h('option', { value: 'pr' }, 'PR'), h('option', { value: 'issue' }, 'Issue')),
                h('button', { class: 'small', onclick: () => act(() => api('POST', `/tasks/${task.id}/links`, { url: linkInput.value, kind: document.getElementById('linkkind').value || undefined })) }, 'Link')),
            ),
            task && h('p', { class: 'muted', style: 'font-size:12px' }, `Created ${fmtDate(task.created_at)}`, task.completed_at ? ` · Done ${fmtDate(task.completed_at)}` : ''),
          ),
        ),
        err,
        h('div', { class: 'actions' },
          h('button', { class: 'primary', onclick: save }, task ? 'Save' : 'Create'),
          task && task.assignee !== 'claude' && h('button', { class: 'claude', onclick: () => act(() => api('POST', `/tasks/${task.id}/assign-claude`)) }, 'Give to Claude'),
          h('div', { class: 'grow' }),
          task && h('button', { class: 'danger', onclick: () => { if (confirm('Delete this task?')) act(async () => { await api('DELETE', `/tasks/${task.id}`); closeModal(); }); } }, 'Delete'),
        ),
      );
    };
    render();
  }

  // ---------- project modal ----------
  function openProjectModal(project) {
    state.modal = () => {
      const err = h('div', { class: 'error' });
      const name = h('input', { value: project?.name ?? '' });
      const repo = h('input', { value: project?.github_repo ?? '', placeholder: 'owner/repo' });
      const local = h('input', { value: project?.local_path ?? '', placeholder: '/Users/you/code/project' });
      const desc = h('textarea', {}, project?.description ?? '');
      const save = async () => {
        err.textContent = '';
        const body = { name: name.value, github_repo: repo.value || null, local_path: local.value || null, description: desc.value };
        try {
          const r = project ? await api('PATCH', `/projects/${project.id}`, body) : await api('POST', '/projects', body);
          await loadProjects();
          state.project = r.project.slug;
          localStorage.setItem('kb.project', state.project);
          state.modal = null;
          await reload();
        } catch (ex) { err.textContent = ex.message; }
      };
      return backdrop(
        h('div', { class: 'row' }, h('h2', { class: 'grow' }, project ? `Project: ${project.name}` : 'New project'), h('button', { class: 'small', onclick: closeModal }, '✕')),
        h('label', {}, 'Name'), name,
        h('label', {}, 'GitHub repository (owner/repo) – lets you link PRs/issues by number'), repo,
        h('label', {}, 'Local path – where Claude Code finds this project on your machine'), local,
        h('label', {}, 'Description / context for Claude'), desc,
        err,
        h('div', { class: 'actions' },
          h('button', { class: 'primary', onclick: save }, 'Save'),
          h('div', { class: 'grow' }),
          project && h('button', { class: 'danger', onclick: async () => { if (confirm('Archive project? Tasks are kept.')) { await api('PATCH', `/projects/${project.id}`, { archived: true }); await loadProjects(); state.modal = null; await reload(); } } }, 'Archive'),
        ),
      );
    };
    render();
  }

  // ---------- tokens / MCP modal ----------
  async function openTokensModal() {
    let tokens = (await api('GET', '/tokens')).tokens;
    let fresh = null;
    state.modal = () => {
      const nameInput = h('input', { placeholder: 'Token name (e.g. laptop)', style: 'width:220px' });
      const origin = location.origin;
      return backdrop(
        h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Connect Claude (MCP)'), h('button', { class: 'small', onclick: closeModal }, '✕')),
        h('p', {}, 'Claude talks to this board through an MCP endpoint. Create a token, then register the server once:'),
        h('pre', {}, `claude mcp add --transport http kanban ${origin}/mcp --header "Authorization: Bearer <token>"`),
        h('p', { class: 'muted' }, 'Then in any project: "Pick the next kanban task for this project and work on it" — or install the /kanban command from the claude/ folder of this repo.'),
        h('label', {}, 'API tokens'),
        h('ul', { class: 'tokens' }, tokens.map((t) => h('li', {}, h('span', { class: 'grow' }, t.name), h('span', { class: 'muted' }, t.last_used_at ? `last used ${fmtDate(t.last_used_at)}` : 'never used'),
          h('button', { class: 'small danger', onclick: async () => { tokens = (await api('DELETE', `/tokens/${t.id}`)).tokens; render(); } }, 'Revoke')))),
        fresh && h('div', {}, h('p', {}, 'New token (shown once):'), h('pre', {}, fresh)),
        h('div', { class: 'row' }, nameInput, h('button', { class: 'primary', onclick: async () => { const r = await api('POST', '/tokens', { name: nameInput.value || 'claude' }); tokens = r.tokens; fresh = r.token; render(); } }, 'Create token')),
      );
    };
    render();
  }

  // ---------- users (admin) ----------
  async function openUsersModal() {
    let users = (await api('GET', '/users')).users;
    let reveal = null; // { username, password }
    state.modal = () => {
      const err = h('div', { class: 'error' });
      const name = h('input', { placeholder: 'username', style: 'width:160px' });
      const display = h('input', { placeholder: 'display name', style: 'width:160px' });
      const admin = h('input', { type: 'checkbox', style: 'width:auto' });
      return backdrop(
        h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Users'), h('button', { class: 'small', onclick: closeModal }, '✕')),
        h('ul', { class: 'tokens' }, users.map((u) => h('li', {},
          h('span', { class: 'grow' }, u.username, u.is_admin && ' ', u.is_admin && h('span', { class: 'badge' }, 'admin')),
          h('button', { class: 'small', onclick: async () => { try { const r = await api('POST', `/users/${u.id}/reset-password`, {}); reveal = { username: u.username, password: r.password }; render(); } catch (ex) { err.textContent = ex.message; } } }, 'Reset password'),
          u.id !== state.user.id && h('button', { class: 'small danger', onclick: async () => { if (confirm(`Delete user ${u.username}?`)) { users = (await api('DELETE', `/users/${u.id}`)).users; render(); } } }, 'Delete')))),
        reveal && h('div', {}, h('p', {}, `New password for ${reveal.username} (shown once):`), h('pre', {}, reveal.password)),
        h('label', {}, 'Add user (a random password is generated and shown once)'),
        h('div', { class: 'row' }, name, display, h('label', { style: 'margin:0', class: 'row' }, admin, 'admin'),
          h('button', { class: 'primary', onclick: async () => { err.textContent = ''; try { const r = await api('POST', '/users', { username: name.value, display_name: display.value, is_admin: admin.checked }); users = r.users; reveal = { username: r.user.username, password: r.password }; render(); } catch (ex) { err.textContent = ex.message; } } }, 'Add')),
        err,
      );
    };
    render();
  }

  // ---------- change own password ----------
  function openPasswordModal() {
    state.modal = () => {
      const err = h('div', { class: 'error' });
      const current = h('input', { type: 'password', autocomplete: 'current-password' });
      const next = h('input', { type: 'password', autocomplete: 'new-password' });
      const again = h('input', { type: 'password', autocomplete: 'new-password' });
      return backdrop(
        h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Change password'), h('button', { class: 'small', onclick: closeModal }, '✕')),
        h('label', {}, 'Current password'), current,
        h('label', {}, 'New password (min. 8 characters)'), next,
        h('label', {}, 'Repeat new password'), again,
        err,
        h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: async () => {
          err.textContent = '';
          if (next.value !== again.value) { err.textContent = 'Passwords do not match'; return; }
          try { await api('POST', '/me/password', { current: current.value, password: next.value }); closeModal(); } catch (ex) { err.textContent = ex.message; }
        } }, 'Change')),
      );
    };
    render();
  }

  boot();
})();
