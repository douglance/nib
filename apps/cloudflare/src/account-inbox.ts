const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function canonicalAccountId(value: string): string | null {
  const accountId = value.trim().toLowerCase();
  return ACCOUNT_ID.test(accountId) ? accountId : null;
}

export function accountInboxName(value: string): string {
  const accountId = canonicalAccountId(value);
  if (!accountId) throw new TypeError("Invalid Nib account ID");
  return `account:${accountId}`;
}
