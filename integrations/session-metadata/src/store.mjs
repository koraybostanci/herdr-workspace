import * as fs from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { OWNER, sessionKey, bindingKey, validBinding, validRecord, validateSnapshot } from "./contracts.mjs";
import { validateRegistry, normalizedDirectory } from "./session-registry.mjs";

const hash = key => createHash("sha256").update(key).digest("hex");
export async function readJson(path) {
  try { return JSON.parse(await fs.readFile(path, "utf8")); }
  catch (e) { if (e.code === "ENOENT" || e instanceof SyntaxError) return null; throw e; }
}
export async function atomicJson(path, value) {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await fs.rename(temp, path);
  } finally { await fs.unlink(temp).catch(e => { if (e.code !== "ENOENT") throw e; }); }
}
export function createStore({ root, viewFile, clock = Date.now }) {
  const path = (kind, key) => join(root, kind, `${hash(key)}.json`);
  async function ensure() {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const ownerPath = join(root, "owner.json");
    let owner = await readJson(ownerPath);
    if (!owner) {
      const existing = await fs.readdir(root);
      if (existing.some(p => p !== "owner.json")) throw new Error("Refusing foreign state directory without owner");
      try { await fs.writeFile(ownerPath, JSON.stringify({ schema: 1, owner: OWNER }), { flag: "wx", mode: 0o600 }); }
      catch (e) { if (e.code !== "EEXIST") throw e; }
      owner = await readJson(ownerPath);
    }
    if (owner?.owner !== OWNER || owner?.schema !== 1) throw new Error("Foreign metadata owner");
    await fs.chmod(root, 0o700);
  }
  async function locked(key, action) {
    await ensure();
    const lockDir = join(root, "locks");
    await fs.mkdir(lockDir, { mode: 0o700, recursive: true });
    const lock = join(lockDir, hash(key));
    const until = Date.now() + 2000;
    let handle;
    for (;;) {
      try { handle = await fs.open(lock, "wx", 0o600); await handle.writeFile(JSON.stringify({ owner: OWNER, pid: process.pid })); break; }
      catch (e) {
        if (e.code !== "EEXIST") throw e;
        const held = await readJson(lock);
        if (held?.owner === OWNER && Number.isSafeInteger(held.pid)) {
          try { process.kill(held.pid, 0); }
          catch (p) { if (p.code === "ESRCH") { await fs.unlink(lock).catch(() => {}); continue; } }
        }
        if (Date.now() >= until) throw new Error("Metadata record busy");
        await delay(15);
      }
    }
    try { return await action(); }
    finally { await handle.close(); await fs.unlink(lock); }
  }
  const store = {
    root, viewFile,
    withHistoryMutation(action) { return locked("history-refresh", action); },
    async readHistory() {
      await ensure();
      let raw;
      try { raw = JSON.parse(await fs.readFile(join(root, "history/registry.json"), "utf8")); }
      catch (e) { if (e.code === "ENOENT") return null; throw Error("Invalid history registry"); }
      if (!validateRegistry(raw)) throw Error("Invalid history registry owner or schema");
      return raw;
    },
    async writeHistory(registry, expectedRevision) {
      if (!validateRegistry(registry)) throw Error("Invalid history registry");
      return locked("history-write", async () => {
        const old = await store.readHistory();
        if ((old?.revision ?? null) !== expectedRevision) throw Error("History revision changed");
        await atomicJson(join(root, "history/registry.json"), registry);
      });
    },
    async listHistoryAssociations() {
      await ensure();
      const files = await fs.readdir(join(root, "history-associations")).catch(e => { if (e.code === "ENOENT") return []; throw e; });
      const values = await Promise.all(files.filter(f => /^[a-f0-9]{64}\.json$/.test(f)).map(f => readJson(join(root, "history-associations", f))));
      return values.filter(v => v?.owner === OWNER && v.schema === 1 && !v.missing && typeof v.space?.id === "string" && typeof v.space.host === "string"
        && typeof v.space.coreSession === "string" && Number.isSafeInteger(v.associatedAt) && (() => { try { return Boolean(sessionKey(v.session)); } catch { return false; } })());
    },
    async markHistoryMissing(session) {
      return store.withMutation(session, async () => {
        const location = path("history-associations", sessionKey(session)), value = await readJson(location);
        if (value?.owner === OWNER && value.schema === 1) await atomicJson(location, { ...value, missing: true });
      });
    },
    async beginHistoryBrowse(session, space, baseline = 0) {
      const key = sessionKey(session);
      if (!space || ![space.host, space.coreSession, space.id].every(v => typeof v === "string" && v && !/[\x00-\x1f\x7f]/.test(v))) throw Error("Invalid browsing Space");
      return store.withMutation(session, () => atomicJson(path("history-opening", key), { schema: 1, owner: OWNER, session,
        space: { host: space.host, coreSession: space.coreSession, id: space.id }, baseline: Number.isSafeInteger(baseline) && baseline >= 0 ? baseline : 0 }));
    },
    async activateSessionBinding(binding, { observedAt } = {}) {
      if (!validBinding(binding)) return false;
      return locked(`binding:${bindingKey(binding)}`, async () => {
        const current = await store.getBinding(bindingKey(binding));
        if (current?.generation !== binding.generation || sessionKey(current.session) !== sessionKey(binding.session) || current.browsing !== true
          || observedAt != null && (!Number.isSafeInteger(observedAt) || observedAt <= (current.browseBaseline ?? 0))) return false;
        await atomicJson(path("bindings", bindingKey(binding)), { ...current, browsing: false });
        return true;
      });
    },
    withMutation(key, action) { return locked(`mutation:${sessionKey(key)}`, action); },
    async read(key) {
      await ensure();
      const record = await readJson(path("sessions", sessionKey(key)));
      return validRecord(record) && sessionKey(record.session) === sessionKey(key) ? record : null;
    },
    async write(record, expectedRevision) {
      if (!validRecord(record)) throw new Error("Invalid session record; raw payloads are not permitted");
      return locked(`session:${sessionKey(record.session)}`, async () => {
        const previous = await store.read(record.session);
        if ((previous?.revision ?? null) !== expectedRevision) return false;
        if (previous && record.revision !== previous.revision + 1) return false;
        await atomicJson(path("sessions", sessionKey(record.session)), record);
        return true;
      });
    },
    async getBinding(key) { await ensure(); const b = await readJson(path("bindings", key)); return validBinding(b) && bindingKey(b) === key ? b : null; },
    async listBindings() {
      await ensure();
      const files = await fs.readdir(join(root, "bindings")).catch(e => { if (e.code === "ENOENT") return []; throw e; });
      const bindings = await Promise.all(files.filter(f => /^[a-f0-9]{64}\.json$/.test(f)).map(f => readJson(join(root, "bindings", f))));
      return bindings.filter(validBinding);
    },
    async bind(binding, expectedGeneration) {
      if (!validBinding(binding)) return false;
      const key = bindingKey(binding);
      return store.withMutation(binding.session, () => locked(`binding:${key}`, async () => {
        const old = await store.getBinding(key);
        if ((old?.generation ?? null) !== expectedGeneration) return false;
        const intent = await readJson(path("history-opening", sessionKey(binding.session)));
        const sameOwner = old && sessionKey(old.session) === sessionKey(binding.session) && old.processPid === binding.processPid;
        const browsingIntent = intent?.owner === OWNER && intent.schema === 1 && binding.space
          && intent.space?.host === binding.space.host && intent.space.coreSession === binding.space.coreSession && intent.space.id === binding.space.id;
        const registered = { ...binding, browsing: sameOwner ? old.browsing === true : Boolean(browsingIntent),
          browseBaseline: sameOwner ? old.browseBaseline ?? 0 : browsingIntent ? intent.baseline : 0 };
        await atomicJson(path("bindings", key), registered);
        if (browsingIntent) await fs.unlink(path("history-opening", sessionKey(binding.session)));
        if (binding.space) await atomicJson(path("history-associations", sessionKey(binding.session)),
          { schema: 1, owner: OWNER, session: binding.session, space: binding.space, directory: normalizedDirectory(binding.lookupDir), associatedAt: clock() });
        return true;
      }));
    },
    async releaseSessionBinding(binding) {
      if (!validBinding(binding)) return false;
      return store.withMutation(binding.session, async () => {
        const key = bindingKey(binding), current = await store.getBinding(key);
        if (current?.generation !== binding.generation || sessionKey(current.session) !== sessionKey(binding.session)) return false;
        await store.invalidate(key, binding.generation);
        const record = await store.read(binding.session);
        if (record) {
          const remaining = (await store.listBindings()).filter(b => sessionKey(b.session) === sessionKey(binding.session));
          await store.write({ ...record, revision: record.revision + 1, ended: remaining.length === 0,
            bindings: record.bindings.filter(b => b.key !== key || b.generation !== binding.generation),
            pendingRename: record.pendingRename?.generation === binding.generation ? null : record.pendingRename }, record.revision);
        }
        return true;
      });
    },
    async invalidate(key, generation) {
      return locked(`binding:${key}`, async () => {
        if ((await store.getBinding(key))?.generation === generation) await fs.unlink(path("bindings", key));
      });
    },
    async view(liveTerminals) {
      await ensure();
      const entries = [];
      for (const terminal of liveTerminals) {
        let proof;
        try { proof = JSON.parse(terminal.labels?.["herdr.meta-binding"] ?? "null"); } catch { continue; }
        if (!proof?.key || !proof.generation || terminal.state !== "live") continue;
        const binding = await store.getBinding(proof.key);
        if (!binding || binding.generation !== proof.generation || binding.createdMs !== terminal.created_ms) continue;
        const record = await store.read(binding.session);
        if (!record || record.ended || !record.bindings.some(b => b.key === proof.key && b.generation === proof.generation)) continue;
        entries.push({ binding, record });
      }
      return { schema: 1, owner: OWNER, updatedAt: clock(), entries };
    },
    async publish(view) {
      if (!validateSnapshot(view)) throw new Error("Invalid metadata view");
      const old = await readJson(viewFile);
      if (old && (old.owner !== OWNER || old.schema !== 1)) throw new Error("Foreign metadata view");
      await atomicJson(viewFile, view);
    },
    async activationMode() {
      const value = await readJson(join(root, "activation.json"));
      return value?.owner === OWNER && value?.schema === 1 && value.mode === "active" ? "active" : "observe";
    },
  };
  return store;
}
