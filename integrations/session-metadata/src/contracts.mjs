import { randomUUID } from "node:crypto";

export const OWNER = "herdr-session-metadata";
const text = x => typeof x === "string" && x.length > 0 && !/[\x00-\x1f\x7f]/.test(x);
const integer = x => Number.isSafeInteger(x) && x > 0;
export const validSession = x => x && text(x.host) && text(x.authority) && ["opencode-v2", "claude"].includes(x.harness) && text(x.id) && /^[\w-]+$/.test(x.id);
export const isHerdrTerminal = term => Boolean(term?.labels?.["herdr.space"] && term.labels["herdr.tab"]);
export function sessionKey(key) {
  if (!validSession(key)) throw new Error("Invalid session identity");
  return JSON.stringify([key.host, key.authority, key.harness, key.id]);
}
export function bindingKey(b) {
  if (!b || !text(b.coreHost) || !text(b.coreSession) || !text(b.terminal) || !integer(b.createdMs)) throw new Error("Invalid terminal identity");
  return JSON.stringify([b.coreHost, b.coreSession, b.terminal, b.createdMs]);
}
export function validBinding(b) {
  try { return Boolean(bindingKey(b) && validSession(b.session) && integer(b.processPid) && text(b.generation) && ["inherited", "paired"].includes(b.mode)); }
  catch { return false; }
}
export const validWorkScope = scope => Boolean(scope && scope.version === 1 && text(scope.host) && text(scope.path) && /^(?:\/|[A-Za-z]:[\\/])/.test(scope.path)
  && text(scope.source) && text(scope.eventId) && Number.isFinite(scope.eventAt));
