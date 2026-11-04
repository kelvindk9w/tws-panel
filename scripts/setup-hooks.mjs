#!/usr/bin/env node
/**
 * Activates the versioned git hooks after `pnpm install` (via the root
 * `prepare` script). Points `core.hooksPath` at scripts/hooks so every
 * contributor gets the same pre-commit/pre-push validation without any
 * extra dependency (no husky).
 *
 * Fails silently when not inside a git repo (e.g. installing from a
 * tarball or inside some CI containers) so installs never break.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";

const HOOKS_DIR = "scripts/hooks";

try {
  execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
  execFileSync("git", ["config", "core.hooksPath", HOOKS_DIR], { stdio: "ignore" });
  for (const hook of readdirSync(HOOKS_DIR)) {
    if (hook.endsWith(".mjs")) continue; // helpers are invoked, not executed
    chmodSync(join(HOOKS_DIR, hook), 0o755);
  }
  console.log(`[setup-hooks] git hooks activated (core.hooksPath=${HOOKS_DIR})`);
} catch {
  // Not a git repo or git unavailable — nothing to do.
}
