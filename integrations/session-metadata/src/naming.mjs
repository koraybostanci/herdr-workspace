export function ticketReference(value) {
  const ids = [...new Set((value ?? "").match(/\b[A-Z][A-Z0-9]*-[1-9]\d*\b/g) ?? [])];
  return { id: ids.length === 1 ? ids[0] : null, ambiguous: ids.length > 1 };
}
const prefix = /^\[?([A-Z][A-Z0-9]*-\d+)\]?(?:\s*[-:]\s*|\s*)(?:#([1-9]\d*)\s*)?/;
export function proposeTitle({ currentTitle, lastManagedTitle, manualOverride, description, context }) {
  if (manualOverride) return { action: "pause", reason: "manual-override" };
  if (/[\x00-\x1f\x7f]/.test(currentTitle ?? "") || /[\x00-\x1f\x7f]/.test(description ?? "")) return { action: "pause", reason: "control-characters" };
  const ticket = context?.ticket?.id;
  if (!ticket) return { action: "noop", reason: "no-confirmed-ticket" };
  const pr = context.prs?.[context.activePrUrl];
  const number = pr?.state === "OPEN" ? pr.number : null;
  if (lastManagedTitle && currentTitle !== lastManagedTitle) return { action: "pause", reason: "external-title-change" };
  if (!number && lastManagedTitle === currentTitle && /#\d+/.test(currentTitle)) return { action: "noop", reason: "historical-pr" };
  const old = currentTitle?.match(prefix);
  if (!lastManagedTitle && old && (old[1] !== ticket || old[2] && Number(old[2]) !== number)) return { action: "pause", reason: "conflicting-prefix" };
  let short = description || currentTitle || "";
  if (lastManagedTitle || old) short = short.replace(prefix, "");
  if (!short || /^(?:OpenCode|Claude(?: Code)?|New session|Session)$/i.test(short)) short = (pr?.title ?? "").replace(prefix, "") || context.repo.name;
  short = short.replace(/\s+/g, " ").trim();
  const lead = ticket + (number ? ` #${number}` : "");
  const budget = 120 - [...lead].length - 1;
  if (budget < 1) return { action: "pause", reason: "identifiers-too-long" };
  const title = `${lead} ${[...short].slice(0, budget).join("")}`.trim();
  return title === currentTitle ? { action: "noop", reason: "already-named" } : { action: "rename", title };
}