const recordFields = new Set(["schema", "session", "revision", "canonicalTitle", "lastManagedTitle", "manualOverride", "description", "taskTicket", "contexts", "activeRepo", "bindings", "pendingRename", "seenEvents", "lastObservedAt", "ended", "workScope"]);
export function validRecord(r) {
  return Boolean(r && r.schema === 1 && validSession(r.session) && Number.isSafeInteger(r.revision) && r.revision >= 0
    && Object.keys(r).every(k => recordFields.has(k))
    && [r.canonicalTitle, r.lastManagedTitle, r.description].every(s => s === null || typeof s === "string" && !/[\x00-\x1f\x7f]/.test(s))
    && typeof r.manualOverride === "boolean" && typeof r.ended === "boolean"
    && r.contexts && typeof r.contexts === "object" && !Array.isArray(r.contexts)
    && (r.workScope == null || validWorkScope(r.workScope) && r.workScope.host === r.session.host)
    && Array.isArray(r.bindings) && r.bindings.every(b => text(b.key) && text(b.generation))
    && Array.isArray(r.seenEvents) && r.seenEvents.length <= 256 && r.seenEvents.every(text)
    && Number.isFinite(r.lastObservedAt));
}
export function validateSnapshot(raw) {
  if (!raw || raw.schema !== 1 || raw.owner !== OWNER || !Array.isArray(raw.entries)) return null;
  for (const { binding, record } of raw.entries) {
    if (!validBinding(binding) || !validRecord(record) || sessionKey(binding.session) !== sessionKey(record.session)) return null;
    if (!record.bindings.some(b => b.key === bindingKey(binding) && b.generation === binding.generation)) return null;
  }
  return raw;
}
export function blankRecord(session) {
  return { schema: 1, session, revision: 0, canonicalTitle: null, lastManagedTitle: null, manualOverride: false,
    description: null, taskTicket: null, contexts: {}, activeRepo: null, bindings: [], pendingRename: null,
    seenEvents: [], lastObservedAt: 0, ended: false };
}
export async function producerMatches(term, producerPid, run, options = {}) {
  if (term?.state !== "live" || !integer(term.created_ms) || !integer(producerPid)) return false;
  if (!term.foreground?.pid) {
    const terminal = await processInfo(term.pid, run, options), producer = await processInfo(producerPid, run, options);
    if (!terminal || !producer || terminal.tty === "??" || terminal.tty === "?" || terminal.tty !== producer.tty
      || producer.pgid <= 0 || producer.pgid !== producer.tpgid || producer.stat.includes("T") || producer.stat.includes("Z")) return false;
    let pid = producerPid;
    for (let depth = 0; depth < 32 && integer(pid); depth++) {
      if (pid === term.pid) return true;
      const info = pid === producerPid ? producer : await processInfo(pid, run, options);
      if (!info || info.ppid === pid) return false;
      pid = info.ppid;
    }
    return false;
  }
  let pid = term.foreground?.pid;
  const visited = new Set();
  for (let depth = 0; depth < 32 && integer(pid) && !visited.has(pid); depth++) {
    if (pid === producerPid) return true;
    if (pid === term.pid) break;
    visited.add(pid);
    const result = await run("local", "ps", ["-o", "ppid=", "-p", String(pid)], options);
    if (result.code !== 0) break;
    pid = Number(result.stdout.trim());
  }
  return producerMatches({ ...term, foreground: null }, producerPid, run, options);
}
async function processInfo(pid, run, options) {
  if (!integer(pid)) return null;
  const result = await run("local", "ps", ["-o", "ppid=,pgid=,tpgid=,tty=,stat=", "-p", String(pid)], options);
  const fields = result.stdout.trim().split(/\s+/);
  if (result.code !== 0 || fields.length !== 5) return null;
  return { ppid: Number(fields[0]), pgid: Number(fields[1]), tpgid: Number(fields[2]), tty: fields[3], stat: fields[4] };
}
export async function foregroundProcess(term, run, options = {}) {
  if (integer(term?.foreground?.pid)) return term.foreground.pid;
  const info = await processInfo(term?.pid, run, options);
  return integer(info?.tpgid) && await producerMatches(term, info.tpgid, run, options) ? info.tpgid : null;
}
export async function verifyInheritedBinding({ env, producerPid, session, run }) {
  if (!env.HC_TERMINAL_ID || !validSession(session) || session.parentId) return null;
  const options = { env: { HC_SESSION: env.HC_SESSION ?? "default" } };
  const result = await run("local", "hc", ["get", env.HC_TERMINAL_ID, "--json"], options);
  if (result.code !== 0) return null;
  let term;
  try { term = JSON.parse(result.stdout); } catch { return null; }
  if (!isHerdrTerminal(term) || !await producerMatches(term, producerPid, run, options)) return null;
  return { coreHost: "local", coreSession: env.HC_SESSION ?? "default", terminal: env.HC_TERMINAL_ID,
    createdMs: term.created_ms, processPid: producerPid, generation: randomUUID(), session,
    space: { host: session.host, coreSession: env.HC_SESSION ?? "default", id: term.labels["herdr.space"] }, tab: term.labels["herdr.tab"],
    lookupDir: null, mode: "inherited" };
}
export async function bindingIsLive(binding, run, allowPaired = false) {
  if (!validBinding(binding) || binding.mode !== "inherited" && !allowPaired) return false;
  const options = { env: { HC_SESSION: binding.coreSession } };
  const result = await run("local", "hc", ["get", binding.terminal, "--json"], options);
  if (result.code !== 0) return false;
  let term;
  try { term = JSON.parse(result.stdout); } catch { return false; }
  return isHerdrTerminal(term) && term.created_ms === binding.createdMs && await producerMatches(term, binding.processPid, run, options);
}
export async function commitBinding(binding, { store, run, allowPaired = false }) {
  if (!await bindingIsLive(binding, run, allowPaired)) return false;
  const proof = JSON.stringify({ key: bindingKey(binding), generation: binding.generation });
  const result = await run("local", "hc", ["label", binding.terminal, `herdr.meta-binding=${proof}`], { env: { HC_SESSION: binding.coreSession } });
  if (result.code !== 0) return false;
  const previous = await store.getBinding(bindingKey(binding));
  return store.bind(binding, previous?.generation ?? null);
}
