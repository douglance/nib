const WORKING = [
  /Working \(/,
  /Analyzing…/,
  /Worked for/,
  /esc to interrupt/,
  /Cooked for/,
  /Cooking…/
];

const PLAN_GATES = [
  { re: /Would you like to proceed\?/, reason: "plan approval gate" },
  { re: /Implement this plan\?/, reason: "plan approval gate" }
];

const SELECT_HINTS = [
  /Enter to select/,
  /Press enter to confirm or esc to go back/
];

export function classifyPane(text: string): { waiting: boolean; reason: string } {
  const lines = tail(text);
  const blob = lines.join("\n");
  if (WORKING.some((re) => re.test(blob))) return { waiting: false, reason: "working" };
  for (const gate of PLAN_GATES) {
    if (gate.re.test(blob)) return { waiting: true, reason: gate.reason };
  }
  if (SELECT_HINTS.some((re) => re.test(blob))) {
    const label = menuLabel(lines);
    return { waiting: true, reason: label ? `selection menu: ${label}` : "selection menu" };
  }
  const hasPointerChoice = lines.some((line) => /^[›❯]\s*\d+\./.test(line.trimStart()) || /^[›❯]\s+\d+\./.test(line));
  const hasQuestion = /\?\s*$/m.test(blob) || lines.some((line) => /\?$/.test(line.trimStart()));
  if (hasPointerChoice && hasQuestion) {
    const label = menuLabel(lines);
    return { waiting: true, reason: label ? `selection menu: ${label}` : "selection menu" };
  }
  return { waiting: false, reason: "idle" };
}

export function paneFingerprint(text: string): string {
  const stable = tail(text)
    .join("\n")
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, "TIME")
    .replace(/\b\d+[kKmMgG]?\s*tokens?\b/g, "TOKENS");
  return stable;
}

function tail(text: string, n = 25): string[] {
  return String(text)
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim().length > 0)
    .slice(-n);
}

function menuLabel(lines: string[]): string {
  const question = lines.find((line) => /\?$/.test(line.trim()));
  if (question) {
    const text = question.trim().replace(/^[›❯•✶✻─\s]+/, "");
    const match = text.match(/([^.?!]*)\?$/);
    if (match?.[1]?.trim()) return shorten(match[1].trim());
  }
  const option = lines.find((line) => /^\s*[›❯]?\s*1\.\s+\S/.test(line));
  if (option) {
    const text = option.replace(/^\s*[›❯]?\s*1\.\s+/, "").trim();
    if (text) return shorten(text);
  }
  return "";
}

function shorten(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}
