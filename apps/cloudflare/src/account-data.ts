export interface AccountDeletionResult {
  deletedObjects: number;
}

export async function purgeReviewAccount(
  accountId: string,
  storage: DurableObjectStorage,
  media: R2Bucket,
  deletedAt = new Date().toISOString(),
): Promise<AccountDeletionResult> {
  const prefixes = [
    `accounts/${accountId}/attachments/`,
    `tenants/${accountId}/nib-files/`,
  ];
  let deletedObjects = 0;
  for (const prefix of prefixes) deletedObjects += await deleteR2Prefix(media, prefix);
  await storage.deleteAll();
  await storage.put("account:deleted", { deletedAt });
  return { deletedObjects };
}

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let deleted = 0;
  while (true) {
    const page = await bucket.list({ prefix, limit: 1_000 });
    const keys = page.objects.map((object) => object.key);
    if (!keys.length) return deleted;
    await bucket.delete(keys);
    deleted += keys.length;
  }
}
