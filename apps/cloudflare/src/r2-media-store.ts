import type { MediaStore, MediaWriteOptions, UploadedPart } from "./hosted-request-core";

export class R2MediaStore implements MediaStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, value: ArrayBuffer | Uint8Array, options?: MediaWriteOptions): Promise<void> {
    await this.bucket.put(key, value, options);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const object = await this.bucket.get(key);
    if (!object) return undefined;
    return new Uint8Array(await object.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async createMultipart(key: string, options?: MediaWriteOptions): Promise<{ uploadId: string }> {
    const upload = await this.bucket.createMultipartUpload(key, options);
    return { uploadId: upload.uploadId };
  }

  async uploadMultipartPart(key: string, uploadId: string, partNumber: number, value: ArrayBuffer | Uint8Array): Promise<UploadedPart> {
    const upload = this.bucket.resumeMultipartUpload(key, uploadId);
    return upload.uploadPart(partNumber, value instanceof Uint8Array ? value : new Uint8Array(value));
  }

  async completeMultipart(key: string, uploadId: string, parts: UploadedPart[]): Promise<void> {
    const upload = this.bucket.resumeMultipartUpload(key, uploadId);
    await upload.complete(parts);
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    const upload = this.bucket.resumeMultipartUpload(key, uploadId);
    await upload.abort();
  }
}
