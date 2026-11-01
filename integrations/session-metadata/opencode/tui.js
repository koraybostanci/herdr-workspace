import { Plugin } from "@opencode/plugin/tui";
import { createEffect } from "solid-js";
import { watch } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRuntime, notifyView } from "../bin/herdr-session-meta.mjs";
import { verifyInheritedBinding, commitBinding, bindingIsLive } from "../src/contracts.mjs";
import { applyObservation } from "../src/engine.mjs";
import { createOpenCodeAdapter, executionScope } from "./adapter.mjs";
import { acceptPairing, ownerIsLive } from "../src/transport.mjs";
import { watchMailbox } from "../src/pending.mjs";

export default Plugin.define({
  id: "herdr.session-metadata",
  async setup(context) {
    if (!process.env.HC_TERMINAL_ID && !process.env.HERDR_METADATA_HOST) return () => {};
    const scope = executionScope(process.argv, context.options ?? {});
    if (!scope) return () => {};
    if (scope.host === "local" && process.env.HERDR_METADATA_HOST) scope.host = process.env.HERDR_METADATA_HOST;
    const runtime = createRuntime({ ...process.env, HERDR_APP_HOME: context.options?.appHome ?? process.env.HERDR_APP_HOME,
      HERDR_METADATA_STATE_DIR: context.options?.stateRoot ?? process.env.HERDR_METADATA_STATE_DIR });
    let paired = null;
    const identity = {
      enabled: true,
      verify: async session => {
        if (process.env.HC_TERMINAL_ID) return verifyInheritedBinding({ env: process.env, producerPid: process.pid, session, run: runtime.run });
        if (paired && await ownerIsLive(paired, runtime.run)) return { ...paired, session, previousGeneration: paired.generation, generation: randomUUID() };
        return null;
      },
      commit: async binding => {
        if (binding.mode === "inherited") return commitBinding(binding, runtime);
        const old = await runtime.store.getBinding(JSON.stringify([binding.coreHost, binding.coreSession, binding.terminal, binding.createdMs]));
        const ok = await runtime.store.bind(binding, old?.generation ?? null);
        if (ok) paired = binding;
        return ok;
      },
      validate: binding => binding.mode === "paired" ? ownerIsLive(binding, runtime.run) : bindingIsLive(binding, runtime.run),
      release: async binding => {
        const term = binding.mode === "inherited" ? await runtime.run("local", "hc", ["get", binding.terminal, "--json"], { env: { HC_SESSION: binding.coreSession } }) : { code: 1 };
        if (term.code === 0) {
          let proof;
          try { proof = JSON.parse(JSON.parse(term.stdout).labels?.["herdr.meta-binding"] ?? "null"); } catch {}
          if (proof?.generation === binding.generation) await runtime.run("local", "hc", ["label", binding.terminal, "herdr.meta-binding="], { env: { HC_SESSION: binding.coreSession } });
        }
        await runtime.store.releaseSessionBinding(binding);
      },
    };
    const adapter = createOpenCodeAdapter(context, { ...runtime, scope, identity, engine: applyObservation,
      pair: async (token, live) => {
        paired = await acceptPairing(token, live, { ...runtime, producerPid: process.pid });
        return paired;
      },
      publish: async () => notifyView(runtime) });
    context.keymap.layer(() => ({ mode: "global", commands: [{ id: "herdr.pair", title: "Pair this Herdr session", slash: { name: "herdr-pair", arguments: true },
      run: async input => {
        try { await adapter.pair(input ?? ""); await adapter.refresh(); context.ui.toast.show({ message: "Pairing accepted; waiting for the core host.", variant: "success" }); }
        catch { context.ui.toast.show({ message: "Pairing failed. Check the host, session and token expiry.", variant: "error" }); }
      } }] }));
    let lastFingerprint = "";
    const request = () => {
      const route = context.ui.router.current();
      const id = route?.type === "session" ? route.sessionID : null;
      const info = id && context.data.session.get(id);
      const messages = id ? context.data.session.message.list(id) ?? [] : [];
      const fingerprint = JSON.stringify([id, info?.title, messages.slice(-8).map(m => [m.id, m.type,
        m.content?.filter(p => p.type === "tool" && p.state?.status === "completed").map(p => p.id)])]);
      if (fingerprint === lastFingerprint) return;
      lastFingerprint = fingerprint;
      void adapter.refresh().catch(() => { lastFingerprint = ""; });
    };
    const stopEvents = context.data.listen(request);
    const stopSlot = context.ui.slot({ append: "app", render: () => { createEffect(request); return null; } });
    if (process.env.HERDR_METADATA_PAIR_TOKEN) {
      try { await adapter.pair(process.env.HERDR_METADATA_PAIR_TOKEN); } catch {}
    }
    await adapter.refresh();
    const reconcile = setInterval(() => { void adapter.refresh().catch(() => {}); }, 60000);
    const stopMailbox = await watchMailbox(runtime, request => adapter.applyPending(request));
    const watcher = watch(runtime.root, (_kind, filename) => {
      if (filename === "activation.json") void adapter.refresh().catch(() => {});
    });
    return async () => { clearInterval(reconcile); watcher.close(); stopMailbox(); stopEvents(); stopSlot(); await adapter.dispose(); };
  },
});
