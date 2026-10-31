import { prMetadata } from "./model.js";

const sessionKey = key => JSON.stringify([key.host, key.authority, key.harness, key.id]);
const bindingKey = b => JSON.stringify([b.coreHost, b.coreSession, b.terminal, b.createdMs]);
const validRepository = repo => repo?.host === "github.com" && /^[\w.-]+$/.test(repo.owner ?? "") && /^[\w.-]+$/.test(repo.name ?? "");
export function readSessionView(raw, liveTerminals) {
  const records = new Map();
  if (raw?.schema !== 1 || raw.owner !== "herdr-session-metadata" || !Array.isArray(raw.entries)) return records;
  for (const entry of raw.entries) {
    const { binding: b, record: r } = entry ?? {};
    if (!b?.session || !r?.session || r.schema !== 1 || r.ended || !Array.isArray(r.bindings)
      || !r.contexts || typeof r.contexts !== "object" || typeof r.canonicalTitle !== "string"
      || /[\x00-\x1f\x7f]/.test(r.canonicalTitle) || sessionKey(b.session) !== sessionKey(r.session)) continue;
    const key = bindingKey(b);
    if (!r.bindings.some(proof => proof.key === key && proof.generation === b.generation)) continue;
    for (const terminal of liveTerminals) {
      if (terminal.state !== "live" || terminal.created_ms !== b.createdMs || terminal.address !== (b.viewTerminal ?? b.terminal)) continue;
      let proof;
      try { proof = JSON.parse(terminal.labels?.["herdr.meta-binding"] ?? "null"); } catch { continue; }
      if (proof?.key === key && proof.generation === b.generation) records.set(terminal.address, r);
    }
  }
  return records;
}
export function projectSessionCard(card, record) {
  if (!record) return card;
  const context = record.contexts?.[record.activeRepo];
  const scope = record.workScope;
  if (!context && scope?.version === 1 && typeof scope.path === "string" && scope.host === record.session.host) {
    return { ...card, title: record.canonicalTitle || card.title, sessionBound: true, sessionPr: null, suppressTitlePr: true,
      projectRepo: null, executionHost: scope.host, detached: false, prStale: false, checkoutType: null,
      directory: scope.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || scope.path, cwd: scope.path, branch: null,
      metadataHint: `${scope.host} · ${scope.path} · Session work directory` };
  }
  const pr = context?.prs?.[context.activePrUrl];
  const active = pr?.state === "OPEN" ? prMetadata(pr.url, pr.number) : null;
  const repo = context?.repo;
  const validRepo = validRepository(repo);
  const project = context?.projectRepo ?? repo;
  const closedPr = Object.values(context?.prs ?? {}).some(p => p?.headRefName === context?.branch && ["CLOSED", "MERGED"].includes(p?.state));
  const subdir = typeof context?.subdir === "string" && context.subdir.split("/").every(p => p && p !== "." && p !== "..")
    && !/[\x00-\x1f\\]/.test(context.subdir) ? context.subdir : null;
  return { ...card, title: record.canonicalTitle || card.title, sessionBound: true,
    sessionPr: active ? { ...active, number: pr.number, source: "session" } : null,
    suppressTitlePr: Boolean(context && (context.prStatus === "ready" || context.prContextChanged || closedPr)),
    projectRepo: validRepository(project) ? project : null, executionHost: record.session?.host ?? context?.host ?? card.machine ?? "local",
    detached: Boolean(context?.detached), prStale: context?.prStatus === "unavailable",
    checkoutType: ["checkout", "worktree"].includes(context?.checkoutType) ? context.checkoutType : null,
    directory: validRepo ? repo.name + (context.gitRoot && subdir ? `/${subdir}` : "") : active?.repo.name ?? card.directory,
    cwd: context?.cwd ?? card.cwd, branch: context?.branch ?? card.branch,
    metadataHint: context ? `${context.host} · ${context.cwd ?? "PR repository"}${context.branch ? ` · ${context.branch}` : ""} · Verified session metadata` : "Canonical session title" };
}
