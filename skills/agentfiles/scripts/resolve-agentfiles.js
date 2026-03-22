#!/usr/bin/env node

import { accessSync, constants, existsSync } from "node:fs";
import { dirname, delimiter, join, resolve } from "node:path";

function canExecute(filePath) {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveWindowsCandidates(name, env) {
  const extensions = (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);

  if (/\.[^./\\]+$/.test(name)) {
    return [name];
  }

  return [name, ...extensions.map((extension) => `${name}${extension.toLowerCase()}`)];
}

export function resolveNpmCliScript(execPath = process.execPath) {
  const execDir = dirname(execPath);
  const candidates = [
    resolve(execDir, "../lib/node_modules/npm/bin/npm-cli.js"),
    resolve(execDir, "../node_modules/npm/bin/npm-cli.js"),
    resolve(execDir, "node_modules/npm/bin/npm-cli.js"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveExecutable(name, env = process.env, platform = process.platform) {
  const pathValue = env.PATH ?? "";
  if (!pathValue) {
    return null;
  }

  const directories = pathValue.split(delimiter).filter(Boolean);
  const candidates =
    platform === "win32" ? resolveWindowsCandidates(name, env) : [name];

  for (const directory of directories) {
    for (const candidate of candidates) {
      const candidatePath = join(directory, candidate);
      if (canExecute(candidatePath)) {
        return candidatePath;
      }
    }
  }

  return null;
}

export function resolveAgentfilesInvocation(
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
) {
  const agentfilesPath = resolveExecutable("agentfiles", env, platform);
  if (agentfilesPath) {
    return {
      source: "path",
      command: agentfilesPath,
      args: [],
      display: "agentfiles",
    };
  }

  const npmCliPath = resolveNpmCliScript(execPath);
  if (npmCliPath) {
    return {
      source: "npm-exec",
      command: execPath,
      args: [
        npmCliPath,
        "exec",
        "--yes",
        "--package",
        "agentfiles-cli",
        "--",
        "agentfiles",
      ],
      display: "npm exec --yes --package agentfiles-cli -- agentfiles",
    };
  }

  const npxPath = resolveExecutable("npx", env, platform);
  if (npxPath) {
    return {
      source: "npx",
      command: npxPath,
      args: ["-y", "agentfiles-cli"],
      display: "npx -y agentfiles-cli",
      needsShell:
        platform === "win32" && /\.(cmd|bat)$/i.test(npxPath),
    };
  }

  throw new Error(
    "Could not find `agentfiles` on PATH, and no npm-backed fallback is available. Install `agentfiles-cli` globally or provide npm/npx.",
  );
}
