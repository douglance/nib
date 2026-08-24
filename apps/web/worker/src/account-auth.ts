import type { Env } from "./types";

const ORIGIN = "https://nibtool.com";
const COOKIE = "nib_session";
const CHALLENGE_SECONDS = 10 * 60;

interface ChallengeRow {
  id: string;
  email: string;
  token_hash: string;
  code_hash: string | null;
  failed_code_attempts: number;
  pkce_challenge: string;
  platform: string;
  device_name: string;
  expires_at: number;
  verified_at: number | null;
  consumed_at: number | null;
}

export interface NibAccount {
  id: string;
  email: string;
  sessionId: string;
  sessionName: string;
  platform: string;
}

export function accountOrigin(): string {
  return ORIGIN;
}

export function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return undefined;
  return email;
}

export function normalizeSignInCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim().replace(/[\s-]/g, "");
  return /^\d{6}$/.test(code) ? code : undefined;
}

export function generateSignInCode(): string {
  const values = new Uint32Array(1);
  const range = 1_000_000;
  const limit = Math.floor(0x1_0000_0000 / range) * range;
  do crypto.getRandomValues(values); while (values[0]! >= limit);
  return String(values[0]! % range).padStart(6, "0");
}

export async function signInCodeHash(challengeId: string, code: string): Promise<string> {
  return sha256(`${challengeId}:${code}`);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

export function cookieToken(cookie: string | null): string | undefined {
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function sessionToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  return bearer || cookieToken(request.headers.get("cookie"));
}

export async function verifiedAccount(request: Request, env: Env): Promise<NibAccount | undefined> {
  const token = sessionToken(request);
  if (!token) return undefined;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT a.account_id, a.email, s.id AS session_id, s.name, s.platform, s.last_used_at
       FROM auth_sessions s JOIN accounts a ON a.account_id = s.account_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL`,
  ).bind(tokenHash).first<{
    account_id: string;
    email: string;
    session_id: string;
    name: string;
    platform: string;
    last_used_at: number;
  }>();
  if (!row) return undefined;
  const now = unixTime();
  if (now - row.last_used_at >= 3600) {
    await env.DB.prepare("UPDATE auth_sessions SET last_used_at = ? WHERE id = ?")
      .bind(now, row.session_id).run();
  }
  return {
    id: row.account_id,
    email: row.email,
    sessionId: row.session_id,
    sessionName: row.name,
    platform: row.platform,
  };
}

export async function handleAccountAuth(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/auth/sign-in" && request.method === "GET") return html(signInPage());
  if (url.pathname === "/auth/verify" && request.method === "GET") return html(verificationPage(url));
  if (url.pathname === "/api/auth/challenges" && request.method === "POST") return createChallenge(request, env);

  const challenge = url.pathname.match(/^\/api\/auth\/challenges\/([^/]+)\/(verify|token)$/);
  if (challenge && request.method === "POST") {
    const challengeId = challenge[1];
    const action = challenge[2];
    if (!challengeId || !action) return json({ error: "not_found" }, 404);
    return action === "verify"
      ? verifyChallenge(request, env, challengeId)
      : exchangeChallenge(request, env, challengeId);
  }
  if (url.pathname === "/api/auth/session" && request.method === "GET") {
    const account = await verifiedAccount(request, env);
    return account
      ? json({
          authenticated: true,
          account: { id: account.id, email: account.email },
          session: { id: account.sessionId, name: account.sessionName, platform: account.platform },
        })
      : json({ error: "unauthorized" }, 401);
  }
  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    const account = await verifiedAccount(request, env);
    if (account) {
      await env.DB.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id = ?")
        .bind(unixTime(), account.sessionId).run();
    }
    return json({ revoked: true }, 200, { "set-cookie": expiredSessionCookie() });
  }
  return null;
}

async function createChallenge(request: Request, env: Env): Promise<Response> {
  const input = await jsonInput(request);
  const id = crypto.randomUUID();
  const expiresAt = unixTime() + CHALLENGE_SECONDS;
  const email = normalizeEmail(input.email);
  const challenge = text(input.pkceChallenge);
  const response = { challengeId: id, expiresAt: new Date(expiresAt * 1000).toISOString() };
  if (!email || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return json(response, 202);

  const networkHash = await sha256(`${env.AUTH_RATE_LIMIT_SECRET}:${request.headers.get("cf-connecting-ip") || "unknown"}`);
  const now = unixTime();
  const [emailRate, networkRate] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM auth_challenges WHERE email = ? AND created_at >= ?")
      .bind(email, now - 15 * 60).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM auth_challenges WHERE network_hash = ? AND created_at >= ?")
      .bind(networkHash, now - 60 * 60).first<{ count: number }>(),
  ]);
  if ((emailRate?.count || 0) >= 5 || (networkRate?.count || 0) >= 20) return json(response, 202);

  const token = randomToken("nib_magic");
  const code = generateSignInCode();
  await env.DB.prepare(
    `INSERT INTO auth_challenges
      (id, email, token_hash, code_hash, pkce_challenge, platform, device_name, network_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    email,
    await sha256(token),
    await signInCodeHash(id, code),
    challenge,
    safeLabel(input.platform, "web"),
    safeLabel(input.deviceName, "Nib"),
    networkHash,
    now,
    expiresAt,
  ).run();

  const link = `${ORIGIN}/auth/verify?challenge=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
  try {
    const { sendMagicLinkEmail } = await import("./magic-email");
    await sendMagicLinkEmail(env.EMAIL, email, link, code);
  } catch (error) {
    console.error("Nib magic-link email failed", safeEmailError(error));
    return json({ error: "email_unavailable" }, 503);
  }
  return json(response, 202);
}

async function verifyChallenge(request: Request, env: Env, id: string): Promise<Response> {
  const input = await formOrJsonInput(request);
  const now = unixTime();
  const code = normalizeSignInCode(input.code);
  if (code) {
    const result = await env.DB.prepare(
      `UPDATE auth_challenges SET verified_at = ?
        WHERE id = ? AND code_hash = ? AND expires_at >= ?
          AND failed_code_attempts < 5 AND verified_at IS NULL AND consumed_at IS NULL`,
    ).bind(now, id, await signInCodeHash(id, code), now).run();
    if (!result.meta.changes) {
      await env.DB.prepare(
        `UPDATE auth_challenges SET failed_code_attempts = failed_code_attempts + 1
          WHERE id = ? AND expires_at >= ? AND failed_code_attempts < 5
            AND verified_at IS NULL AND consumed_at IS NULL`,
      ).bind(id, now).run();
      return json({ error: "invalid_or_expired_code" }, 401);
    }
    return json({ verified: true });
  }

  const tokenHash = await sha256(text(input.token));
  const result = await env.DB.prepare(
    `UPDATE auth_challenges SET verified_at = ?
      WHERE id = ? AND token_hash = ? AND expires_at >= ?
        AND verified_at IS NULL AND consumed_at IS NULL`,
  ).bind(now, id, tokenHash, now).run();
  if (!result.meta.changes) return html(messagePage("This sign-in link is invalid or expired.", false), 401);
  return html(messagePage("You’re signed in. Return to Nib to continue.", true));
}

async function exchangeChallenge(request: Request, env: Env, id: string): Promise<Response> {
  const input = await jsonInput(request);
  const verifier = text(input.verifier);
  const now = unixTime();
  const challenge = await env.DB.prepare("SELECT * FROM auth_challenges WHERE id = ?")
    .bind(id).first<ChallengeRow>();
  if (!challenge || challenge.expires_at < now || !challenge.verified_at || challenge.consumed_at) {
    return challenge && !challenge.verified_at && challenge.expires_at >= now
      ? json({ status: "pending" }, 202)
      : json({ error: "invalid_or_expired_challenge" }, 401);
  }
  if (!verifier || !constantTimeEqual(await pkceChallenge(verifier), challenge.pkce_challenge)) {
    return json({ error: "invalid_verifier" }, 401);
  }

  let account = await env.DB.prepare("SELECT account_id, email FROM accounts WHERE email = ?")
    .bind(challenge.email).first<{ account_id: string; email: string }>();
  if (!account) {
    const accountId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO accounts(account_id, email, plan, created_at, updated_at) VALUES (?, ?, 'default', ?, ?)",
    ).bind(accountId, challenge.email, now, now).run();
    account = await env.DB.prepare("SELECT account_id, email FROM accounts WHERE email = ?")
      .bind(challenge.email).first<{ account_id: string; email: string }>();
  }
  if (!account) return json({ error: "account_creation_failed" }, 500);

  const sessionId = crypto.randomUUID();
  const token = randomToken("nib_session");
  const statements = [
    env.DB.prepare(
      `INSERT INTO auth_sessions(id, account_id, token_hash, name, platform, created_at, last_used_at)
       SELECT ?, ?, ?, ?, ?, ?, ? FROM auth_challenges
        WHERE id = ? AND consumed_at IS NULL`,
    ).bind(sessionId, account.account_id, await sha256(token), challenge.device_name, challenge.platform, now, now, id),
    env.DB.prepare(
      "UPDATE auth_challenges SET consumed_at = ?, session_id = ? WHERE id = ? AND consumed_at IS NULL",
    ).bind(now, sessionId, id),
  ];
  const results = await env.DB.batch(statements);
  if (!results[0]?.meta.changes || !results[1]?.meta.changes) return json({ error: "challenge_already_used" }, 409);

  const headers: Record<string, string> = {};
  if (challenge.platform === "web") headers["set-cookie"] = sessionCookie(token);
  return json({
    authenticated: true,
    token,
    account: { id: account.account_id, email: account.email },
    session: { id: sessionId, name: challenge.device_name, platform: challenge.platform },
  }, 200, headers);
}

function signInPage(): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sign in to Nib</title>${styles()}<main><p class="wordmark">Nib</p><h1>Sign in to Nib</h1><p>Enter your email. We’ll send you a secure sign-in link.</p><form id="form"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required><button>Send sign-in link</button><p id="status" role="status"></p></form></main><script>${signInScript()}</script></html>`;
}

function signInScript(): string {
  return `const form=document.querySelector('#form'),status=document.querySelector('#status');
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
form.addEventListener('submit',async e=>{e.preventDefault();const button=form.querySelector('button');button.disabled=true;status.textContent='Sending sign-in link…';const bytes=crypto.getRandomValues(new Uint8Array(32)),verifier=b64(bytes),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)),pkceChallenge=b64(digest);const response=await fetch('/api/auth/challenges',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:form.email.value,pkceChallenge,platform:'web',deviceName:'Nib web'})});if(!response.ok){status.textContent='Nib could not send the link. Try again.';button.disabled=false;return}const data=await response.json();sessionStorage.setItem('nib.auth',JSON.stringify({id:data.challengeId,verifier}));status.textContent='Check your email. This page will finish signing you in.';poll(data.challengeId,verifier)});
async function poll(id,verifier){const response=await fetch('/api/auth/challenges/'+encodeURIComponent(id)+'/token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({verifier})});if(response.status===202){setTimeout(()=>poll(id,verifier),1500);return}if(response.ok){sessionStorage.removeItem('nib.auth');location.assign('/account');return}status.textContent='This sign-in request expired. Send a new link.';form.querySelector('button').disabled=false}
const pending=sessionStorage.getItem('nib.auth');if(pending){try{const value=JSON.parse(pending);status.textContent='Waiting for your sign-in link…';poll(value.id,value.verifier)}catch{sessionStorage.removeItem('nib.auth')}}`;
}

function verificationPage(url: URL): string {
  const id = url.searchParams.get("challenge") || "";
  const token = url.searchParams.get("token") || "";
  if (!/^[0-9a-f-]{36}$/i.test(id) || !token) return messagePage("This sign-in link is invalid or expired.", false);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Confirm Nib sign-in</title>${styles()}<main><p class="wordmark">Nib</p><h1>Confirm sign-in</h1><p>Use this link only if you requested it from Nib.</p><form method="post" action="/api/auth/challenges/${escapeHtml(id)}/verify"><input type="hidden" name="token" value="${escapeHtml(token)}"><button>Sign in to Nib</button></form></main></html>`;
}

function messagePage(message: string, success: boolean): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Nib sign-in</title>${styles()}<main><p class="wordmark">Nib</p><h1>${success ? "Signed in" : "Sign-in failed"}</h1><p>${escapeHtml(message)}</p></main></html>`;
}

function styles(): string {
  return `<style>:root{color-scheme:light dark;font:16px system-ui}body{margin:0;background:#f4f2ed;color:#171717}main{box-sizing:border-box;max-width:28rem;margin:12vh auto;padding:2rem}h1{font-size:2rem;letter-spacing:-.03em;margin:.5rem 0}.wordmark{font-weight:800}label{display:block;font-weight:650;margin:1.5rem 0 .45rem}input,button{box-sizing:border-box;width:100%;min-height:3rem;border-radius:.75rem;font:inherit}input{border:1px solid #aaa;padding:.7rem .85rem;background:white;color:#171717}button{margin-top:1rem;border:0;background:#171717;color:white;font-weight:700;padding:.7rem 1rem}button:disabled{opacity:.55}#status{min-height:3rem;color:#555}@media(prefers-color-scheme:dark){body{background:#171717;color:#f5f3ee}input{background:#262626;color:white;border-color:#555}button{background:#f5f3ee;color:#171717}#status{color:#bbb}}</style>`;
}

function sessionCookie(token: string): string {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=31536000`;
}

export function expiredSessionCookie(): string {
  return `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function randomToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${prefix}_${base64Url(bytes)}`;
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function jsonInput(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function formOrJsonInput(request: Request): Promise<Record<string, unknown>> {
  if ((request.headers.get("content-type") || "").includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    const input: Record<string, unknown> = {};
    form.forEach((value, key) => { input[key] = String(value); });
    return input;
  }
  return jsonInput(request);
}

function safeLabel(value: unknown, fallback: string): string {
  return (typeof value === "string" ? value.trim() : "").slice(0, 120) || fallback;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function unixTime(): number {
  return Math.floor(Date.now() / 1000);
}

function safeEmailError(error: unknown): { code?: string; message: string } {
  if (error instanceof Error) return { code: "code" in error ? String(error.code) : undefined, message: error.message };
  return { message: "Unknown email error" };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  } });
}

function json(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", ...extra } });
}
