import fs from "node:fs/promises";
import path from "node:path";
import type { HtmlSemanticDiff, HtmlSemanticSummary } from "../shared/types";

function stripTags(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function attr(tag: string, name: string): string | null {
  return tag.match(new RegExp(`\\s${name}=["']([^"']*)["']`, "i"))?.[1] ?? null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export async function summarizeHtmlFile(file: string): Promise<HtmlSemanticSummary> {
  const resolved = path.resolve(file);
  const html = await fs.readFile(resolved, "utf8");
  return summarizeHtml(html, Buffer.byteLength(html, "utf8"));
}

export function summarizeHtml(html: string, bytes = Buffer.byteLength(html, "utf8")): HtmlSemanticSummary {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? null;
  const headings = [...html.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)]
    .map((match) => decodeEntities(stripTags(match[1] ?? "")).slice(0, 160));
  const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((match) => ({
    text: decodeEntities(stripTags(match[2] ?? "")).slice(0, 160),
    href: attr(match[1] ?? "", "href")
  }));
  const buttons = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)]
    .map((match) => decodeEntities(stripTags(match[1] ?? "")).slice(0, 160));
  const inputs = [...html.matchAll(/<(input|textarea|select)\b([^>]*)>/gi)].map((match) => ({
    tag: (match[1] ?? "").toLowerCase(),
    type: attr(match[2] ?? "", "type"),
    name: attr(match[2] ?? "", "name"),
    placeholder: attr(match[2] ?? "", "placeholder")
  }));
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map((match) => {
    const src = attr(match[1] ?? "", "src");
    return { src, inline: !src };
  });
  const linkedStyles = [...html.matchAll(/<link\b([^>]*)>/gi)]
    .filter((match) => /rel=["']stylesheet["']/i.test(match[1] ?? ""))
    .map((match) => ({ href: attr(match[1] ?? "", "href"), inline: false }));
  const inlineStyles = [...html.matchAll(/<style\b[^>]*>/gi)].map(() => ({ href: null, inline: true }));
  const ids = unique([...html.matchAll(/\sid=["']([^"']+)["']/gi)].map((match) => match[1] ?? ""));
  return {
    title: title ? decodeEntities(stripTags(title)) : null,
    headings,
    links,
    buttons,
    inputs,
    scripts,
    styles: [...linkedStyles, ...inlineStyles],
    ids,
    stats: {
      bytes,
      headings: headings.length,
      links: links.length,
      buttons: buttons.length,
      inputs: inputs.length,
      scripts: scripts.length,
      styles: linkedStyles.length + inlineStyles.length,
      ids: ids.length
    }
  };
}

export async function diffHtmlFiles(beforeFile: string, afterFile: string): Promise<HtmlSemanticDiff> {
  const [before, after] = await Promise.all([summarizeHtmlFile(beforeFile), summarizeHtmlFile(afterFile)]);
  return diffHtmlSummaries(before, after);
}

export function diffHtmlSummaries(before: HtmlSemanticSummary, after: HtmlSemanticSummary): HtmlSemanticDiff {
  const changes: string[] = [];
  if (before.title !== after.title) changes.push(`title: ${before.title ?? "(none)"} -> ${after.title ?? "(none)"}`);
  addListChanges("headings", before.headings, after.headings, changes);
  addListChanges("buttons", before.buttons, after.buttons, changes);
  addListChanges("links", before.links.map((link) => `${link.text} <${link.href ?? ""}>`), after.links.map((link) => `${link.text} <${link.href ?? ""}>`), changes);
  addCountChange("inputs", before.stats.inputs, after.stats.inputs, changes);
  addCountChange("scripts", before.stats.scripts, after.stats.scripts, changes);
  addCountChange("styles", before.stats.styles, after.stats.styles, changes);
  addListChanges("ids", before.ids, after.ids, changes);
  return { before, after, changes };
}

function addCountChange(label: string, before: number, after: number, changes: string[]): void {
  if (before !== after) changes.push(`${label}: ${before} -> ${after}`);
}

function addListChanges(label: string, before: string[], after: string[], changes: string[]): void {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((item) => !beforeSet.has(item));
  const removed = before.filter((item) => !afterSet.has(item));
  if (added.length) changes.push(`${label} added: ${added.slice(0, 8).join("; ")}`);
  if (removed.length) changes.push(`${label} removed: ${removed.slice(0, 8).join("; ")}`);
}

export function normalizeHtmlText(html: string): string {
  return html
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()
    .concat("\n");
}

export async function checkNormalizedHtml(file: string): Promise<{ file: string; changed: boolean; normalized: string }> {
  const resolved = path.resolve(file);
  const html = await fs.readFile(resolved, "utf8");
  const normalized = normalizeHtmlText(html);
  return { file: resolved, changed: html !== normalized, normalized };
}
