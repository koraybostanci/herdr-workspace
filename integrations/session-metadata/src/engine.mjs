import { blankRecord, sessionKey, bindingKey } from "./contracts.mjs";
import { proposeTitle, ticketReference } from "./naming.mjs";
import { resolveWorkContext, repoKey } from "./work-context.mjs";
import { selectWorkScope, operationScope } from "./scope.mjs";

const queues = new Map();
async function currentBinding(binding, deps) {
  const value = await deps.store.getBinding(bindingKey(binding));
  return value?.generation === binding.generation && sessionKey(value.session) === sessionKey(binding.session) && await deps.validateBinding(binding);
}
export async function applyPendingRename(key, binding, expectedRevision, deps) {
  return deps.store.withMutation(key, () => applyPending(key, binding, expectedRevision, deps));
}
async function applyPending(key, binding, expectedRevision, deps) {
  if (await deps.activationMode() !== "active" || !await deps.hasAuthority(binding) || !await currentBinding(binding, deps)) return null;
  const record = await deps.store.read(key);
  const pending = record?.pendingRename;
  if (!record || record.ended || record.revision !== expectedRevision || pending?.revision !== expectedRevision || pending.generation !== binding.generation) return null;
  const current = await deps.access.get(key);
  if (sessionKey(current.key) !== sessionKey(key) || current.parentId) return null;
  if (current.title !== pending.expectedTitle) {
    await deps.store.write({ ...record, revision: record.revision + 1, canonicalTitle: current.title,
      manualOverride: true, pendingRename: null }, record.revision);
    return null;
  }
  if (!await currentBinding(binding, deps) || (await deps.store.read(key))?.revision !== expectedRevision) return null;
  if (await deps.activationMode() !== "active" || !await deps.hasAuthority(binding)) return null;
  await deps.access.rename(key, pending.title);
  const actual = await deps.access.get(key);
  if (sessionKey(actual.key) !== sessionKey(key) || actual.parentId || !await currentBinding(binding, deps)) return null;
  if (actual.title !== pending.title) {
    if (actual.title !== pending.expectedTitle) await deps.store.write({ ...record, revision: record.revision + 1,
      canonicalTitle: actual.title, manualOverride: true, pendingRename: null }, expectedRevision);
    return null;
  }
  const updated = { ...record, revision: record.revision + 1, canonicalTitle: actual.title, lastManagedTitle: actual.title, pendingRename: null };
  return await deps.store.write(updated, expectedRevision) ? updated : null;
}
export function applyObservation(observation, binding, deps) {
  const key = sessionKey(observation.session);
  const previous = queues.get(key) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(() => deps.store.withMutation(observation.session, () => apply(observation, binding, deps)));
  queues.set(key, work);
  const cleanup = () => { if (queues.get(key) === work) queues.delete(key); };
  work.then(cleanup, cleanup);
  return work;
}
// Sessions sharing a checkout all see the branch of whichever one switched it; only the creator or a session that did its own work there owns its PR.
async function createdElsewhere(url, session, deps) {
  for (const other of await deps.store.listBindings()) {
    if (sessionKey(other.session) === sessionKey(session)) continue;
    const record = await deps.store.read(other.session);
    if (record && !record.ended && Object.values(record.contexts).some(c => c?.lastCreatedPrUrl === url)) return true;
  }
  return false;
}
async function apply(observation, binding, deps) {
  const ignored = { state: "ignored", record: null };
  if (!binding || observation.parentId || observation.generation !== binding.generation || sessionKey(observation.session) !== sessionKey(binding.session) || !await currentBinding(binding, deps)) return ignored;
  const previous = await deps.store.read(observation.session);
  const old = previous ?? blankRecord(observation.session);
  if (old.ended || old.seenEvents.includes(observation.eventId) || observation.observedAt < old.lastObservedAt) return ignored;
  const current = await deps.access.get(observation.session);
  if (current.parentId || sessionKey(current.key) !== sessionKey(observation.session)) return ignored;
  const next = { ...old, revision: old.revision + 1, canonicalTitle: current.title,
    description: old.description ?? current.title,
    bindings: [...old.bindings.filter(b => b.key !== bindingKey(binding)), { key: bindingKey(binding), generation: binding.generation }],
    seenEvents: [...old.seenEvents, observation.eventId].slice(-256), lastObservedAt: observation.kind === "title" ? old.lastObservedAt : observation.observedAt };
  if (old.lastManagedTitle && old.lastManagedTitle !== current.title) next.manualOverride = true;
  if (observation.kind === "end") {
    next.ended = true; next.pendingRename = null;
    await deps.store.write(next, previous?.revision ?? null);
    await deps.store.invalidate(bindingKey(binding), binding.generation);
    return { state: "published", record: next };
  }
  if (observation.kind === "task") {
    const reference = ticketReference(observation.payload?.prompt);
    if (reference.id || reference.ambiguous) next.taskTicket = reference;
  }
  const workScope = await selectWorkScope(observation, old.workScope, current.lookupDir ?? binding.lookupDir, deps.homeDirectory);
  next.workScope = workScope;
  const payload = { ...observation.payload, taskTicket: next.taskTicket, cwd: workScope?.path ?? null, workdir: workScope?.path ?? null,
    ownedWork: observation.kind === "tool" && Boolean(operationScope(observation.payload)) };
  if (observation.kind === "tool" && !operationScope(observation.payload)) { delete payload.command; delete payload.output; delete payload.failed; }
  const resolver = deps.resolveContext ?? ((o, context) => resolveWorkContext(o, context, deps.run));
  const result = workScope ? await resolver({ ...observation, payload }, old.contexts[old.activeRepo] ?? null) : { state: "unavailable" };
  if ((await deps.store.read(observation.session))?.revision !== previous?.revision || !await currentBinding(binding, deps)) return ignored;
  let proposal = { action: "noop", reason: "no-context" };
  next.activeRepo = null;
  if (result.context && ["resolved", "ambiguous"].includes(result.state)) {
    const name = repoKey(result.context.repo);
    const known = old.contexts[name];
    const owned = payload.ownedWork === true || known?.ownedBranch === result.context.branch;
    result.context = { ...result.context, ownedBranch: owned && result.context.branch ? result.context.branch : null };
    const url = result.context.activePrUrl;
    if (url && result.context.lastCreatedPrUrl !== url && !owned && await createdElsewhere(url, observation.session, deps)) {
      result.context = { ...result.context, activePrUrl: null };
    }
    next.contexts = { ...old.contexts, [name]: result.context }; next.activeRepo = name;
    if (result.state === "resolved" && result.context.prStatus !== "unavailable") proposal = proposeTitle({ currentTitle: current.title, lastManagedTitle: old.lastManagedTitle,
      manualOverride: next.manualOverride, description: next.description, context: result.context });
  }
  if (proposal.action === "rename") next.pendingRename = { expectedTitle: current.title, title: proposal.title, revision: next.revision, generation: binding.generation };
  else { next.pendingRename = null; if (proposal.reason === "already-named") next.lastManagedTitle = current.title; }
  if (!await deps.store.write(next, previous?.revision ?? null)) return ignored;
  if (proposal.action !== "rename") return { state: proposal.action === "pause" || result.state === "ambiguous" ? "paused" : "published", record: next };
  const acknowledged = await applyPending(observation.session, binding, next.revision, deps);
  return { state: acknowledged ? "renamed" : "pending", record: acknowledged ?? next };
}
