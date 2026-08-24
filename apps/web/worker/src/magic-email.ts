import { EmailMessage } from "cloudflare:email";

const SENDER = "login@nibtool.com";

export async function sendMagicLinkEmail(binding: SendEmail, email: string, link: string, code: string): Promise<void> {
  await binding.send(new EmailMessage(SENDER, email, magicEmail(email, link, code)));
}

function magicEmail(email: string, link: string, code: string): string {
  const boundary = `nib-${crypto.randomUUID()}`;
  const textBody = `Sign in to Nib\n\nEnter this code in Nib:\n\n${code}\n\nOr open this secure link:\n${link}\n\nThe code and link expire in 10 minutes and work once. If you did not request this, ignore this email.`;
  const htmlBody = `<h1>Sign in to Nib</h1><p>Enter this code in Nib for ${escapeHtml(email)}:</p><p style="font:700 32px ui-monospace,monospace;letter-spacing:.18em">${escapeHtml(code)}</p><p>Or <a href="${escapeHtml(link)}">open the secure sign-in link</a>.</p><p>The code and link expire in 10 minutes and work once. If you did not request this, ignore this email.</p>`;
  return [
    `From: Nib <${SENDER}>`, `To: ${email}`, "Subject: Sign in to Nib",
    "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "", textBody, "",
    `--${boundary}`, "Content-Type: text/html; charset=utf-8", "", htmlBody, "",
    `--${boundary}--`, "",
  ].join("\r\n");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character] ?? character);
}
