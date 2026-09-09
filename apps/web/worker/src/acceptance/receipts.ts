import { createLocalJWKSet, importJWK, jwtVerify, SignJWT, type JSONWebKeySet, type JWK, type JWTPayload } from "jose";
import { hashAcceptanceManifest, type AcceptanceManifest, type AcceptancePolicy, type AcceptanceReview } from "./contracts";

const ACCEPTANCE_JWS_ALGORITHM = "EdDSA";
const ACCEPTANCE_JWK_TYPE = "OKP";
const ACCEPTANCE_JWK_CURVE = "Ed25519";

export interface AcceptanceReceiptPayload extends JWTPayload {
  contract: "nib.acceptance/receipt/v1";
  projectId: string;
  reviewId: string;
  subject: string;
  gate: string;
  revision: number;
  manifestHash: string;
  state: "approved";
  createdAt: string;
  approvedAt: string;
  expiresAt: string;
  publishedBy: string;
  policy: AcceptancePolicy;
  approvals: {
    actorId: string;
    criteriaIds: string[];
    createdAt: string;
  }[];
  manifest: AcceptanceManifest;
}

export interface AcceptanceReceiptSigningEnv {
  ACCEPTANCE_SIGNING_JWK?: string;
  ACCEPTANCE_SIGNING_KEY_ID?: string;
  ACCEPTANCE_VERIFICATION_JWKS?: string;
}

export type AcceptanceReceiptEnvInput = AcceptanceReceiptSigningEnv | object;

export async function signAcceptanceReceipt(
  review: AcceptanceReview,
  env: AcceptanceReceiptSigningEnv,
): Promise<string> {
  const jwk = parseSigningJwk(env.ACCEPTANCE_SIGNING_JWK);
  assertEd25519Jwk(jwk, true);
  const kid = env.ACCEPTANCE_SIGNING_KEY_ID || jwk.kid;
  if (!kid) throw new Error("ACCEPTANCE_SIGNING_KEY_ID is required");
  const key = await importJWK(jwk, ACCEPTANCE_JWS_ALGORITHM);
  const payload = receiptPayload(review);
  const approvedAt = toUnixSeconds(payload.approvedAt, "approvedAt");
  const expiresAt = toUnixSeconds(review.expiresAt, "expiresAt");
  return new SignJWT(payload)
    .setProtectedHeader({ alg: ACCEPTANCE_JWS_ALGORITHM, kid, typ: "JWT" })
    .setIssuer("nib.acceptance")
    .setAudience("nib.acceptance/receipt")
    .setIssuedAt(approvedAt)
    .setNotBefore(toUnixSeconds(review.createdAt, "createdAt"))
    .setExpirationTime(expiresAt)
    .sign(key);
}

export async function verifyAcceptanceReceipt(
  token: string,
  jwks: JSONWebKeySet,
): Promise<AcceptanceReceiptPayload> {
  assertEd25519Jwks(jwks);
  const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks), {
    issuer: "nib.acceptance",
    audience: "nib.acceptance/receipt",
    algorithms: [ACCEPTANCE_JWS_ALGORITHM],
  });
  if (protectedHeader.alg !== ACCEPTANCE_JWS_ALGORITHM) throw new Error("acceptance receipt must use EdDSA");
  if (payload.contract !== "nib.acceptance/receipt/v1" || payload.state !== "approved") {
    throw new Error("invalid acceptance receipt payload");
  }
  const verified = payload as unknown as AcceptanceReceiptPayload;
  if (verified.manifestHash !== await hashAcceptanceManifest(verified.manifest)) {
    throw new Error("acceptance receipt manifestHash does not match manifest payload");
  }
  if (verified.exp !== toUnixSeconds(verified.expiresAt, "expiresAt")) {
    throw new Error("acceptance receipt exp does not match expiresAt");
  }
  if (verified.nbf !== toUnixSeconds(verified.createdAt, "createdAt")) {
    throw new Error("acceptance receipt nbf does not match createdAt");
  }
  if (verified.approvedAt !== quorumApprovedAtFromPayload(verified)) {
    throw new Error("acceptance receipt approvedAt does not match approval quorum");
  }
  if (verified.iat !== toUnixSeconds(verified.approvedAt, "approvedAt")) {
    throw new Error("acceptance receipt iat does not match approvedAt");
  }
  return verified;
}

export function acceptanceJwksFromSigningJwk(
  signingJwkText: string | undefined,
  keyId: string | undefined,
): JSONWebKeySet {
  const jwk = parseSigningJwk(signingJwkText);
  assertEd25519Jwk(jwk, true);
  const publicJwk = publicJwkFromPrivate(jwk);
  const kid = keyId || jwk.kid;
  if (!kid) throw new Error("ACCEPTANCE_SIGNING_KEY_ID is required");
  return {
    keys: [{ ...publicJwk, kid, alg: ACCEPTANCE_JWS_ALGORITHM, use: "sig" }],
  };
}

export function acceptanceJwks(env: AcceptanceReceiptEnvInput): JSONWebKeySet {
  return combineJwks(
    parseVerificationJwks(envString(env, "ACCEPTANCE_VERIFICATION_JWKS")),
    currentSigningJwks(env),
  );
}

export function acceptanceJwksResponse(env: AcceptanceReceiptEnvInput): Response {
  return Response.json(acceptanceJwks(env), {
    headers: { "cache-control": "public, max-age=300" },
  });
}

