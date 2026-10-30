/**
 * O instalador confere o plugin buildx do Docker da VPS e, se faltar, instala o pacote certo pela origem do
 * Docker. Execução REAL da função ensure_host_buildx extraída do install.sh, com docker/dpkg/apt-get/snap
 * falsos no PATH (o instalador inteiro não roda aqui).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeDirSync } from "./helpers/tmp.js";

const raiz = path.resolve(__dirname, "../../..");
const sh = readFileSync(path.join(raiz, "scripts/install.sh"), "utf8");
const funcao = sh.match(/^ensure_host_buildx\(\) \{[\s\S]*?^\}/m)?.[0] ?? "";

const pastas: string[] = [];
afterEach(() => {
  for (const p of pastas.splice(0)) removeDirSync(p);
});

function falso(dir: string, nome: string, corpo: string) {
  const arquivo = path.join(dir, nome);
  writeFileSync(arquivo, `#!/bin/bash\n${corpo}\n`);
  chmodSync(arquivo, 0o755);
}

interface Cenario {
  /** o buildx já responde antes de qualquer instalação */
  buildxJa?: boolean;
  origem: "docker-ce" | "docker.io" | "snap" | "nenhuma";
  /** o apt-get instala de verdade (cria o marcador) */
  aptFunciona?: boolean;
}

function rodar(c: Cenario) {
  expect(funcao, "ensure_host_buildx não encontrada no install.sh").not.toBe("");
  const dir = mkdtempSync(path.join(tmpdir(), "buildx-install-"));
  pastas.push(dir);
  const marcador = path.join(dir, "buildx-instalado");
  const aptLog = path.join(dir, "apt.log");
  if (c.buildxJa) writeFileSync(marcador, "");
  falso(dir, "docker", `[ "$1 $2" = "buildx version" ] && [ -e "${marcador}" ] && { echo "docker/buildx v0.38.1"; exit 0; }; exit 1`);
  falso(dir, "dpkg", `[ "$1" = "-s" ] && [ "$2" = "${c.origem}" ] && exit 0; exit 1`);
  falso(dir, "snap", `[ "$1" = "list" ] && [ "${c.origem}" = "snap" ] && exit 0; exit 1`);
  falso(dir, "apt-get", `echo "$@" >> "${aptLog}"; ${c.aptFunciona ? `touch "${marcador}"` : "exit 100"}; exit 0`);
  const r = spawnSync(
    "bash",
    ["-c", `log() { echo "LOG $*"; }; warn() { echo "AVISO $*"; }\n${funcao}\nensure_host_buildx`],
    { encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin` } },
  );
  return { r, out: r.stdout, apt: existsSync(aptLog) ? readFileSync(aptLog, "utf8") : "" };
}

describe("install.sh — buildx do Docker da VPS", () => {
  it("já instalado: só informa e não mexe em nada", () => {
    const { r, out, apt } = rodar({ buildxJa: true, origem: "docker-ce" });
    expect(r.status).toBe(0);
    expect(out).toContain("LOG Docker buildx já instalado: docker/buildx v0.38.1");
    expect(apt).toBe("");
  });

  it("docker-ce sem buildx: instala docker-buildx-plugin e confere", () => {
    const { r, out, apt } = rodar({ origem: "docker-ce", aptFunciona: true });
    expect(r.status).toBe(0);
    expect(apt).toContain("install -y -qq docker-buildx-plugin");
    expect(out).toContain("LOG buildx instalado: docker/buildx v0.38.1");
  });

  it("docker.io do Ubuntu sem buildx: instala docker-buildx", () => {
    const { r, apt } = rodar({ origem: "docker.io", aptFunciona: true });
    expect(r.status).toBe(0);
    expect(apt).toContain("install -y -qq docker-buildx\n");
  });

  it("apt que falha: avisa com o comando manual e NÃO aborta a instalação", () => {
    const { r, out } = rodar({ origem: "docker-ce", aptFunciona: false });
    expect(r.status).toBe(0);
    expect(out).toContain("AVISO Não consegui instalar o buildx. Rode por SSH: sudo apt-get update && sudo apt-get install -y docker-buildx-plugin");
  });

  it("snap: não instala, orienta atualizar o snap", () => {
    const { r, out, apt } = rodar({ origem: "snap" });
    expect(r.status).toBe(0);
    expect(out).toContain("sudo snap refresh docker");
    expect(apt).toBe("");
  });

  it("origem não reconhecida: não instala, lista os dois pacotes", () => {
    const { r, out, apt } = rodar({ origem: "nenhuma" });
    expect(r.status).toBe(0);
    expect(out).toContain("docker-buildx-plugin");
    expect(out).toContain("docker-buildx (docker.io");
    expect(apt).toBe("");
  });
});

describe("Dockerfile do painel — buildx no CLI que faz os deploys", () => {
  const dockerfile = readFileSync(path.join(raiz, "Dockerfile"), "utf8");
  it("baixa o buildx de versão fixa, confere o sha256 e o torna executável", () => {
    expect(dockerfile).toMatch(/ARG BUILDX_VERSION=\d+\.\d+\.\d+/);
    expect(dockerfile).toMatch(/ARG BUILDX_SHA256=[0-9a-f]{64}/);
    expect(dockerfile).toContain("/usr/local/libexec/docker/cli-plugins/docker-buildx");
    expect(dockerfile).toMatch(/echo "\$\{BUILDX_SHA256\} {2}\/usr\/local\/libexec\/docker\/cli-plugins\/docker-buildx" \| sha256sum -c -/);
    expect(dockerfile).toMatch(/chmod \+x [^\n]*docker-buildx/);
  });
});
