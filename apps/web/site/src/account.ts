import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";

const auth = createAuthClient({
  plugins: [passkeyClient()],
});

const requestedCallback = new URLSearchParams(window.location.search).get("callbackURL");
const callbackURL = requestedCallback?.startsWith("/") && !requestedCallback.startsWith("//")
  ? requestedCallback
  : "/account";

const status = document.querySelector<HTMLElement>("[data-status]");
const show = (message: string, error = false) => {
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("danger", error);
};

const signInForm = document.querySelector<HTMLFormElement>("[data-signin-form]");
signInForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = signInForm.querySelector<HTMLButtonElement>('button[type="submit"]');
  submit?.setAttribute("disabled", "");
  const email = new FormData(signInForm).get("email")?.toString().trim() ?? "";
  const captchaResponse = document.querySelector<HTMLInputElement>("[name='cf-turnstile-response']")?.value;
  const result = await auth.signIn.magicLink({
    email,
    callbackURL,
    ...(captchaResponse ? { fetchOptions: { headers: { "x-captcha-response": captchaResponse } } } : {}),
  });
  submit?.removeAttribute("disabled");
  show(result.error ? result.error.message || "Could not send the link." : "Check your email. The link expires in 10 minutes.", Boolean(result.error));
});

document.querySelector<HTMLButtonElement>("[data-passkey-signin]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  button.disabled = true;
  const result = await auth.signIn.passkey();
  button.disabled = false;
  if (result.error) return show(result.error.message || "Passkey sign-in failed.", true);
  window.location.assign(callbackURL);
});

document.querySelector<HTMLButtonElement>("[data-passkey-add]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  button.disabled = true;
  const result = await auth.passkey.addPasskey({ name: navigator.platform || "Passkey" });
  button.disabled = false;
  show(result.error ? result.error.message || "Could not add the passkey." : "Passkey added.", Boolean(result.error));
});

document.querySelector<HTMLButtonElement>("[data-signout]")?.addEventListener("click", async () => {
  await auth.signOut();
  window.location.assign("/signin");
});

const accountEmail = document.querySelector<HTMLElement>("[data-account-email]");
const accountWorkspace = document.querySelector<HTMLElement>("[data-account-workspace]");
if (accountEmail || accountWorkspace) {
  fetch("/api/account", { headers: { accept: "application/json" } }).then(async (response) => {
    if (response.status === 401) return window.location.assign("/signin");
    if (!response.ok) throw new Error("Could not load the account.");
    const account = await response.json() as { email: string; workspace: { name: string } };
    if (accountEmail) accountEmail.textContent = account.email;
    if (accountWorkspace) accountWorkspace.textContent = account.workspace.name;
  }).catch((error: Error) => show(error.message, true));
}

interface ExpertTokenSummary {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: number;
  lastUsedAt: number | null;
}

const tokenForm = document.querySelector<HTMLFormElement>("[data-token-form]");
const tokenList = document.querySelector<HTMLElement>("[data-token-list]");
const tokenReveal = document.querySelector<HTMLElement>("[data-token-reveal]");
const tokenValue = document.querySelector<HTMLElement>("[data-token-value]");

async function loadExpertTokens() {
  if (!tokenList) return;
  const response = await fetch("/api/account/tokens", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error("Could not load expert tokens.");
  const payload = await response.json() as { tokens: ExpertTokenSummary[] };
  renderExpertTokens(payload.tokens);
}

function renderExpertTokens(tokens: ExpertTokenSummary[]) {
  if (!tokenList) return;
  tokenList.replaceChildren();
  if (tokens.length === 0) {
    const empty = document.createElement("p");
    empty.className = "note";
    empty.textContent = "No active tokens.";
    tokenList.append(empty);
    return;
  }
  for (const token of tokens) {
    const row = document.createElement("div");
    row.className = "token-row";
    const metadata = document.createElement("div");
    metadata.className = "token-meta";
    const name = document.createElement("strong");
    name.textContent = token.name;
    const detail = document.createElement("small");
    detail.textContent = `${token.scopes.join(", ")} · expires ${new Date(token.expiresAt * 1000).toLocaleDateString()}`;
    metadata.append(name, detail);
    const revoke = document.createElement("button");
    revoke.className = "button small";
    revoke.type = "button";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", async () => {
      revoke.disabled = true;
      const response = await fetch(`/api/account/tokens/${token.id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!response.ok) {
        revoke.disabled = false;
        return show("Could not revoke the token.", true);
      }
      show("Token revoked.");
      await loadExpertTokens();
    });
    row.append(metadata, revoke);
    tokenList.append(row);
  }
}

tokenForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = tokenForm.querySelector<HTMLButtonElement>('button[type="submit"]');
  submit?.setAttribute("disabled", "");
  const form = new FormData(tokenForm);
  const response = await fetch("/api/account/tokens", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      name: form.get("name"),
      scopes: form.getAll("scope"),
      expiresInDays: Number(form.get("expiresInDays")),
    }),
  });
  const payload = await response.json() as { token?: string; error?: string };
  submit?.removeAttribute("disabled");
  if (!response.ok || !payload.token) return show(payload.error || "Could not create the token.", true);
  if (tokenValue) tokenValue.textContent = payload.token;
  if (tokenReveal) tokenReveal.hidden = false;
  tokenForm.reset();
  show("Token created. Copy it before leaving this page.");
  await loadExpertTokens();
});

document.querySelector<HTMLButtonElement>("[data-token-copy]")?.addEventListener("click", async () => {
  const token = tokenValue?.textContent ?? "";
  if (!token) return;
  await navigator.clipboard.writeText(token);
  show("Token copied.");
});

if (tokenList) loadExpertTokens().catch((error: Error) => show(error.message, true));

const userCode = new URLSearchParams(window.location.search).get("user_code")?.replaceAll("-", "") ?? "";
const codeLabel = document.querySelector<HTMLElement>("[data-device-code]");
if (codeLabel) codeLabel.textContent = userCode || "Missing code";

async function decideDevice(action: "approve" | "deny") {
  if (!userCode) return show("Open the complete URL printed by Nib CLI.", true);
  const verify = await fetch(`/api/auth/device?user_code=${encodeURIComponent(userCode)}`, { credentials: "same-origin" });
  if (verify.status === 401) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    return window.location.assign(`/signin?callbackURL=${next}`);
  }
  if (!verify.ok) return show("That code is invalid or expired.", true);
  const response = await fetch(`/api/auth/device/${action}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userCode }),
  });
  show(response.ok ? (action === "approve" ? "Device approved. Return to your client." : "Device denied.") : "Could not update this device.", !response.ok);
}

document.querySelector<HTMLButtonElement>("[data-device-approve]")?.addEventListener("click", () => decideDevice("approve"));
document.querySelector<HTMLButtonElement>("[data-device-deny]")?.addEventListener("click", () => decideDevice("deny"));
