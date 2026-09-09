import { describe, expect, it } from "vitest";
import { importJWK, SignJWT, type JWK } from "jose";
import { hashAcceptanceManifest, type AcceptanceReview } from "./contracts";
import { acceptanceJwks, acceptanceJwksFromSigningJwk, signAcceptanceReceipt, verifyAcceptanceReceipt } from "./receipts";
import { manifest } from "./core-test-helpers";

describe("acceptance receipts", () => {
  it("signs portable asymmetric JWS receipts and verifies them offline from JWKS", async () => {
    const signingJwk = await signingJwkFor("acceptance-test-key");
    const review = await approvedReview({ quorum: 1 });
    const env = {
      ACCEPTANCE_SIGNING_JWK: JSON.stringify(signingJwk),
      ACCEPTANCE_SIGNING_KEY_ID: "acceptance-test-key",
    };
    const receipt = await signAcceptanceReceipt(review, env);
    const jwks = acceptanceJwks(env);
    const payload = await verifyAcceptanceReceipt(receipt, jwks);

    expect(jwks.keys).toEqual([
      expect.objectContaining({
        kty: "OKP",
        crv: "Ed25519",
        kid: "acceptance-test-key",
        alg: "EdDSA",
        use: "sig",
      }),
    ]);
    expect(jwks.keys[0]).not.toHaveProperty("d");
    expect(payload).toMatchObject({
      contract: "nib.acceptance/receipt/v1",
      projectId: review.projectId,
      reviewId: review.id,
      state: "approved",
      publishedBy: "publisher",
      policy: review.policy,
      approvedAt: "2026-09-09T00:00:05.000Z",
      manifestHash: review.manifestHash,
    });
    expect(payload.approvals).toEqual([
      {
        actorId: "reviewer-1",
        criteriaIds: ["criterion-a", "criterion-b"],
        createdAt: "2026-09-09T00:00:05.000Z",
      },
    ]);
  });

  it("uses the quorum-reaching approval time and binds the policy into the payload", async () => {
    const signingJwk = await signingJwkFor("quorum-test-key");
    const review = await approvedReview({ quorum: 2 });
    const env = {
      ACCEPTANCE_SIGNING_JWK: JSON.stringify(signingJwk),
      ACCEPTANCE_SIGNING_KEY_ID: "quorum-test-key",
    };
    const payload = await verifyAcceptanceReceipt(await signAcceptanceReceipt(review, env), acceptanceJwks(env));

    expect(payload.approvedAt).toBe("2026-09-09T00:00:30.000Z");
    expect(payload.iat).toBe(Math.floor(Date.parse("2026-09-09T00:00:30.000Z") / 1_000));
    expect(payload.nbf).toBe(Math.floor(Date.parse(review.createdAt) / 1_000));
    expect(payload.exp).toBe(Math.floor(Date.parse(review.expiresAt) / 1_000));
    expect(payload.policy).toEqual({ quorum: 2, ttlSeconds: 604_800 });
  });

  it("supports retained public verification keys during signing key rotation", async () => {
    const oldSigningJwk = await signingJwkFor("old-key");
    const newSigningJwk = await signingJwkFor("new-key");
    const oldEnv = {
      ACCEPTANCE_SIGNING_JWK: JSON.stringify(oldSigningJwk),
      ACCEPTANCE_SIGNING_KEY_ID: "old-key",
    };
    const rotatedEnv = {
      ACCEPTANCE_SIGNING_JWK: JSON.stringify(newSigningJwk),
      ACCEPTANCE_SIGNING_KEY_ID: "new-key",
      ACCEPTANCE_VERIFICATION_JWKS: JSON.stringify(acceptanceJwksFromSigningJwk(JSON.stringify(oldSigningJwk), "old-key")),
    };

    const receipt = await signAcceptanceReceipt(await approvedReview({ quorum: 1 }), oldEnv);
    const payload = await verifyAcceptanceReceipt(receipt, acceptanceJwks(rotatedEnv));

    expect(acceptanceJwks(rotatedEnv).keys.map((key) => key.kid).sort()).toEqual(["new-key", "old-key"]);
    expect(payload.reviewId).toBe("review-1");
  });

  it("rejects authentic receipts whose manifestHash claim does not match the manifest payload", async () => {
    const signingJwk = await signingJwkFor("tamper-test-key");
    const key = await importJWK(signingJwk, "EdDSA");
    const review = await approvedReview({ quorum: 1 });
    const tampered = await new SignJWT({
      ...receiptLikePayload(review),
      manifestHash: "c".repeat(64),
    })
      .setProtectedHeader({ alg: "EdDSA", kid: "tamper-test-key", typ: "JWT" })
      .setIssuer("nib.acceptance")
      .setAudience("nib.acceptance/receipt")
      .setIssuedAt(Math.floor(Date.parse("2026-09-09T00:00:05.000Z") / 1_000))
      .setNotBefore(Math.floor(Date.parse(review.createdAt) / 1_000))
      .setExpirationTime(Math.floor(Date.parse(review.expiresAt) / 1_000))
      .sign(key);

    await expect(verifyAcceptanceReceipt(tampered, acceptanceJwks({
      ACCEPTANCE_SIGNING_JWK: JSON.stringify(signingJwk),
      ACCEPTANCE_SIGNING_KEY_ID: "tamper-test-key",
    }))).rejects.toThrow("manifestHash");
  });

  it("rejects authentic receipts whose exp claim does not match expiresAt", async () => {
    const signingJwk = await signingJwkFor("exp-test-key");
    const key = await importJWK(signingJwk, "EdDSA");
    const review = await approvedReview({ quorum: 1 });
    const inconsistent = await new SignJWT(receiptLikePayload(review))
      .setProtectedHeader({ alg: "EdDSA", kid: "exp-test-key", typ: "JWT" })
      .setIssuer("nib.acceptance")
      .setAudience("nib.acceptance/receipt")
      .setIssuedAt(Math.floor(Date.parse("2026-09-09T00:00:05.000Z") / 1_000))
      .setNotBefore(Math.floor(Date.parse(review.createdAt) / 1_000))
      .setExpirationTime(Math.floor(Date.parse(review.expiresAt) / 1_000) - 1)
      .sign(key);

    await expect(verifyAcceptanceReceipt(inconsistent, acceptanceJwks({
      ACCEPTANCE_SIGNING_JWK: JSON.stringify(signingJwk),
      ACCEPTANCE_SIGNING_KEY_ID: "exp-test-key",
    }))).rejects.toThrow("exp");
  });

  it("rejects non-Ed25519 signing keys for v1 receipts", async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const signingJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey) as JWK;
    signingJwk.alg = "ES256";
    signingJwk.kid = "wrong-key";

    await expect(signAcceptanceReceipt(await approvedReview({ quorum: 1 }), {
      ACCEPTANCE_SIGNING_JWK: JSON.stringify(signingJwk),
      ACCEPTANCE_SIGNING_KEY_ID: "wrong-key",
    })).rejects.toThrow("Ed25519");
  });

  it("rejects expired receipt JWTs", async () => {
    const signingJwk = await signingJwkFor("expired-test-key");
    const review = await approvedReview({
      quorum: 1,
      createdAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-08T00:00:00.000Z",
      voteTimes: ["2020-01-01T00:00:05.000Z"],
    });
    const env = {
      ACCEPTANCE_SIGNING_JWK: JSON.stringify(signingJwk),
      ACCEPTANCE_SIGNING_KEY_ID: "expired-test-key",
    };

    await expect(verifyAcceptanceReceipt(await signAcceptanceReceipt(review, env), acceptanceJwks(env))).rejects.toThrow();
  });
});

