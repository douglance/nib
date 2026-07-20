import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packsRoot = path.join(here, "packs");

export type PackType = "skills" | "libraries";

export interface GuidancePack {
  name: string;
  path: string;
  summary: string;
}

export async function listPacks(type: PackType): Promise<GuidancePack[]> {
  const dir = path.join(packsRoot, type);
  const files = (await fs.readdir(dir)).filter((file) => file.endsWith(".md")).sort();
  return Promise.all(
    files.map(async (file) => {
      const packPath = path.join(dir, file);
      const text = await fs.readFile(packPath, "utf8");
      return {
        name: path.basename(file, ".md"),
        path: packPath,
        summary: text
          .split("\n")
          .find((line) => line.trim() && !line.startsWith("#"))
          ?.trim() ?? ""
      };
    })
  );
}

export async function readPack(type: PackType, name: string): Promise<string> {
  return fs.readFile(path.join(packsRoot, type, `${name}.md`), "utf8");
}

export async function readBrief(kind: string): Promise<string> {
  const common = await readPack("skills", "html-artifact");
  let specific = "";
  try {
    specific = await readPack("skills", kind);
  } catch {
    specific = `# ${kind}\n\nNo dedicated artifact pack exists. Use the general HTML artifact rules.`;
  }
  return `${common}\n\n---\n\n${specific}`;
}

export async function readLibraryContext(libraries: string): Promise<{ libraries: string[]; context: string }> {
  const names = libraries
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const parts = await Promise.all(names.map((name) => readPack("libraries", name)));
  return { libraries: names, context: parts.join("\n\n---\n\n") };
}
