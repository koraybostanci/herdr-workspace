import { bindingKey, sessionKey, verifyInheritedBinding, commitBinding, bindingIsLive } from "../src/contracts.mjs";
import { observedDirectory } from "../src/work-context.mjs";

export function createClaudeSessionAccess(sdk, lookupDir, liveTitle) {
  let wrote = false;
  const options = lookupDir ? { dir: lookupDir } : {};
  return {
    async get(key) {
      const info = await sdk.getSessionInfo(key.id, options);
      // Startup hooks can precede transcript persistence. The bound hook's
      // documented custom title is canonical, but never substitutes for SDK readback.
      if (!info && !wrote && typeof liveTitle === "string") return { key, title: liveTitle, parentId: null, lookupDir };
      if (info?.sessionId !== key.id) throw new Error("Claude session identity unavailable");
      return { key, title: !wrote && typeof liveTitle === "string" ? liveTitle : info.customTitle ?? info.summary ?? "",
        parentId: null, lookupDir };
    },
    async rename(key, title) { await sdk.renameSession(key.id, title, options); wrote = true; },
  };
}

const events = new Set(["SessionStart", "UserPromptSubmit", "PostToolUse", "CwdChanged", "Stop", "SessionEnd"]);
export async function handleClaudeHook(input, deps) {
  if (!input || input.agent_id || !events.has(input.hook_event_name) || typeof input.session_id !== "string") return {};
  const pairingPrompt = input.hook_event_name === "UserPromptSubmit" && /^herdr-pair(?:\s|$)/.test(input.prompt ?? "");
  const startupToken = input.hook_event_name === "SessionStart" && deps.env.HERDR_METADATA_PAIR_TOKEN;
  if (pairingPrompt || startupToken) {
    try {
      const token = startupToken || input.prompt.match(/^herdr-pair ([a-f0-9]{48})$/)?.[1];
      if (!token || !deps.pair) throw new Error("Invalid pairing command");
      const key = { host: deps.env.HERDR_METADATA_HOST ?? "local", authority: "claude", harness: "claude", id: input.session_id };
      const sdk = typeof deps.sdk === "function" ? await deps.sdk() : deps.sdk;
      await deps.pair(token, await createClaudeSessionAccess(sdk, input.cwd).get(key));
      if (pairingPrompt) return { decision: "block", reason: "Pairing accepted; the core host must acknowledge the binding." };
    } catch {
      if (pairingPrompt) return { decision: "block", reason: "Pairing failed. Check the host, exact session and 60-second token expiry." };
      return {};
    }
  }
  const inherited = Boolean(deps.env.HC_TERMINAL_ID);
  if (!inherited && !deps.allowPaired) return {};
  const key = { host: deps.env.HERDR_METADATA_HOST ?? "local", authority: "claude", harness: "claude", id: input.session_id };
  const producerPid = deps.producerPid ?? process.ppid;
  const bindings = await deps.store.listBindings();
  const terminalOwner = inherited && bindings.find(b => b.terminal === deps.env.HC_TERMINAL_ID
    && b.coreSession === (deps.env.HC_SESSION ?? "default") && b.processPid === producerPid);
  if (terminalOwner && sessionKey(terminalOwner.session) !== sessionKey(key) && input.hook_event_name !== "SessionStart") return {};
  let binding = bindings.find(b => sessionKey(b.session) === sessionKey(key) && (inherited
    ? b.terminal === deps.env.HC_TERMINAL_ID && b.coreSession === (deps.env.HC_SESSION ?? "default") && b.processPid === producerPid
    : b.mode === "paired"));
  if (input.hook_event_name === "SessionEnd") {
    if (binding) {
      const old = await deps.store.read(key);
      if (old) await deps.store.write({ ...old, ended: true, pendingRename: null, revision: old.revision + 1 }, old.revision);
      await deps.store.invalidate(bindingKey(binding), binding.generation);
    }
    return {};
  }
  if (!binding || input.hook_event_name === "SessionStart") {
    if (!inherited) return {};
    binding = await verifyInheritedBinding({ env: deps.env, producerPid, session: key, run: deps.run });
    if (!binding) return {};
    binding.lookupDir = input.cwd ?? null;
    if (!await commitBinding(binding, deps)) return {};
    const previous = await deps.store.read(key);
    if (previous?.ended) await deps.store.write({ ...previous, ended: false, pendingRename: null, revision: previous.revision + 1 }, previous.revision);
  }
  if (binding.mode === "inherited" && !await bindingIsLive(binding, deps.run)) return {};
  const sdk = typeof deps.sdk === "function" ? await deps.sdk() : deps.sdk;
  const access = createClaudeSessionAccess(sdk, binding.lookupDir, input.session_title);
  let current;
  try { current = await access.get(key); } catch { return {}; } // A brand-new startup may precede transcript persistence.
  const hook = input.hook_event_name;
  const kind = hook === "UserPromptSubmit" ? "task" : hook === "PostToolUse" ? "tool" : hook === "CwdChanged" ? "location" : "title";
  const tool = input.tool_input ?? {};
  const response = input.tool_response ?? {};
  const output = typeof response === "string" ? response : response.stdout ?? JSON.stringify(response);
  const payload = kind === "tool" ? { ...tool, tool: input.tool_name, cwd: observedDirectory(tool) ?? input.cwd, output,
    failed: Boolean(response.interrupted || response.is_error || response.exit_code && response.exit_code !== 0) }
    : { prompt: input.prompt, cwd: input.new_cwd ?? input.cwd };
  const now = deps.clock();
  const observed = { session: key, generation: binding.generation, parentId: null, kind,
    eventId: `${binding.generation}:${hook}:${input.tool_use_id ?? input.prompt_id ?? now}`, observedAt: now, payload };
  const engineDeps = { store: deps.store, access, run: deps.run, clock: deps.clock,
    activationMode: () => deps.store.activationMode(),
    validateBinding: b => b.mode === "inherited" ? bindingIsLive(b, deps.run) : deps.validatePaired?.(b) ?? Promise.resolve(false),
    hasAuthority: async b => b.mode === "inherited" };
  const result = await deps.engine(observed, binding, engineDeps);
  const record = result.record ?? await deps.store.read(key);
  const titleHook = hook === "UserPromptSubmit" || hook === "SessionStart" && ["startup", "resume", "fork"].includes(input.source);
  const latestBinding = titleHook && await deps.store.getBinding(bindingKey(binding));
  if (titleHook && result.state !== "ignored" && latestBinding?.generation === binding.generation
    && sessionKey(latestBinding.session) === sessionKey(key)
    && await deps.store.activationMode() === "active" && record?.canonicalTitle && record.lastManagedTitle === record.canonicalTitle && !record.manualOverride
    && (await deps.store.read(key))?.revision === record.revision) {
    return { hookSpecificOutput: { hookEventName: hook, sessionTitle: record.canonicalTitle } };
  }
  return {};
}
