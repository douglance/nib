import fs from "node:fs/promises";
import path from "node:path";
import type { HtmlValidationIssue, HtmlValidationResult } from "../shared/types";

function count(re: RegExp, text: string): number {
  return [...text.matchAll(re)].length;
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

export async function validateHtml(file: string): Promise<HtmlValidationResult> {
  const resolved = path.resolve(file);
  const html = await fs.readFile(resolved, "utf8");
  const info = await fs.stat(resolved);
  return validateHtmlContent(html, resolved, info.size);
}

export async function validateFeedbackSurface(file: string): Promise<HtmlValidationResult> {
  const resolved = path.resolve(file);
  const html = await fs.readFile(resolved, "utf8");
  const info = await fs.stat(resolved);
  return validateFeedbackSurfaceHtml(html, resolved, info.size);
}

export function validateFeedbackSurfaceHtml(html: string, file = "inline-feedback-surface.html", bytes = Buffer.byteLength(html, "utf8")): HtmlValidationResult {
  const result = validateHtmlContent(html, file, bytes);
  const issues = result.issues.filter((issue) => issue.code !== "missing_export_path");

  const usesFeedbackSubmit = /prtl\.feedback\.submit/.test(html);
  const usesRawBridge = /postMessage\s*\(/.test(html);

  if (!usesFeedbackSubmit) {
    issues.push({
      code: "missing_prtl_feedback_submit",
      severity: "error",
      message: "Feedback surfaces must call window.prtl.feedback.submit(...) or post a prtl.feedback.submit message to the parent chrome."
    });
  }
  if (!usesRawBridge && !/window\.prtl\.feedback/.test(html)) {
    issues.push({
      code: "missing_prtl_bridge",
      severity: "error",
      message: "Feedback surfaces must use the injected window.prtl.feedback helper or raw window.parent.postMessage."
    });
  }
  if (/<form\b/i.test(html) && !/<button\b[^>]*type=["']submit["']/i.test(html)) {
    issues.push({
      code: "form_without_submit",
      severity: "warning",
      message: "Forms should include an explicit submit button so the feedback action is obvious."
    });
  }

  return { ...result, valid: !issues.some((issue) => issue.severity === "error"), issues };
}

function validateHtmlContent(html: string, file: string, bytes: number): HtmlValidationResult {
  const issues: HtmlValidationIssue[] = [];

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const titleText = title ? stripTags(title) : null;
  const ids = new Set([...html.matchAll(/\sid=["']([^"']+)["']/gi)].map((match) => match[1]));
  const hrefAnchors = [...html.matchAll(/href=["']#([^"']+)["']/gi)].map((match) => match[1]);
  const externalScripts = count(/<script\b[^>]*\bsrc=["']https?:\/\//gi, html);
  const externalStyles = count(/<link\b[^>]*\bhref=["']https?:\/\//gi, html);

  if (!/<!doctype html>/i.test(html)) {
    issues.push({ code: "missing_doctype", severity: "warning", message: "Add <!doctype html> for predictable browser rendering." });
  }
  if (!titleText) {
    issues.push({ code: "missing_title", severity: "error", message: "Add a non-empty <title>." });
  }
  if (!/<meta\b[^>]*name=["']viewport["']/i.test(html)) {
    issues.push({ code: "missing_viewport", severity: "warning", message: "Add a responsive viewport meta tag." });
  }
  if (!/<main\b/i.test(html) && !/role=["']main["']/i.test(html)) {
    issues.push({ code: "missing_main", severity: "warning", message: "Add <main> or role=\"main\" for document structure." });
  }
  if (externalScripts > 0) {
    issues.push({ code: "external_script", severity: "warning", message: "External scripts make portable artifact review less reliable." });
  }
  if (externalStyles > 0) {
    issues.push({ code: "external_style", severity: "warning", message: "External styles make the artifact less self-contained." });
  }
  for (const anchor of hrefAnchors.filter((id) => !ids.has(id))) {
    issues.push({ code: "broken_anchor", severity: "error", message: `Internal link points to missing id "#${anchor}".` });
  }
  if (/<(?:input|textarea|select|button)\b/i.test(html) && !/\b(copy|export|download|clipboard)\b/i.test(html)) {
    issues.push({ code: "missing_export_path", severity: "warning", message: "Interactive artifacts should include copy/export when they are not purely for prtl feedback." });
  }

  return {
    file,
    valid: !issues.some((issue) => issue.severity === "error"),
    stats: {
      bytes,
      title: titleText,
      headings: count(/<h[1-6]\b/gi, html),
      buttons: count(/<button\b/gi, html),
      forms: count(/<(?:form|input|textarea|select)\b/gi, html),
      scripts: count(/<script\b/gi, html),
      externalScripts,
      externalStyles,
      internalAnchors: hrefAnchors.length
    },
    issues
  };
}
