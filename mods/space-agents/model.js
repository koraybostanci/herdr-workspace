export function agentCards({ allAgents, allSpaces, allPanes, allTerminals, selectedSpace, knownAgentKeys = [] }) {
  const space = selectedSpace == null ? allSpaces.find(s => s.active) : allSpaces.find(s => s.id === selectedSpace);
  if (!space) return [];
  const panes = new Map(allPanes.map(p => [p.pane, p]));
  const terminals = new Map(allTerminals.map(t => [t.address, t]));
  const tabs = new Map(space.tabs.map(t => [t.id, t]));
  const list = allAgents.filter(a => a.space === space.id);
  const listed = new Set(list.map(a => a.address));
  const harnesses = new Set(knownAgentKeys);
  // Program detection precedes the first status report when an agent starts in a shell.
  for (const pane of allPanes) {
    if (!pane.terminal || !(pane.program?.agent || harnesses.has(pane.program?.key)) || !tabs.has(pane.tab) || listed.has(pane.terminal)) continue;
    list.push({
      address: pane.terminal, pane: pane.pane, space: space.id, tab: pane.tab,
      title: pane.title, program: pane.program, app: pane.app, status: pane.status ?? null, focused: pane.focused,
    });
    listed.add(pane.terminal);
  }
  return list.map(a => {
    const pane = panes.get(a.pane);
    const terminal = terminals.get(a.address);
    const argv = terminal?.foreground?.argv ?? terminal?.argv ?? [];
    const executable = terminal?.foreground?.name ?? argv[0]?.split(/[\\/]/).pop();
    const remoteConnection = ["ssh", "mosh", "mosh-client"].includes(executable) || argv.some(arg => arg === "--server" || arg.startsWith("--server="));
    const cwd = pane?.cwd || terminal?.cwd || space.folder || null;
    const session = (terminal?.report?.title || a.title || "").replace(/^[⠁-⣿]+\s*/u, "").replace(/^OC \|\s*/, "").trim();
    const generic = !session || session === a.program?.name || session.toLowerCase() === a.program?.key || /^[~/]|^[A-Za-z]:\\/.test(session);
    return {
      ...a,
      title: !generic ? session : a.program?.name || "Agent",
      directory: cwd ? cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd : "Unknown directory",
      cwd,
      branch: pane?.branch || null,
      machine: space.machine,
      createdMs: terminal?.created_ms ?? null, filesystemTrusted: !remoteConnection,
      executionHost: remoteConnection ? `unbound:${a.address}` : space.machine ?? "local",
    };
  });
}

export function prMetadata(url, number) {
  const match = typeof url === "string" && url.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/);
  if (!match || Number(match[3]) !== number || !Number.isSafeInteger(number)) return null;
  return { url: url.replace(/\/$/, ""), repo: { host: "github.com", owner: match[1], name: match[2] } };
}

export function repositoryLabel(card, badge) {
  if (card.sessionBound) return card.directory;
  return prMetadata(badge?.url, badge?.number)?.repo.name ?? card.directory;
}

export function agentViewMode(value) { return value === "repository" ? "repository" : "list"; }
export function agentGroups(cards) {
  const groups = new Map();
  for (const card of cards) {
    const repo = card.projectRepo;
    const cwd = typeof card.cwd === "string" ? card.cwd.replace(/[\\/]+$/, "") || "/" : null;
    const host = card.executionHost ?? card.machine ?? "local";
    const key = repo?.host && repo.owner && repo.name
      ? JSON.stringify(["repo", repo.host.toLowerCase(), repo.owner.toLowerCase(), repo.name.toLowerCase()])
      : JSON.stringify(["folder", host, cwd]);
    if (!groups.has(key)) groups.set(key, { key, name: repo?.name ?? (cwd ? cwd.split(/[\\/]/).pop() || cwd : "Unknown directory"),
      tooltip: repo ? `${repo.owner}/${repo.name}` : `${host} · ${cwd ?? "Directory unavailable"}`, cards: [] });
    groups.get(key).cards.push(card);
  }
  return [...groups.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.key.localeCompare(b.key));
}

