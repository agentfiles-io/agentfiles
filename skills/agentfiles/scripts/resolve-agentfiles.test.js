import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  resolveAgentfilesInvocation,
  resolveExecutable,
  resolveNpmCliScript,
} from "./resolve-agentfiles.js";

function createExecutable(directory, name) {
  const filePath = join(directory, name);
  writeFileSync(filePath, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(filePath, 0o755);
  return filePath;
}

test("resolveExecutable returns null when PATH is empty", () => {
  assert.equal(resolveExecutable("agentfiles", { PATH: "" }), null);
});

test("resolveAgentfilesInvocation prefers a local agentfiles binary", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentfiles-skill-"));

  try {
    const binaryPath = createExecutable(directory, "agentfiles");
    const invocation = resolveAgentfilesInvocation({ PATH: directory }, process.platform);

    assert.equal(invocation.source, "path");
    assert.equal(invocation.command, binaryPath);
    assert.deepEqual(invocation.args, []);
    assert.equal(invocation.display, "agentfiles");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resolveAgentfilesInvocation falls back to npx when agentfiles is absent", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentfiles-skill-"));

  try {
    const npxPath = createExecutable(directory, "npx");
    const invocation = resolveAgentfilesInvocation(
      { PATH: directory },
      process.platform,
      join(tmpdir(), "missing-node", "bin", "node"),
    );

    assert.equal(invocation.source, "npx");
    assert.equal(invocation.command, npxPath);
    assert.deepEqual(invocation.args, ["-y", "agentfiles-cli"]);
    assert.equal(invocation.display, "npx -y agentfiles-cli");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resolveNpmCliScript finds npm-cli.js next to a node installation", () => {
  const root = mkdtempSync(join(tmpdir(), "agentfiles-skill-"));
  const execPath = join(root, "bin", "node");
  const npmCliPath = join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js");

  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "lib", "node_modules", "npm", "bin"), {
      recursive: true,
    });
    writeFileSync(execPath, "");
    writeFileSync(npmCliPath, "");

    assert.equal(resolveNpmCliScript(execPath), npmCliPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveAgentfilesInvocation falls back to npm exec when npm-cli.js is available", () => {
  const root = mkdtempSync(join(tmpdir(), "agentfiles-skill-"));
  const execPath = join(root, "bin", "node");
  const npmCliPath = join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js");

  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "lib", "node_modules", "npm", "bin"), {
      recursive: true,
    });
    writeFileSync(execPath, "");
    writeFileSync(npmCliPath, "");

    const invocation = resolveAgentfilesInvocation(
      { PATH: "" },
      process.platform,
      execPath,
    );

    assert.equal(invocation.source, "npm-exec");
    assert.equal(invocation.command, execPath);
    assert.deepEqual(invocation.args, [
      npmCliPath,
      "exec",
      "--yes",
      "--package",
      "agentfiles-cli",
      "--",
      "agentfiles",
    ]);
    assert.equal(
      invocation.display,
      "npm exec --yes --package agentfiles-cli -- agentfiles",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveAgentfilesInvocation marks npx.cmd as shell-backed on Windows", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentfiles-skill-"));

  try {
    const npxPath = createExecutable(directory, "npx.cmd");
    const invocation = resolveAgentfilesInvocation(
      { PATH: directory, PATHEXT: ".CMD" },
      "win32",
      join(tmpdir(), "missing-node", "node.exe"),
    );

    assert.equal(invocation.source, "npx");
    assert.equal(invocation.command, npxPath);
    assert.equal(invocation.needsShell, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resolveAgentfilesInvocation throws when neither agentfiles nor a fallback is available", () => {
  assert.throws(
    () =>
      resolveAgentfilesInvocation(
        { PATH: join(tmpdir(), "missing-agentfiles-path") },
        process.platform,
        join(tmpdir(), "missing-node", "bin", "node"),
      ),
    /Could not find `agentfiles` on PATH, and no npm-backed fallback is available/,
  );
});
