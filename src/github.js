// Optional GitHub status enrichment for linked PRs/issues. Works without a token for public repos
// (rate-limited); set GITHUB_TOKEN for private repos and higher limits.
import { config } from './config.js';
import { listGithubLinks, updateLinkState } from './store.js';

export async function fetchLinkState(link) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 's2ok-kanban' };
  if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;
  // /issues/N works for both issues and PRs and tells us which one it is.
  const res = await fetch(`https://api.github.com/repos/${link.repo}/issues/${link.number}`, { headers });
  if (res.status === 404) return { state: 'not_found' };
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${link.repo}#${link.number}`);
  const data = await res.json();
  const isPr = !!data.pull_request;
  let state = data.state; // open | closed
  if (isPr) {
    if (data.pull_request.merged_at) state = 'merged';
    else if (data.draft) state = 'draft';
  }
  return { kind: isPr ? 'pr' : 'issue', title: data.title, state };
}

/** Refresh links not checked within `staleMinutes`. Returns number refreshed. Never throws. */
export async function refreshGithubLinks({ staleMinutes = 10 } = {}) {
  const links = listGithubLinks({ staleMinutes });
  let n = 0;
  for (const link of links) {
    try {
      const s = await fetchLinkState(link);
      updateLinkState(link.id, s);
      n++;
    } catch (e) {
      console.warn('[github]', e.message);
      updateLinkState(link.id, { state: link.state ?? null }); // bump checked_at so we don't hammer
    }
  }
  return n;
}
