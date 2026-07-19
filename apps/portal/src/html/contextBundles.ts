import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type BundleKind = "plan" | "review" | "explainer" | "report";

async function run(command: string, args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, { cwd, timeout: 8000, maxBuffer: 1024 * 1024 * 4 });
    return stdout.trim();
  } catch (error) {
    return error instanceof Error ? `[unavailable: ${error.message}]` : "[unavailable]";
  }
}

export async function buildHtmlContextBundle(kind: BundleKind, cwd: string): Promise<string> {
  const root = path.resolve(cwd);
  const [status, branch, files, packageJson, diffStat, diff, tests] = await Promise.all([
    run("git", ["status", "--short"], root),
    run("git", ["branch", "--show-current"], root),
    run("rg", ["--files", "-g", "!node_modules", "-g", "!dist", "-g", "!build", "-g", "!target"], root),
    readIfExists(path.join(root, "package.json")),
    run("git", ["diff", "--stat"], root),
    kind === "review" ? run("git", ["diff", "--no-ext-diff"], root) : Promise.resolve(""),
    discoverTestHints(root)
  ]);
  return [
    `# Prtl ${titleCase(kind)} Context Bundle`,
    "",
    `Context for an existing agent/user-authored ${kind} HTML artifact. Prtl supplies the chrome, libraries, feedback bridge, screenshots, and exports; it does not generate the HTML.`,
    "",
    "## Repository",
    "",
    `- Root: ${root}`,
    `- Branch: ${branch || "(unknown)"}`,
    "",
    "## Working Tree",
    "",
    fenced(status || "(clean)"),
    "",
    "## Files",
    "",
    fenced(files.split("\n").slice(0, 240).join("\n")),
    "",
    packageJson ? ["## package.json", "", fenced(packageJson)].join("\n") : "",
    "",
    tests ? ["## Test Hints", "", fenced(tests)].join("\n") : "",
    "",
    diffStat ? ["## Diff Stat", "", fenced(diffStat)].join("\n") : "",
    "",
    diff ? ["## Diff", "", fenced(diff.slice(0, 120000))].join("\n") : "",
    "",
    "## Artifact Requirements",
    "",
    artifactRequirements(kind)
  ].filter(Boolean).join("\n");
}

async function readIfExists(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

async function discoverTestHints(cwd: string): Promise<string> {
  const packageJson = await readIfExists(path.join(cwd, "package.json"));
  if (!packageJson) return "";
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, string> };
    return Object.entries(parsed.scripts ?? {})
      .filter(([name]) => /test|typecheck|lint|build|check/i.test(name))
      .map(([name, script]) => `npm run ${name} # ${script}`)
      .join("\n");
  } catch {
    return "";
  }
}

function artifactRequirements(kind: BundleKind): string {
  if (kind === "review") {
    return "- Render the actual change surface, risk map, annotated snippets, behavioral contracts, test gaps, and paste-ready review comments.\n- Separate confirmed issues from questions.";
  }
  if (kind === "explainer") {
    return "- Include a one-screen summary, flow diagram, key files/functions, annotated snippets, gotchas, and FAQ/glossary.";
  }
  if (kind === "report") {
    return "- Include TLDR, current status, evidence, timeline, decisions, risks, and action items.";
  }
  return "- Include goal, success criteria, current state, milestones, data flow, code/API snippets, risks, tests, rollout, and open questions.";
}

function fenced(value: string): string {
  return `\`\`\`\n${value}\n\`\`\``;
}

function titleCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

export async function scanDesignSystem(cwd: string): Promise<string> {
  const root = path.resolve(cwd);
  const files = (await run("rg", ["--files", "-g", "*.css", "-g", "*.tsx", "-g", "*.ts", "-g", "*.jsx", "-g", "*.js", "-g", "!node_modules", "-g", "!dist", "-g", "!build"], root))
    .split("\n")
    .filter(Boolean)
    .slice(0, 160);
  const samples: string[] = [];
  for (const file of files.slice(0, 40)) {
    const content = await readIfExists(path.join(root, file));
    const relevant = content
      .split("\n")
      .filter((line) => /--|#[0-9a-f]{3,8}\b|rgb\(|hsl\(|className=|border-radius|font-family|gap:|padding:|Button|Card|Input/.test(line))
      .slice(0, 20)
      .join("\n");
    if (relevant) samples.push(`## ${file}\n\n${fenced(relevant)}`);
  }
  return [
    "# Design System Reference",
    "",
    "Use this as project-specific library/chrome guidance for standalone HTML artifacts. Prefer matching these conventions over generic UI.",
    "",
    `Root: ${root}`,
    "",
    "## Candidate Files",
    "",
    fenced(files.join("\n")),
    "",
    "## Extracted Signals",
    "",
    samples.join("\n\n") || "(No obvious design-system signals found.)",
    "",
    "## LLM Guidance",
    "",
    "- Reuse the observed palette, spacing, radius, and typography patterns.",
    "- Prefer existing component vocabulary and density over decorative generic layouts.",
    "- Keep standalone HTML self-contained unless the user asks to depend on the app build."
  ].join("\n");
}
