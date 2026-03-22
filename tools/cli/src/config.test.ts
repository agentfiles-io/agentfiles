import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePrivateFile } from "./config.js";

describe("writePrivateFile", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "agentfiles-config-"));
    tempDirs.push(dir);
    return dir;
  }

  it("tightens permissions when overwriting an existing credential file", () => {
    const dir = createTempDir();
    const filePath = join(dir, "agentfiles.env");
    writeFileSync(filePath, "stale", { mode: 0o644 });

    writePrivateFile(filePath, "ATTACH_API_KEY=test-key\n");

    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });
});
