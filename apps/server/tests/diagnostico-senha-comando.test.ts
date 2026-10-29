/**
 * O comando de diagnóstico do guia de restauração (pt-br e en) compara a senha
 * de administração do config.toml do contêiner com a do painel e imprime só
 * "iguais", "diferentes" ou "não deu para ler (rode com sudo?)". Aqui o texto
 * EXATO do guia roda de verdade com `sudo`, `docker` e `node` de mentira no PATH.
 */
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
let dir = "";

async function commandOf(lang: "pt-br" | "en"): Promise<string> {
  const md = await readFile(path.join(ROOT, `site/src/content/docs/${lang}/guides/restore-new-server.md`), "utf8");
  const start = md.indexOf("  ```bash\n  # comp");
  const body = md.slice(md.indexOf("\n", start) + 1, md.indexOf("  ```\n", start + 5));
  return body
    .split("\n")
    .map((l) => l.replace(/^ {2}/, ""))
    .join("\n");
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-diag-"));
  await mkdir(path.join(dir, "bin"));
  // sudo repassa; docker lê "o que o contêiner tem" e "o que o painel tem" de arquivos (ausentes = não deu para ler)
  await writeFile(path.join(dir, "bin", "sudo"), '#!/bin/bash\nexec "$@"\n');
  await writeFile(
    path.join(dir, "bin", "docker"),
    `#!/bin/bash
if [ "$1" = "cp" ]; then
  [ -f "$FAKE_TOML" ] || { echo "Error: No such container" >&2; exit 1; }
  tar -C "$(dirname "$FAKE_TOML")" -cf - "$(basename "$FAKE_TOML")"
elif [ "$1" = "exec" ]; then
  [ -f "$FAKE_MAIL" ] || { echo "permission denied" >&2; exit 1; }
  node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.env.FAKE_MAIL,'utf8')).adminSecret)"
fi
`,
  );
  await chmod(path.join(dir, "bin", "sudo"), 0o755);
  await chmod(path.join(dir, "bin", "docker"), 0o755);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function run(lang: "pt-br" | "en", toml: string | null, mail: object | null): Promise<string> {
  if (toml !== null) await writeFile(path.join(dir, "config.toml"), toml);
  if (mail !== null) await writeFile(path.join(dir, "mail.json"), JSON.stringify(mail));
  const script = await commandOf(lang);
  // o docker de mentira troca o caminho dentro do contêiner pelo arquivo local; o comando do guia fica como está
  return execFileSync("bash", ["-c", script], {
    env: { PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, FAKE_TOML: path.join(dir, "config.toml"), FAKE_MAIL: path.join(dir, "mail.json") },
    encoding: "utf8",
  }).trim();
}

const toml = (secret: string) => `[authentication.fallback-admin]\nuser = "admin"\nsecret = "${secret}"\n`;

describe.each(["pt-br", "en"] as const)("comando de diagnóstico do guia (%s)", (lang) => {
  it("senhas iguais (com caracteres especiais): iguais", async () => {
    const secret = "aB+/=$x'y&z 9";
    expect(await run(lang, toml(secret), { adminSecret: secret })).toBe("iguais");
  });
  it("senhas diferentes: diferentes", async () => {
    expect(await run(lang, toml("um"), { adminSecret: "outro" })).toBe("diferentes");
  });
  it("não leu nenhum dos dois lados (sem sudo, contêineres ausentes): não deu para ler", async () => {
    expect(await run(lang, null, null)).toBe("não deu para ler (rode com sudo?)");
  });
  it("config.toml sem a linha secret e adminSecret nulo: não deu para ler", async () => {
    expect(await run(lang, "[server]\n", { adminSecret: null })).toBe("não deu para ler (rode com sudo?)");
  });
  it("lê só um lado: não deu para ler (nunca iguais)", async () => {
    expect(await run(lang, toml("um"), null)).toBe("não deu para ler (rode com sudo?)");
  });
  it("nunca imprime a senha", async () => {
    expect(await run(lang, toml("segredo-forte"), { adminSecret: "segredo-forte" })).not.toContain("segredo");
  });
});
