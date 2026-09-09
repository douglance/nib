export interface CoordinatedResponse {
  idempotencyKey?: string;
}

export interface CoordinatedRequest<Response extends CoordinatedResponse> {
  responses: Response[];
  status: string;
  answeredAt: string | null;
  actedAt: string | null;
  updatedAt: string;
}

export interface ResponseTransaction {
  get<Value>(key: string): Promise<Value | undefined>;
  put<Value>(key: string, value: Value): Promise<void>;
}

export type ResponseCommitResult<Request> =
  | { outcome: "missing" }
  | { outcome: "accepted" | "retry" | "conflict"; item: Request };

export function responseChoiceValue(
  input: { decision?: unknown; choice?: unknown; choiceIndex?: unknown },
  choices: unknown[]
): string {
  const explicit = nonEmptyString(input.decision) || nonEmptyString(input.choice);
  if (explicit) return explicit;
  if (!Number.isInteger(input.choiceIndex)) return "";
  const index = Number(input.choiceIndex);
  if (index < 0 || index >= choices.length) return "";
  return nonEmptyString(choices[index]);
}

export function visualResponseError(decision: string, comment: string): string | null {
  if (decision && !["approve", "reject", "comment"].includes(decision)) {
    return "Visual review decision must be approve, reject, or comment";
  }
  if ((!decision || decision === "comment") && !comment) {
    return "A comment response requires nonempty text";
  }
  return null;
}

export async function commitFirstResponse<
  Response extends CoordinatedResponse,
  Request extends CoordinatedRequest<Response>
>(input: {
  runTransaction: <Value>(callback: (transaction: ResponseTransaction) => Promise<Value>) => Promise<Value>;
  storageKey: string;
  response: Response;
  idempotencyKey: string;
  acted: boolean;
  now: string;
}): Promise<ResponseCommitResult<Request>> {
  return input.runTransaction(async (transaction) => {
    const current = await transaction.get<Request>(input.storageKey);
    if (!current) return { outcome: "missing" as const };
    if (current.responses.length) {
      return input.idempotencyKey && current.responses[0].idempotencyKey === input.idempotencyKey
        ? { outcome: "retry" as const, item: current }
        : { outcome: "conflict" as const, item: current };
    }
    current.responses = [input.response];
    current.status = input.acted ? "acted" : "answered";
    current.answeredAt = input.now;
    current.actedAt = input.acted ? input.now : null;
    current.updatedAt = input.now;
    await transaction.put(input.storageKey, current);
    return { outcome: "accepted" as const, item: current };
  });
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
