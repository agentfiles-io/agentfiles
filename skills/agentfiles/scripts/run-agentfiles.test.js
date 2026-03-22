import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDirectExecution, resolveInvocationOrReport } from "./run-agentfiles.js";

test("resolveInvocationOrReport emits a concise error and suppresses stack traces", () => {
  const messages = [];
  const invocation = resolveInvocationOrReport(
    () => {
      throw new Error(
        "Could not find `agentfiles` on PATH, and no npm-backed fallback is available.",
      );
    },
    (...parts) => {
      messages.push(parts.join(" "));
    },
  );

  assert.equal(invocation, null);
  assert.deepEqual(messages, [
    "Error: Could not find `agentfiles` on PATH, and no npm-backed fallback is available.",
  ]);
});

test("isDirectExecution returns true for a symlinked path to the runner", () => {
  const targetPath = fileURLToPath(new URL("./run-agentfiles.js", import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), "agentfiles-skill-runner-"));
  const symlinkPath = join(directory, "runner-link.js");

  try {
    symlinkSync(targetPath, symlinkPath);

    assert.equal(
      isDirectExecution(symlinkPath, pathToFileURL(targetPath).href),
      true,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("isDirectExecution returns false for a different file", () => {
  const targetPath = fileURLToPath(new URL("./run-agentfiles.js", import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), "agentfiles-skill-runner-"));
  const otherPath = join(directory, "other.js");

  try {
    writeFileSync(otherPath, "");

    assert.equal(
      isDirectExecution(otherPath, pathToFileURL(targetPath).href),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