export class WorkingDirectories {
  constructor() { this.entries = new Map(); }
  key(card) { return JSON.stringify([card.machine ?? null, card.cwd, card.branch ?? null]); }
  needs(card, now = Date.now()) {
    if (!card.cwd || card.filesystemTrusted === false) return false;
    const entry = this.entries.get(this.key(card));
    return !entry || !entry.pending && now >= entry.expires;
  }
  peek(card) { return card.filesystemTrusted === false ? null : this.entries.get(this.key(card))?.value ?? null; }
  async refresh(card, execute, now = Date.now()) {
    if (!card.cwd || card.filesystemTrusted === false) return null;
    const key = this.key(card), previous = this.entries.get(key);
    if (previous?.pending) return previous.pending;
    if (previous && now < previous.expires) return previous.value;
    const entry = { value: previous?.value ?? null, pending: null, expires: now + 60000 };
    this.entries.set(key, entry);
    entry.pending = (async () => {
      const options = { cwd: card.cwd, on: card.machine ?? null };
      const git = async args => {
        const r = await execute("git", args, options);
        return r.code === 0 ? r.stdout.trim() : null;
      };
      try {
        const gitRoot = await git(["rev-parse", "--show-toplevel"]);
        if (!gitRoot) return entry.value = null;
        const remote = await git(["config", "--get", "remote.origin.url"]);
        const match = remote?.match(/^(?:git@github\.com:|https:\/\/github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
        if (!match) return entry.value = null;
        const repo = { host: "github.com", owner: match[1], name: match[2] };
        let projectRepo = repo;
        if (previous?.value?.repo?.owner === repo.owner && previous.value.repo.name === repo.name) projectRepo = previous.value.projectRepo;
        const branch = await git(["branch", "--show-current"]);
        const checkout = await execute("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], options);
        const paths = checkout.code === 0 ? checkout.stdout.replace(/\r?\n$/, "").split(/\r?\n/) : [];
        const checkoutType = paths.length === 2 && paths.every(p => /^(?:\/|[A-Za-z]:[\\/])/.test(p) && !/[\x00-\x1f\x7f]/.test(p)) ? paths[0] === paths[1] ? "checkout" : "worktree" : null;
        const prefix = await git(["rev-parse", "--show-prefix"]);
        const subdir = prefix && !/^[\\/]|[\x00-\x1f]/.test(prefix) && !prefix.split(/[\\/]/).includes("..") ? prefix.replace(/[\\/]+$/, "") : null;
        try {
          const r = await execute("gh", ["repo", "view", `${repo.owner}/${repo.name}`, "--json", "name,owner,parent,url"], { on: card.machine ?? null });
          const info = r.code === 0 ? JSON.parse(r.stdout) : null;
          if (info?.url?.replace(/\/$/, "").toLowerCase() === `https://github.com/${repo.owner}/${repo.name}`.toLowerCase()
            && /^[\w.-]+$/.test(info.parent?.owner?.login ?? "") && /^[\w.-]+$/.test(info.parent?.name ?? "")) {
            projectRepo = { host: repo.host, owner: info.parent.owner.login, name: info.parent.name };
          }
        } catch {} // Git identity remains usable without GitHub access.
        return entry.value = { repo, projectRepo, gitRoot, cwd: card.cwd, branch, checkoutType, detached: branch === "", directory: repo.name + (subdir ? `/${subdir}` : ""),
          metadataHint: `${card.machine ?? "local"} · ${card.cwd}${branch ? ` · ${branch}` : ""} · Verified working directory` };
      } catch { return entry.value = null; }
    })();
    try { return await entry.pending; } finally { entry.pending = null; }
  }
}

export function sessionPullRequest(text) {
  const links = (text ?? "").match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*(?![A-Za-z0-9])/g);
  return links?.at(-1) ?? null;
}

export function cardPullRequest(card, lookup) {
  if (card.sessionBound && card.sessionPr) return card.sessionPr;
  if (card.sessionBound && card.suppressTitlePr) return null;
  if (!card.sessionBound && lookup.state === "ready") return { number: lookup.number, source: lookup.source ?? "github", ...prMetadata(lookup.url, lookup.number) };
  if (!card.sessionBound && !["loading", "unavailable", "error"].includes(lookup.state)) return null;
  const matches = [...(card.title ?? "").matchAll(/(?:^|\s)#([1-9]\d*)\b/g)];
  const numbers = [...new Set(matches.map(m => Number(m[1])))];
  return numbers.length === 1 && Number.isSafeInteger(numbers[0]) ? { number: numbers[0], source: "title" } : null;
}

function pullRequestResult(response) {
  if (response.code !== 0) {
    const message = response.stderr.trim() || "GitHub PR lookup failed";
    if (/not a git repository|no git remotes|not a github repository|none of the git remotes/i.test(message)) return { state: "unavailable" };
    if (/no pull requests? found/i.test(message)) return { state: "none" };
    return { state: "error", message };
  }
  const data = JSON.parse(response.stdout);
  if (Array.isArray(data) && data.length === 0) return { state: "none" };
  const pr = Array.isArray(data) ? data[0] : data;
  if (!Number.isSafeInteger(pr?.number) || pr.number < 1 || !["OPEN", "CLOSED", "MERGED"].includes(pr.state)) throw new Error("GitHub returned an invalid PR response");
  if (pr.url && !prMetadata(pr.url, pr.number)) throw new Error("GitHub returned an invalid PR URL");
  return pr.state === "OPEN" ? { state: "ready", number: pr.number, ...prMetadata(pr.url, pr.number) } : { state: "none" };
}

export class PullRequests {
  constructor() {
    this.entries = new Map();
  }

  key(card) {
    return JSON.stringify([card.machine ?? null, card.address ?? null, card.cwd, card.branch ?? null, card.createdMs ?? null, card.filesystemTrusted ?? null]);
  }

  needs(card, now = Date.now()) {
    if (card.sessionBound) return false;
    if (!card.cwd && !card.address) return false;
    const entry = this.entries.get(this.key(card));
    return !entry || (!entry.pending && now >= entry.expires);
  }

  peek(card) {
    return card.cwd || card.address ? this.entries.get(this.key(card))?.value ?? { state: "loading" } : { state: "unavailable" };
  }

  async refresh(card, execute, now = Date.now()) {
    if (!card.cwd && !card.address) return { state: "unavailable" };
    const key = this.key(card);
    const previous = this.entries.get(key);
    if (previous?.pending) return previous.pending;
    if (previous && now < previous.expires) return previous.value;
    const entry = { value: previous?.value ?? { state: "loading" }, expires: 0, pending: null };
    this.entries.set(key, entry);
    entry.pending = (async () => {
      try {
        const args = card.branch
          ? ["pr", "list", "--head", card.branch, "--state", "open", "--limit", "1", "--json", "number,state,url,title,headRefName,headRepository,headRepositoryOwner"]
          : ["pr", "view", "--json", "number,state,url,title,headRefName,headRepository,headRepositoryOwner"];
        entry.value = card.cwd && card.filesystemTrusted !== false
          ? pullRequestResult(await execute("gh", args, { cwd: card.cwd, on: card.machine ?? null }))
          : { state: "unavailable" };
        if (entry.value.state === "unavailable" && card.address) {
          const history = await execute("hc", ["read", card.address, "--lines", "250"], { on: null });
          if (history.code !== 0) throw new Error(history.stderr.trim() || "Could not read agent terminal for PR discovery");
          const url = sessionPullRequest(history.stdout);
          if (url) {
            entry.value = pullRequestResult(await execute("gh", ["pr", "view", url, "--json", "number,state,url,title,headRefName,headRepository,headRepositoryOwner"], { on: card.machine ?? null }));
            if (entry.value.state === "ready") entry.value = { ...entry.value, source: "terminal", ...prMetadata(url, entry.value.number) };
          }
        }
      } catch (error) {
        entry.value = { state: "error", message: String(error.message || error) };
      }
      entry.expires = now + 60000;
      return entry.value;
    })();
    try {
      return await entry.pending;
    } finally {
      entry.pending = null;
    }
  }
}
