type DatedRecord = {
  id?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function compareRecordsByRecency(left: DatedRecord, right: DatedRecord): number {
  const leftTimestamp = stringValue(left.updatedAt) || stringValue(left.createdAt);
  const rightTimestamp = stringValue(right.updatedAt) || stringValue(right.createdAt);
  return (
    rightTimestamp.localeCompare(leftTimestamp) ||
    stringValue(right.id).localeCompare(stringValue(left.id))
  );
}

export function isTopLevelRequestStorageKey(key: string): boolean {
  const prefix = "request:";
  return key.startsWith(prefix) && !key.slice(prefix.length).includes(":");
}