export function receiptPayload(review: AcceptanceReview): AcceptanceReceiptPayload {
  if (review.state !== "approved") throw new Error("only approved reviews can be receipted");
  return {
    contract: "nib.acceptance/receipt/v1",
    projectId: review.projectId,
    reviewId: review.id,
    subject: review.subject,
    gate: review.gate,
    revision: review.revision,
    manifestHash: review.manifestHash,
    state: "approved",
    createdAt: review.createdAt,
    approvedAt: quorumApprovedAt(review),
    expiresAt: review.expiresAt,
    publishedBy: review.publishedBy,
    policy: review.policy,
    approvals: review.votes
      .filter((vote) => vote.decision === "approve")
      .map((vote) => ({
        actorId: vote.actorId,
        criteriaIds: [...vote.criteriaIds],
        createdAt: vote.createdAt,
      })),
    manifest: review.manifest,
  };
}

export function quorumApprovedAt(review: AcceptanceReview): string {
  const criteriaIds = review.manifest.criteria.map((criterion) => criterion.id);
  const approvalVotes = review.votes
    .filter((vote) => vote.decision === "approve")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const vote of approvalVotes) {
    const reached = criteriaIds.every((criterionId) =>
      approvalVotes
        .filter((candidate) => candidate.createdAt <= vote.createdAt)
        .filter((candidate) => candidate.criteriaIds.includes(criterionId))
        .length >= review.policy.quorum,
    );
    if (reached) return vote.createdAt;
  }
  throw new Error("approved review does not contain quorum approvals");
}

function quorumApprovedAtFromPayload(payload: AcceptanceReceiptPayload): string {
  if (!Number.isInteger(payload.policy.quorum) || payload.policy.quorum < 1) {
    throw new Error("acceptance receipt policy quorum is invalid");
  }
  const criteriaIds = payload.manifest.criteria.map((criterion) => criterion.id);
  const knownCriteria = new Set(criteriaIds);
  const approvalVotes = payload.approvals
    .map((approval) => {
      if (!approval.actorId || !approval.createdAt || !Array.isArray(approval.criteriaIds)) {
        throw new Error("acceptance receipt approval is invalid");
      }
      const uniqueCriteria = new Set(approval.criteriaIds);
      if (
        uniqueCriteria.size !== approval.criteriaIds.length ||
        approval.criteriaIds.some((criterionId) => !knownCriteria.has(criterionId))
      ) {
        throw new Error("acceptance receipt approval criteria are invalid");
      }
      return approval;
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const vote of approvalVotes) {
    const reached = criteriaIds.every((criterionId) =>
      approvalVotes
        .filter((candidate) => candidate.createdAt <= vote.createdAt)
        .filter((candidate) => candidate.criteriaIds.includes(criterionId))
        .length >= payload.policy.quorum,
    );
    if (reached) return vote.createdAt;
  }
  throw new Error("acceptance receipt approvals do not satisfy quorum");
}

function parseSigningJwk(text: string | undefined): JWK {
  if (!text) throw new Error("ACCEPTANCE_SIGNING_JWK is required");
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("ACCEPTANCE_SIGNING_JWK must be a JWK object");
  }
  return parsed as JWK;
}

function publicJwkFromPrivate(jwk: JWK): JWK {
  if (jwk.kty === ACCEPTANCE_JWK_TYPE && jwk.crv === ACCEPTANCE_JWK_CURVE && jwk.x) {
    return { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
  }
  throw new Error("ACCEPTANCE_SIGNING_JWK does not contain public key parameters");
}

function envString(env: AcceptanceReceiptEnvInput, key: keyof AcceptanceReceiptSigningEnv): string | undefined {
  const value = (env as AcceptanceReceiptSigningEnv)[key];
  return typeof value === "string" ? value : undefined;
}

function parseVerificationJwks(text: string | undefined): JSONWebKeySet {
  if (!text) return { keys: [] };
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as JSONWebKeySet).keys)
  ) {
    throw new Error("ACCEPTANCE_VERIFICATION_JWKS must be a JWKS object");
  }
  return parsed as JSONWebKeySet;
}

function currentSigningJwks(env: AcceptanceReceiptEnvInput): JSONWebKeySet {
  const signingJwk = envString(env, "ACCEPTANCE_SIGNING_JWK");
  if (!signingJwk) return { keys: [] };
  return acceptanceJwksFromSigningJwk(signingJwk, envString(env, "ACCEPTANCE_SIGNING_KEY_ID"));
}

function combineJwks(...sets: JSONWebKeySet[]): JSONWebKeySet {
  const keys = new Map<string, JWK>();
  let anonymous = 0;
  for (const set of sets) {
    for (const key of set.keys) {
      keys.set(key.kid || `anonymous:${anonymous++}`, key);
    }
  }
  return { keys: [...keys.values()] };
}

function toUnixSeconds(value: string, field: string): number {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`invalid receipt ${field}`);
  return Math.floor(millis / 1_000);
}

function assertEd25519Jwks(jwks: JSONWebKeySet): void {
  for (const jwk of jwks.keys) assertEd25519Jwk(jwk, false);
}

function assertEd25519Jwk(jwk: JWK, requirePrivate: boolean): void {
  if (jwk.kty !== ACCEPTANCE_JWK_TYPE || jwk.crv !== ACCEPTANCE_JWK_CURVE || typeof jwk.x !== "string") {
    throw new Error("acceptance v1 receipts require Ed25519 JWKs");
  }
  if (jwk.alg !== undefined && jwk.alg !== ACCEPTANCE_JWS_ALGORITHM) {
    throw new Error("acceptance v1 receipts require EdDSA");
  }
  if (requirePrivate && typeof jwk.d !== "string") {
    throw new Error("ACCEPTANCE_SIGNING_JWK must be an Ed25519 private JWK");
  }
}
