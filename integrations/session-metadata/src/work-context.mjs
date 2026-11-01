import { isAbsolute } from "node:path";
import { sessionKey } from "./contracts.mjs";
import { ticketReference } from "./naming.mjs";
import { githubRepo, resolveGithubRepo } from "./github.mjs";
export { githubRepo } from "./github.mjs";

const caches = new WeakMap();
export const repoKey = repo => `${repo.host}/${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
export function githubPr(value, now = Date.now()) {
  const m = value?.url?.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/);
  if (!m || Number(m[3]) !== value.number || !Number.isSafeInteger(value.number) || !["OPEN", "CLOSED", "MERGED"].includes(value.state)) throw new Error("Invalid GitHub PR metadata");
  return { repo: { host: "github.com", owner: m[1], name: m[2] }, number: value.number, url: value.url.replace(/\/$/, ""), state: value.state,
    title: String(value.title ?? "").replace(/[\x00-\x1f\x7f]/g, " "), headRefName: value.headRefName ?? "",
    headRepo: value.headRepository?.name && value.headRepositoryOwner?.login
      ? { host: "github.com", owner: value.headRepositoryOwner.login, name: value.headRepository.name } : null, verifiedAt: now };
}
export function observedDirectory(input) {
  const direct = input.workdir ?? input.cwd;
  if (typeof direct === "string" && isAbsolute(direct) && !/[\x00-\x1f]/.test(direct)) return direct;
  const command = input.command;
  if (typeof command !== "string" || /[$`|;\n]/.test(command)) return null;
  const cd = command.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s&]+))\s*&&\s*(?:git|gh)\b/);
  const git = command.match(/^\s*git\s+-C\s+(?:"([^"]+)"|'([^']+)'|([^\s&]+))/);
  const match = cd ?? git;
  const path = match && (match[1] ?? match[2] ?? match[3]);
  return path && isAbsolute(path) ? path : null;
}
export async function resolveWorkContext(observation, previous, run) {
  if (!caches.has(run)) caches.set(run, new Map());
  const cache = caches.get(run);
  const input = observation.payload ?? {};
  if (observation.parentId || observation.kind === "tool" && input.failed) return { state: "unavailable", reason: "not-successful-root-work" };
  const host = observation.session.host;
  const cwd = observedDirectory(input);
  const explicit = String(input.output ?? "").match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*/g) ?? [];
  const command = String(input.command ?? "").trim().replace(/^cd\s+(?:"[^"]+"|'[^']+'|[^\s&]+)\s*&&\s*/, "");
  const creation = /^gh\s+pr\s+(?:create|edit)\b/.test(command);
  let root = null, repo = null, subdir = null, branch = null, checkoutType = null;
  if (cwd) {
    const git = async args => {
      const r = await run(host, "git", args, { cwd });
      return r.code === 0 ? r.stdout.trim() : null;
    };
    root = await git(["rev-parse", "--show-toplevel"]);
    if (root) {
      repo = await resolveGithubRepo(await git(["config", "--get", "remote.origin.url"]),(command,args,options)=>run(host,command,args,options),{cwd});
      branch = await git(["branch", "--show-current"]);
      const checkout = await run(host, "git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { cwd });
      const paths = checkout.code === 0 ? checkout.stdout.replace(/\r?\n$/, "").split(/\r?\n/) : [];
      if (paths.length === 2 && paths.every(p => /^(?:\/|[A-Za-z]:[\\/])/.test(p) && !/[\x00-\x1f\x7f]/.test(p))) checkoutType = paths[0] === paths[1] ? "checkout" : "worktree";
      subdir = await git(["rev-parse", "--show-prefix"]);
      if (subdir && (isAbsolute(subdir) || subdir.split("/").includes(".."))) return { state: "ambiguous", reason: "invalid-relative-directory" };
      subdir = subdir?.replace(/\/$/, "") || null;
    }
  }
  const sameRepo = previous?.host === host && previous?.repo && repo && repoKey(previous.repo) === repoKey(repo);
  const sameWork = sameRepo && previous.gitRoot === root && previous.branch === branch;
  const matchesRepo = pr => !repo || repoKey(pr.repo) === repoKey(repo) || pr.headRepo && repoKey(pr.headRepo) === repoKey(repo);
  const known = sameRepo ? Object.values(previous.prs ?? {}).filter(pr => pr.state === "OPEN" && pr.headRefName === branch && matchesRepo(pr)) : [];
  const prior = known.find(pr => pr.url === previous.activePrUrl) ?? known.find(pr => pr.url === previous.lastCreatedPrUrl) ?? (known.length === 1 ? known[0] : null);
  const explicitTarget = creation && explicit.length === 1 ? explicit[0] : null;
  const target = explicitTarget ?? prior?.url;
  const detached = branch === "";
  if (!repo && !target) return { state: "unavailable", reason: "no-verified-repository" };
  const cacheKey = JSON.stringify([sessionKey(observation.session), repo && repoKey(repo), root, branch, target]);
  let prs = detached ? { at: Date.now(), list: [], projectRepo: (sameRepo ? previous.projectRepo : null) ?? repo, status: "ready" } : cache.get(cacheKey);
  if (!prs && !explicitTarget && sameWork && previous.prStatus && Date.now() - previous.prAttemptedAt < 60000) {
    prs = { at: previous.prAttemptedAt, list: prior ? [prior] : [], status: previous.prStatus, projectRepo: previous.projectRepo ?? repo };
  }
  if (!prs || Date.now() - prs.at >= 60000 || explicitTarget) {
    const fields = "number,state,url,title,headRefName,headRepository,headRepositoryOwner";
    if (!target && !branch) return { state: "unavailable", reason: "no-branch" };
    let projectRepo = prior?.repo ?? (sameRepo ? previous.projectRepo : null) ?? repo;
    try {
      if (!target && repo) {
        const repoResponse = await run(host, "gh", ["repo", "view", `${repo.owner}/${repo.name}`, "--json", "name,owner,parent,url"], {});
        if (repoResponse.code === 0) {
          const info = JSON.parse(repoResponse.stdout), identity = githubRepo(info.url);
          if (identity && repoKey(identity) === repoKey(repo) && /^[\w.-]+$/.test(info.parent?.owner?.login ?? "") && /^[\w.-]+$/.test(info.parent?.name ?? "")) {
            projectRepo = { host: repo.host, owner: info.parent.owner.login, name: info.parent.name };
          }
        }
      }
      const args = target ? ["pr", "view", target, "--json", fields]
        : ["pr", "list", "--repo", `${projectRepo.owner}/${projectRepo.name}`, "--head", branch, "--state", "open", "--limit", "20", "--json", fields];
      const response = await run(host, "gh", args, cwd && repo ? { cwd } : {});
      if (response.code !== 0) throw new Error("GitHub unavailable");
      const values = JSON.parse(response.stdout);
      let list = (Array.isArray(values) ? values : [values]).map(p => githubPr(p));
      if (target && list.some(p => !matchesRepo(p))) return { state: "ambiguous", reason: "pr-repository-mismatch" };
      if (target && branch && list.some(p => p.headRefName !== branch)) return { state: "ambiguous", reason: "pr-branch-mismatch" };
      if (!target) list = list.filter(p => p.headRefName === branch && matchesRepo(p));
      prs = { at: Date.now(), list, projectRepo: list[0]?.repo ?? projectRepo, status: "ready" };
    } catch {
      if (!repo) return { state: "unavailable", reason: "github-unavailable" };
      prs = { at: Date.now(), list: prior ? [prior] : [], projectRepo, status: "unavailable" };
    }
    cache.set(cacheKey, prs);
    if (cache.size > 128) cache.delete(cache.keys().next().value);
  }
  if (prs.list.length > 1) return { state: "ambiguous", reason: "multiple-prs" };
  const pr = prs.list[0];
  repo ??= pr?.headRepo ?? pr?.repo;
  if (!repo) return { state: "unavailable", reason: "no-repository" };
  const task = input.taskTicket ?? (observation.kind === "task" ? ticketReference(input.prompt) : null);
  const refs = [task, ticketReference(pr?.title), ticketReference(branch?.toUpperCase())];
  const ids = [...new Set(refs.map(r => r?.id).filter(Boolean))];
  const conflict = refs.some(r => r?.ambiguous) || ids.length > 1;
  const ticket = !conflict && ids.length ? { id: ids[0], source: task?.id ? "task" : ticketReference(pr?.title).id ? "pr" : "branch" } : null;
  return { state: conflict ? "ambiguous" : "resolved", ...(conflict ? { reason: "conflicting-tickets" } : {}), context: { host, gitRoot: root, cwd: root ? cwd : null, repo, subdir, branch, ticket,
    checkedAt: prs.status === "ready" ? prs.at : sameWork ? previous.checkedAt : 0, prAttemptedAt: prs.at, prStatus: prs.status,
    detached, checkoutType, prContextChanged: Boolean(previous && (!sameWork || previous.prContextChanged && prs.status !== "ready")), projectRepo: prs.projectRepo ?? repo,
    prs: { ...(sameRepo ? previous.prs : {}), ...(pr ? { [pr.url]: pr } : {}) },
    activePrUrl: pr?.state === "OPEN" ? pr.url : null,
    lastCreatedPrUrl: creation && pr ? pr.url : sameRepo ? previous.lastCreatedPrUrl : null } };
}
