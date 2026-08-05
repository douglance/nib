import type { GenerationRequest } from "./types";

export const MAX_PROMPT_CHARS = 4_000;
export const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
export const MAX_REFERENCE_TOTAL_BYTES = 20 * 1024 * 1024;

export function validateGenerationRequest(input: GenerationRequest): string | undefined {
  if (!input || typeof input !== "object") return "request body is required";
  if (!input.prompt?.trim()) return "prompt is required";
  if (input.prompt.length > MAX_PROMPT_CHARS) return `prompt must be at most ${MAX_PROMPT_CHARS} characters`;
  if (!Array.isArray(input.references)) return "references must be an array";
  if (input.references.length > 3) return "at most three references are allowed";
  let referenceBytes = 0;
  for (const reference of input.references) {
    if (!reference || typeof reference !== "object") return "invalid reference";
    if (!["image/png", "image/jpeg", "image/webp"].includes(reference.mime_type)) return "invalid reference MIME type";
    if (typeof reference.data !== "string" || reference.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(reference.data)) {
      return "reference data must be base64";
    }
    const bytes = Math.floor((reference.data.length * 3) / 4) - (reference.data.endsWith("==") ? 2 : reference.data.endsWith("=") ? 1 : 0);
    if (bytes > MAX_REFERENCE_BYTES) return "each reference must be at most 10 MiB";
    referenceBytes += bytes;
  }
  if (referenceBytes > MAX_REFERENCE_TOTAL_BYTES) return "references must total at most 20 MiB";
  if (!["fast", "standard", "pro"].includes(input.quality)) return "invalid quality";
  if (!["1K", "2K", "4K"].includes(input.resolution)) return "invalid resolution";
  if (!["png", "jpg"].includes(input.format)) return "invalid format";
  if (typeof input.background !== "boolean") return "background must be a boolean";
  if (input.quality === "fast" && input.resolution !== "1K") return "fast quality only supports 1K";
  if (!["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"].includes(input.aspect)) return "invalid aspect";
  return undefined;
}
