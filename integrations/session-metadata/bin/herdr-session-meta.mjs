#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createStore, readJson, atomicJson } from "../src/store.mjs";
import { OWNER, verifyInheritedBinding, commitBinding, bindingKey, bindingIsLive } from "../src/contracts.mjs";
import { installOffer, createPairing, acceptPairing, ownerIsLive, launchPaired } from "../src/transport.mjs";

export function argument(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
}
export function createRuntime(env = process.env) {
  const root = env.HERDR_METADATA_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(env.HOME, ".local/state"), "herdr-agent-metadata");
  const appHome = env.HERDR_APP_HOME ?? join(env.HOME, ".config/herdr-app");
  const store = createStore({ root, viewFile: join(appHome, "data/space-agents/session-view.json") });
  const run = async (host, command, args, options = {}) => {
    if (host !== "local" && host !== (env.HERDR_METADATA_HOST ?? "local")) throw new Error("Execution peer is not configured");
    return new Promise(resolve => {
      const child = execFile(command, args, { cwd: options.cwd, timeout: options.timeout ?? 10000,
        maxBuffer: 8 * 1024 * 1024, env: { ...env, GH_PROMPT_DISABLED: "1", ...options.env } }, (e, stdout, stderr) => {
        resolve({ code: e ? Number.isInteger(e.code) ? e.code : 1 : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(options.input);
    });
  };
  return { root, appHome, store, run, env, clock: Date.now };
}
export async function localSnapshot(runtime) {
  const terminals = [];
  for (const binding of await runtime.store.listBindings()) {
    if (binding.mode !== "inherited" || !await bindingIsLive(binding, runtime.run)) continue;
    const value = await runtime.run("local", "hc", ["get", binding.terminal, "--json"], { env: { HC_SESSION: binding.coreSession } });
    if (value.code === 0) {
      try { terminals.push({ ...JSON.parse(value.stdout), address: binding.terminal }); } catch {}
    }
  }
  return runtime.store.view(terminals);
}
export async function notifyView(runtime) {
  await atomicJson(join(dirname(runtime.store.viewFile), "producer-changed.json"), { schema: 1, owner: OWNER, updatedAt: runtime.clock() });
}
export async function producerSnapshot(runtime) {
  const snapshot = await localSnapshot(runtime);
  for (const binding of await runtime.store.listBindings()) {
    if (binding.mode !== "paired" || !await ownerIsLive(binding, runtime.run)) continue;
    const record = await runtime.store.read(binding.session);
    if (record && !record.ended && record.bindings.some(b => b.key === bindingKey(binding) && b.generation === binding.generation)) snapshot.entries.push({ binding, record });
  }
  return snapshot;
}
async function stdin(runtime) {
  if (runtime.input !== undefined) return runtime.input;
  let text = "";
  for await (const chunk of process.stdin) { text += chunk; if (text.length > 8 * 1024 * 1024) throw new Error("Input too large"); }
  return text;
}
async function peers(runtime) {
  const config = await readJson(join(runtime.root, "peers.json"));
  return config?.owner === OWNER && Array.isArray(config.peers) ? config.peers : [];
}
export async function main(argv = process.argv.slice(2), runtime = null) {
  if (!runtime) {
    const appHome = argument(argv, "app-home"), stateRoot = argument(argv, "state-root");
    for (const path of [appHome, stateRoot]) if (path !== undefined && (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path))) throw Error("Invalid runtime path");
    runtime = createRuntime({ ...process.env, HERDR_APP_HOME: appHome ?? process.env.HERDR_APP_HOME,
      HERDR_METADATA_STATE_DIR: stateRoot ?? process.env.HERDR_METADATA_STATE_DIR });
  }
  const command = argv[0];
  let output;
  if (command === "doctor") output = { owner: OWNER, mode: await runtime.store.activationMode(), bindings: (await runtime.store.listBindings()).length,
    verification: await readJson(join(runtime.root, "verification.json")), configuredPeers: (await peers(runtime)).map(p => p.id) };
  else if (command === "auto-name" && argv.includes("--resume")) {
    const value = JSON.parse(argument(argv, "session"));
    const key = Array.isArray(value) ? Object.fromEntries(["host", "authority", "harness", "id"].map((k, i) => [k, value[i]])) : value;
    const record = await runtime.store.read(key);
    if (!record || record.ended) throw new Error("Session unavailable");
    const updated = { ...record, revision: record.revision + 1, manualOverride: false, lastManagedTitle: null, pendingRename: null, description: record.canonicalTitle };
    output = { resumed: await runtime.store.write(updated, record.revision) };
  }
  else if (command === "snapshot") output = await producerSnapshot(runtime);
  else if (command === "refresh-view") {
    const { refreshView } = await import("../src/collector.mjs");
    const view = await refreshView(runtime, await peers(runtime));
    output = { entries: view.entries.length, errors: view.errors };
  }
  else if (command === "offer") { await installOffer(JSON.parse(await stdin(runtime)), runtime); output = { offered: true }; }
  else if (command === "apply-pending") {
    const request = JSON.parse(await stdin(runtime));
    const { sessionKey } = await import("../src/contracts.mjs");
    if (sessionKey(request.session) !== argument(argv, "session") || request.generation !== argument(argv, "generation") || request.revision !== Number(argument(argv, "revision"))) throw new Error("Pending identity mismatch");
    const { applyPeerPending, mailboxRequest } = await import("../src/pending.mjs");
    let record = null;
    const binding = (await runtime.store.listBindings()).find(b => b.generation === request.generation && sessionKey(b.session) === sessionKey(request.session));
    if (binding && await ownerIsLive(binding, runtime.run)) {
      if (request.session.harness === "opencode-v2") record = await mailboxRequest(request, runtime);
      else {
        const { createClaudeSessionAccess } = await import("../claude/adapter.mjs");
        record = await applyPeerPending(request, { ...runtime, access: createClaudeSessionAccess(await import("@anthropic-ai/claude-agent-sdk"), binding.lookupDir) });
      }
    }
    output = { record };
  }
  else if (command === "pair" || command === "launch") {
    const peer = (await peers(runtime)).find(p => p.id === argument(argv, "peer"));
    if (!peer) throw new Error("Configure a trusted peer first");
    const harness = argument(argv, "harness");
    if (command === "pair") output = await createPairing({ terminal: argument(argv, "terminal"), peer, harness, sessionId: argument(argv, "session") }, runtime);
    else return launchPaired({ peer, harness, argv: argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : [] }, { ...runtime, launch: (c, args) => new Promise(resolve => {
      const child = spawn(c, args, { stdio: "inherit", env: runtime.env }); child.on("error", () => resolve(1)); child.on("exit", code => resolve(code ?? 1));
    }) });
  } else if (command === "launch-local") {
    const harness = argument(argv, "harness");
    if (!["opencode-v2", "claude"].includes(harness)) throw new Error("Unsupported harness");
    const token = argument(argv, "pair-token");
    if (!/^[a-f0-9]{48}$/.test(token ?? "")) throw new Error("Invalid launch token");
    const host = argument(argv, "host");
    if (!host) throw new Error("Explicit host required");
    const extra = argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : [];
    return new Promise(resolve => {
      const child = spawn(harness === "claude" ? "claude" : "opencode", extra, { stdio: "inherit", env: { ...runtime.env, HERDR_METADATA_HOST: host, HERDR_METADATA_PAIR_TOKEN: token } });
      child.on("error", () => resolve(1)); child.on("exit", code => resolve(code ?? 1));
    });
  } else if (command === "hook" && argv[1] === "claude") {
    const input = JSON.parse(await stdin(runtime));
    const { handleClaudeHook } = await import("../claude/adapter.mjs");
    const { applyObservation } = await import("../src/engine.mjs");
    output = await handleClaudeHook(input, { ...runtime, engine: runtime.engine ?? applyObservation, sdk: runtime.sdk ?? (() => import("@anthropic-ai/claude-agent-sdk")),
      allowPaired: Boolean(runtime.env.HERDR_METADATA_HOST),
      pair: (token, live) => acceptPairing(token, live, { ...runtime, producerPid: process.ppid }),
      validatePaired: b => ownerIsLive(b, runtime.run) });
    if ((runtime.env.HC_TERMINAL_ID || runtime.env.HERDR_METADATA_HOST) && !input.agent_id) await notifyView(runtime);
  } else if (command === "register") {
    const input = JSON.parse(await new Promise(resolve => { let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", c => s += c); process.stdin.on("end", () => resolve(s)); }));
    const binding = await verifyInheritedBinding({ env: runtime.env, producerPid: process.ppid, session: input.session, run: runtime.run });
    output = { registered: Boolean(binding && await commitBinding(binding, runtime)), binding };
  } else if (command === "invalidate") {
    await runtime.store.invalidate(argument(argv, "key"), argument(argv, "generation"));
    output = { invalidated: true };
  } else throw new Error("Unknown metadata command");
  process.stdout.write(JSON.stringify(output) + "\n");
  return 0;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const host = argument(process.argv.slice(2).slice(0, process.argv.slice(2).indexOf("--") < 0 ? undefined : process.argv.slice(2).indexOf("--")), "host");
    if (host) process.env.HERDR_METADATA_HOST = host;
    process.exitCode = await main();
  }
  catch { process.stderr.write("herdr-session-metadata: command failed\n"); process.exitCode = 1; }
}
