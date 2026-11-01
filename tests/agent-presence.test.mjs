import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { AgentPresence } from "../mods/space-agents/agent-presence.js";

const card = { address: "t1", machine: null, seq: 1, title: "Session", status: "idle" };
const terminal = { address: "t1", state: "live", created_ms: 100, pid: 10,
  foreground: { pid: 10, name: "zsh", argv: ["/bin/zsh", "-l"] } };
const snapshot = stdout => async () => ({ code: 0, stdout, stderr: "" });

test("a live descendant preserves the agent even when shells and agents share a foreground group", async () => {
  for (const stdout of ["10 1 Ss /bin/zsh\n20 10 S opencode\n", "30 20 S node\n20 10 Z opencode\n10 1 Ss /bin/zsh\n"]) {
    const presence = new AgentPresence();
    assert.equal(await presence.refresh(card, terminal, snapshot(stdout)), "open");
    assert.equal(presence.peek(card, terminal), "open");
  }
});

test("an empty shell or only zombie descendants confirm the old agent is closed", async () => {
  for (const stdout of ["10 1 Ss /bin/zsh\n", "10 1 Ss /bin/zsh\n20 10 Z opencode\n"]) {
    const presence = new AgentPresence();
    assert.equal(await presence.refresh(card, terminal, snapshot(stdout)), "closed");
  }
});

test("non-prompt wrappers and incomplete process identity never authorize closure", () => {
  const presence = new AgentPresence();
  for (const extra of [{ created_ms: 0 }, { state: "finished" }, { pid: null }, { foreground: null },
    { foreground: { pid: 10, name: "zsh" } }, { foreground: { pid: 20, argv: ["/bin/zsh"] } },
    { foreground: { pid: 10, argv: ["/bin/bash", "-c", "opencode; cleanup"] } },
    { foreground: { pid: 10, argv: ["/bin/sh", "/scripts/agent.sh"] } }]) {
    assert.equal(presence.needs(card, { ...terminal, ...extra }), false);
    assert.equal(presence.peek(card, { ...terminal, ...extra }), "unknown");
  }
});

test("process probes run on the terminal's machine and failures stay unknown", async () => {
  const presence = new AgentPresence(), remote = { ...card, machine: "devbox" };
  assert.equal(await presence.refresh(remote, terminal, async (command, args, options) => {
    assert.equal(command, "ps");
    assert.deepEqual(args, ["-axo", "pid=,ppid=,stat=,comm="]);
    assert.deepEqual(options, { on: "devbox" });
    return { code: 1, stdout: "", stderr: "offline" };
  }), "unknown");
  assert.equal(await presence.refresh(card, terminal, async () => { throw Error("offline"); }), "unknown");
});

test("cache reuse is bounded and an unsuccessful refresh cannot retain an old closure result", async () => {
  const presence = new AgentPresence(); let calls = 0;
  const execute = async () => { calls++; return { code: 0, stdout: "10 1 Ss /bin/zsh\n", stderr: "" }; };
  await presence.refresh(card, terminal, execute, 0);
  assert.equal(presence.needs(card, terminal, 14999), false);
  await presence.refresh(card, terminal, execute, 14999);
  assert.equal(calls, 1);
  assert.equal(presence.needs(card, terminal, 15000), true);
  await presence.refresh(card, terminal, async () => ({ code: 1, stdout: "", stderr: "offline" }), 15000);
  assert.equal(presence.peek(card, terminal), "unknown");
});

test("late closure results cannot hide a new report, binding, terminal incarnation or foreground process", async () => {
  const presence = new AgentPresence(); let finish;
  const pending = presence.refresh(card, terminal, () => new Promise(resolve => { finish = resolve; }));
  finish({ code: 0, stdout: "10 1 Ss /bin/zsh\n", stderr: "" }); await pending;
  for (const [nextCard, nextTerminal] of [[{ ...card, seq: 2 }, terminal], [card, { ...terminal, created_ms: 101 }],
    [card, { ...terminal, labels: { "herdr.meta-binding": "new-generation" } }],
    [card, { ...terminal, foreground: { pid: 20, argv: ["opencode"] } }]]) {
    assert.equal(presence.peek(nextCard, nextTerminal), "unknown");
  }
});

test("real shell-child exit changes process evidence without relying on foreground group changes", { skip: process.platform === "win32", timeout: 10000 }, async t => {
  const shell = spawn("/bin/sh", [], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: shell.stdout }), output = lines[Symbol.asyncIterator]();
  let child;
  t.after(() => {
    if (child) try { process.kill(child, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    lines.close(); shell.stdin.end(); if (shell.exitCode === null) shell.kill();
  });
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  shell.stdin.write(`${quote(process.execPath)} -e ${quote('console.log(process.pid); process.stdin.resume();')}; echo returned\n`);
  child = Number((await output.next()).value);
  assert.ok(child > 0);
  const live = { ...terminal, pid: shell.pid, foreground: { pid: shell.pid, argv: ["/bin/sh"] } };
  const presence = new AgentPresence(), run = promisify(execFile);
  const execute = async (command, args) => ({ code: 0, ...await run(command, args) });
  assert.equal(await presence.refresh(card, live, execute, 0), "open");
  process.kill(child, "SIGTERM"); child = null;
  assert.equal((await output.next()).value, "returned");
  assert.equal(await presence.refresh(card, live, execute, 15000), "closed");
});
