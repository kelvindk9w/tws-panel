#!/usr/bin/env node
/**
 * Lightweight secret scanner for staged files (pre-commit hook).
 *
 * Scans the files passed as arguments and reports findings as
 * `file:line: rule-name`. Exits 1 if any potential secret is found.
 *
 * Intentionally dependency-free (no gitleaks) to keep the repo at zero
 * new system dependencies. For deeper scans, install gitleaks locally —
 * it is the recommended optional complement (see CONTRIBUTING.md).
 */
import { readFileSync } from "node:fs";

// [name, regex]
const RULES = [
  ["aws-access-key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["private-key-block", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/],
  ["slack-token", /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/],
  ["generic-api-key-assignment", /\b(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["'][A-Za-z0-9_\-/.+]{20,}["']/i],
  ["password-assignment", /\b(?:password|passwd|senha)\b\s*[:=]\s*["'][^"'\s]{8,}["']/i],
];

// Placeholders that are safe by definition (docs, examples, tests).
const ALLOWLIST = [
  /placeholder/i,
  /changeme/i,
  /your[_-]/i,
  /x{4,}/i,
  /\*{4,}/,
];

let findings = 0;

for (const file of process.argv.slice(2)) {
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue; // deleted or unreadable — nothing to scan
  }
  if (content.includes("\0")) continue; // skip binary files

  // Arquivos de teste declaram senhas fictícias o tempo todo ("MinhaSenha123").
  // A regra de senha é dispensada neles — mas SÓ ela: token do GitHub, chave de
  // API e credencial de nuvem continuam sendo detectados em qualquer arquivo,
  // porque um segredo real vazado num teste é tão grave quanto em produção.
  const isTestFile = /(^|\/)tests?\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [name, re] of RULES) {
      if (isTestFile && name === "password-assignment") continue;
      const match = line.match(re);
      if (!match) continue;
      if (ALLOWLIST.some((safe) => safe.test(line))) continue;
      console.error(`  ${file}:${i + 1}: ${name} — matched "${match[0].slice(0, 12)}…"`);
      findings++;
    }
  }
}

process.exit(findings > 0 ? 1 : 0);
