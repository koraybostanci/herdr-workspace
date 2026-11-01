function promptShell(terminal) {
  if (terminal?.state !== "live" || !Number.isSafeInteger(terminal.created_ms) || terminal.created_ms <= 0
    || !Number.isSafeInteger(terminal.pid) || terminal.pid <= 0 || terminal.foreground?.pid !== terminal.pid) return null;
  const argv = terminal.foreground.argv;
  if (!Array.isArray(argv) || typeof argv[0] !== "string") return null;
  const executable = argv[0].split(/[\\/]/).pop().replace(/^-/, "");
  if (!["sh", "bash", "zsh", "fish", "dash", "ash", "ksh", "tcsh", "csh", "nu"].includes(executable)) return null;
  return argv.slice(1).every(arg => typeof arg === "string" && /^(?:-[ilf]+|--(?:login|interactive|noprofile|norc))$/.test(arg)) ? executable : null;
}

function processPresence(stdout, terminal, shell) {
  const processes = new Map();
  for (const line of stdout.trim().split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match || processes.has(Number(match[1]))) return "unknown";
    processes.set(Number(match[1]), { parent: Number(match[2]), status: match[3], command: match[4] });
  }
  const root = processes.get(terminal.pid);
  if (!root || root.status.includes("Z") || root.command.split(/[\\/]/).pop().replace(/^-/, "") !== shell) return "unknown";
  const descendants = new Set([terminal.pid]);
  for (;;) {
    let changed = false;
    for (const [pid, process] of processes) {
      if (descendants.has(pid) || !descendants.has(process.parent)) continue;
      if (!process.status.includes("Z")) return "open";
      descendants.add(pid); changed = true;
    }
    if (!changed) return "closed";
  }
}

export class AgentPresence {
  constructor() { this.entries = new Map(); }
  key(card, terminal) {
    return JSON.stringify([card.machine ?? null, card.address, terminal?.created_ms, terminal?.pid, terminal?.foreground,
      card.seq, card.title, card.status, terminal?.status_ms, terminal?.labels?.["herdr.meta-binding"]]);
  }
  peek(card, terminal) { return promptShell(terminal) ? this.entries.get(this.key(card, terminal))?.value ?? "unknown" : "unknown"; }
  needs(card, terminal, now = Date.now()) {
    if (!promptShell(terminal)) return false;
    const entry = this.entries.get(this.key(card, terminal));
    return !entry || !entry.pending && now >= entry.expires;
  }
  async refresh(card, terminal, execute, now = Date.now()) {
    const shell = promptShell(terminal);
    if (!shell) return "unknown";
    const key = this.key(card, terminal), previous = this.entries.get(key);
    if (previous?.pending) return previous.pending;
    if (previous && now < previous.expires) return previous.value;
    const entry = { value: previous?.value ?? "unknown", pending: null, expires: now + 15000 };
    this.entries.set(key, entry);
    entry.pending = (async () => {
      try {
        const result = await execute("ps", ["-axo", "pid=,ppid=,stat=,comm="], { on: card.machine ?? null });
        return entry.value = result.code === 0 ? processPresence(result.stdout, terminal, shell) : "unknown";
      } catch { return entry.value = "unknown"; }
    })();
    try { return await entry.pending; } finally { entry.pending = null; }
  }
}
