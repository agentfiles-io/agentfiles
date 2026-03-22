#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveAgentfilesInvocation } from "./resolve-agentfiles.js";

const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
};

export function resolveInvocationOrReport(
  resolveInvocation = resolveAgentfilesInvocation,
  log = console.error,
) {
  try {
    return resolveInvocation();
  } catch (error) {
    log("Error:", error instanceof Error ? error.message : String(error));
    return null;
  }
}

export function isDirectExecution(
  scriptArg = process.argv[1],
  metaUrl = import.meta.url,
  realpath = realpathSync,
) {
  if (!scriptArg) {
    return false;
  }

  try {
    return realpath(scriptArg) === realpath(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

function run() {
  const passthroughArgs = process.argv.slice(2);
  const invocation = resolveInvocationOrReport();
  if (!invocation) {
    process.exit(1);
  }

  const child = spawn(
    invocation.command,
    [...invocation.args, ...(passthroughArgs.length > 0 ? passthroughArgs : ["--help"])],
    {
      shell: invocation.needsShell === true,
      stdio: "inherit",
      env: {
        ...process.env,
        AGENTFILES_SKILL: "1",
      },
    },
  );

  const forwardSignal = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };

  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  child.once("error", (error) => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    console.error("Error:", error.message);
    process.exit(1);
  });

  child.once("exit", (code, signal) => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);

    if (signal) {
      process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
      return;
    }

    process.exit(code ?? 1);
  });
}

if (isDirectExecution()) {
  run();
}
