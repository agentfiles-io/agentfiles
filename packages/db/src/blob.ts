import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface BlobStore {
  put(content: Buffer): string; // Returns hash (storage key)
  get(hash: string): Buffer | null;
  exists(hash: string): boolean;
  delete(hash: string): void;
}

/**
 * Content-addressed blob storage using filesystem.
 * Uses SHA-256 hashing with first 2 characters as directory prefix for sharding.
 */
export class FileBlobStore implements BlobStore {
  constructor(private basePath: string) {
    // Ensure base path exists
    if (!existsSync(basePath)) {
      mkdirSync(basePath, { recursive: true });
    }
  }

  private hash(content: Buffer): string {
    return createHash("sha256").update(content).digest("hex");
  }

  private getPath(hash: string): string {
    const prefix = hash.slice(0, 2);
    const dir = join(this.basePath, prefix);
    return join(dir, hash);
  }

  private ensureDir(hash: string): void {
    const prefix = hash.slice(0, 2);
    const dir = join(this.basePath, prefix);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  put(content: Buffer): string {
    const hash = this.hash(content);
    const path = this.getPath(hash);

    // Skip if already exists (content deduplication)
    if (!existsSync(path)) {
      this.ensureDir(hash);
      writeFileSync(path, content);
    }

    return hash;
  }

  get(hash: string): Buffer | null {
    const path = this.getPath(hash);

    if (!existsSync(path)) {
      return null;
    }

    const content = readFileSync(path);

    // Verify integrity
    const actualHash = this.hash(content);
    if (actualHash !== hash) {
      console.error(`Blob integrity check failed: expected ${hash}, got ${actualHash}`);
      return null;
    }

    return content;
  }

  exists(hash: string): boolean {
    return existsSync(this.getPath(hash));
  }

  delete(hash: string): void {
    const path = this.getPath(hash);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
}