async function signingJwkFor(kid: string): Promise<JWK> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const signingJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey) as JWK;
  signingJwk.alg = "EdDSA";
  signingJwk.kid = kid;
  return signingJwk;
}

async function approvedReview(options: {
  quorum: number;
  createdAt?: string;
  expiresAt?: string;
  voteTimes?: string[];
}): Promise<AcceptanceReview> {
  const packet = manifest();
  const createdAt = options.createdAt ?? "2026-09-09T00:00:00.000Z";
  const expiresAt = options.expiresAt ?? "2030-01-01T00:00:00.000Z";
  const voteTimes = options.voteTimes ?? ["2026-09-09T00:00:05.000Z", "2026-09-09T00:00:30.000Z"];
  return {
    id: "review-1",
    projectId: packet.projectId,
    subject: packet.subject,
    gate: packet.gate,
    revision: 1,
    manifest: packet,
    manifestHash: await hashAcceptanceManifest(packet),
    state: "approved",
    policy: { quorum: options.quorum, ttlSeconds: 604_800 },
    eligibleReviewers: ["reviewer-1", "reviewer-2"],
    createdAt,
    expiresAt,
    publishedBy: "publisher",
    votes: [
      {
        actorId: "reviewer-1",
        decision: "approve",
        criteriaIds: ["criterion-a", "criterion-b"],
        createdAt: voteTimes[0]!,
      },
      ...(options.quorum > 1 ? [{
        actorId: "reviewer-2",
        decision: "approve" as const,
        criteriaIds: ["criterion-a", "criterion-b"],
        createdAt: voteTimes[1]!,
      }] : []),
    ],
    comments: [],
    receipt: null,
  };
}

function receiptLikePayload(review: AcceptanceReview): Record<string, unknown> {
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
    approvedAt: "2026-09-09T00:00:05.000Z",
    expiresAt: review.expiresAt,
    publishedBy: review.publishedBy,
    policy: review.policy,
    approvals: review.votes.map((vote) => ({
      actorId: vote.actorId,
      criteriaIds: vote.criteriaIds,
      createdAt: vote.createdAt,
    })),
    manifest: review.manifest,
  };
}
