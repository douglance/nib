import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { bearer, captcha, deviceAuthorization, magicLink } from "better-auth/plugins";
import { provisionPersonalWorkspace, sessionLifetimeSeconds } from "./account";
import { captureE2eMagicLink } from "./e2e-support";
import type { Env } from "./types";

const magicLinkLifetimeSeconds = 60 * 10;

export function authRateLimitOptions(environment: string) {
  return {
    enabled: true,
    storage: "database" as const,
    modelName: "auth_rate_limit",
    window: 60,
    max: environment === "e2e" ? 10_000 : 100,
    customRules: {
      "/sign-in/magic-link": { window: 60, max: environment === "e2e" ? 1_000 : 5 },
      "/device/code": { window: 60, max: 10 },
    },
  };
}

export function magicLinkRateLimitOptions(environment: string) {
  return { window: 60, max: environment === "e2e" ? 1_000 : 5 };
}

export function createAuth(env: Env) {
  const baseURL = env.BETTER_AUTH_URL || env.PUBLIC_ORIGIN;
  return betterAuth({
    database: env.DB,
    user: { modelName: "auth_user" },
    session: {
      modelName: "auth_session",
      expiresIn: sessionLifetimeSeconds,
      updateAge: 60 * 60 * 24,
    },
    account: { modelName: "auth_account" },
    verification: { modelName: "auth_verification" },
    emailAndPassword: { enabled: false },
    secret: env.BETTER_AUTH_SECRET,
    baseURL,
    trustedOrigins: [baseURL, env.PUBLIC_ORIGIN].filter(Boolean),
    rateLimit: authRateLimitOptions(env.ENVIRONMENT),
    advanced: {
      cookiePrefix: "nib",
      useSecureCookies: baseURL.startsWith("https://"),
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await provisionPersonalWorkspace(env, user);
          },
        },
      },
    },
    plugins: [
      bearer(),
      deviceAuthorization({
        expiresIn: "10m",
        interval: "5s",
        verificationUri: `${env.PUBLIC_ORIGIN}/device`,
      }),
      passkey({
        rpName: "Nib",
        rpID: new URL(baseURL).hostname,
        origin: baseURL,
      }),
      magicLink({
        expiresIn: magicLinkLifetimeSeconds,
        storeToken: "hashed",
        rateLimit: magicLinkRateLimitOptions(env.ENVIRONMENT),
        async sendMagicLink({ email, url }) {
          if (await captureE2eMagicLink(env, email, url)) return;
          if (!env.EMAIL) throw new Error("Nib sign-in email is not configured");
          const safeUrl = escapeHtml(url);
          await env.EMAIL.send({
            from: { email: "no-reply@nibtool.com", name: "Nib" },
            to: email,
            subject: "Sign in to Nib",
            text: `Sign in to Nib:\n\n${url}\n\nThis link expires in 10 minutes. If you did not request it, ignore this email.`,
            html: `<p>Sign in to Nib:</p><p><a href="${safeUrl}">Open Nib</a></p><p>This link expires in 10 minutes. If you did not request it, ignore this email.</p>`,
          });
        },
      }),
      ...(env.TURNSTILE_SECRET_KEY
        ? [captcha({
            provider: "cloudflare-turnstile",
            secretKey: env.TURNSTILE_SECRET_KEY,
            endpoints: ["/sign-in/magic-link"],
          })]
        : []),
    ],
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export type NibAuth = ReturnType<typeof createAuth>;
