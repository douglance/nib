import type {
  AcceptanceEvent,
  AcceptanceManifest,
  AcceptanceReview,
} from "./contracts";
import type { AcceptanceMutation, AcceptanceStore } from "./coordinator";

export class MemoryAcceptanceStore implements AcceptanceStore {
  private readonly reviews = new Map<string, AcceptanceReview>();
  private readonly current = new Map<string, string>();
  private readonly idempotency = new Map<string, { fingerprint: string; result: unknown }>();
  private readonly outbox = new Map<string, AcceptanceEvent>();
  private sequence = 1;

  async getReview(id: string): Promise<AcceptanceReview | undefined> {
    const review = this.reviews.get(id);
    return review ? clone(review) : undefined;
  }

  async listReviews(): Promise<AcceptanceReview[]> {
    return [...this.reviews.values()].map(clone);
  }

  async getCurrentId(subject: string, gate: string): Promise<string | undefined> {
    return this.current.get(currentKey(subject, gate));
  }

  async getIdempotency(key: string): Promise<{ fingerprint: string; result: unknown } | undefined> {
    const record = this.idempotency.get(key);
    return record ? clone(record) : undefined;
  }

  async nextSequence(): Promise<number> {
    return this.sequence++;
  }

  async commit(mutation: AcceptanceMutation): Promise<void> {
    if (mutation.idempotency) {
      const existing = this.idempotency.get(mutation.idempotency.key);
      if (existing && existing.fingerprint !== mutation.idempotency.fingerprint) {
        throw new Error("idempotency conflict");
      }
    }
    for (const review of mutation.reviews ?? []) this.reviews.set(review.id, clone(review));
    for (const current of mutation.current ?? []) this.current.set(currentKey(current.subject, current.gate), current.reviewId);
    for (const event of mutation.events ?? []) this.outbox.set(event.id, clone(event));
    if (mutation.idempotency) this.idempotency.set(mutation.idempotency.key, clone(mutation.idempotency));
  }

  async listOutbox(limit: number): Promise<AcceptanceEvent[]> {
    return [...this.outbox.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, limit)
      .map(clone);
  }

  async deleteOutbox(id: string): Promise<void> {
    this.outbox.delete(id);
  }
}

export class ManualClock {
  constructor(private current: Date = new Date("2026-01-01T00:00:00.000Z")) {}

  now(): Date {
    return new Date(this.current);
  }

  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1_000);
  }
}

export class PredictableIds {
  private next = 1;

  randomId(): string {
    return `id-${this.next++}`;
  }
}

export function manifest(overrides: Partial<AcceptanceManifest> = {}): AcceptanceManifest {
  return {
    contract: "nib.acceptance/v1",
    projectId: "project-1",
    subject: "homepage",
    gate: "visual-acceptance",
    title: "Homepage acceptance",
    request: "Ship the updated homepage",
    change: "Updated header and proof section",
    criteria: [
      { id: "criterion-a", text: "Header matches the approved direction", verification: "visual review" },
      { id: "criterion-b", text: "Proof section renders on mobile", verification: "browser smoke" },
    ],
    build: {
      commit: "abc123",
      provider: "cloudflare",
      previewUrl: "https://preview.nib.example",
      deployment: {
        id: "deployment-1",
        components: [{ name: "web", versionId: "version-1", kind: "worker" }],
      },
      assumptions: [],
    },
    evidence: [
      {
        id: "evidence-1",
        kind: "test",
        label: "Vitest",
        sha256: "a".repeat(64),
        contentType: "text/plain",
      },
    ],
    ...overrides,
  };
}

function currentKey(subject: string, gate: string): string {
  return `${subject}\n${gate}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
