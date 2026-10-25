import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error módulo .mjs de scripts/ sem declaração de tipos
import { acharViolacoes, varrerRepositorio } from "../../../scripts/check-no-real-hosts.mjs";

// Os valores reprovados são montados aqui para este arquivo não conter nenhum deles por extenso.
const ip = (...p: Array<number | string>) => p.join(".");
const PUBLICO = ip(93, 184, 216, 34);
const OUTRO = ip(45, 33, 32, 156);
const zona = "tws" + ".tec.br";
const reprova = (texto: string) => acharViolacoes(texto).length;

describe("check-no-real-hosts: domínios", () => {
  it("reprova subdomínio, curinga, sublinhado e ponto solto antes da zona", () => {
    expect(reprova(`a.${zona}`)).toBe(1);
    expect(reprova(`*.${zona}`)).toBe(1);
    expect(reprova(`a_b.${zona}`)).toBe(1);
    expect(reprova(`x.y.${zona}`)).toBe(1);
    expect(reprova(`".${zona}"`)).toBe(1);
  });

  it("reprova e-mail da empresa que não seja o contato, e aceita o contato e o link institucional", () => {
    expect(reprova(`dono@${zona}`)).toBe(1);
    expect(reprova(`contato@${zona} https://${zona}/ [${zona}](https://${zona}/)`)).toBe(0);
  });
});

describe("check-no-real-hosts: IPv4", () => {
  it("reprova IP público no meio, no fim de frase e depois de reticências", () => {
    expect(reprova(`ip ${PUBLICO} fim`)).toBe(1);
    expect(reprova(`o IP é ${OUTRO}.`)).toBe(1);
    expect(reprova(`...${PUBLICO}`)).toBe(1);
    expect(reprova(`(${PUBLICO}),`)).toBe(1);
    expect(reprova(`${PUBLICO}/24`)).toBe(1);
  });

  it("reprova IP embutido em sslip.io/nip.io/traefik.me, com ponto ou hífen, com ou sem prefixo", () => {
    const h = OUTRO.replaceAll(".", "-");
    expect(reprova(`${PUBLICO}.sslip.io`)).toBe(1);
    expect(reprova(`${h}.sslip.io`)).toBe(1);
    expect(reprova(`app.${h}.nip.io`)).toBe(1);
    expect(reprova(`app-${h}.sslip.io`)).toBe(1);
    expect(reprova(`www.app-${h}.nip.io`)).toBe(1);
    expect(reprova(`app-${OUTRO}.nip.io`)).toBe(1);
    expect(reprova(`${h}.traefik.me`)).toBe(1);
    expect(reprova(`app-${h}.traefik.me`)).toBe(1);
    expect(reprova(`${OUTRO}.traefik.me`)).toBe(1);
  });

  it("aceita sslip.io/nip.io/traefik.me com IP de documentação e números que não são IP", () => {
    expect(reprova("loja.203-0-113-10.sslip.io")).toBe(0);
    expect(reprova("loja.203.0.113.10.sslip.io")).toBe(0);
    expect(reprova("app-203-0-113-10.nip.io www.app-198-51-100-6.sslip.io app-203-0-113-10.traefik.me")).toBe(0);
    expect(reprova(`${OUTRO.replaceAll(".", "-")}.exemplo.test`)).toBe(0);
    expect(reprova(`versão ${ip(1, 2, 3, 4, 5)} e ${ip(300, 1, 1, 1)} e 2026-10-20-15`)).toBe(0);
  });

  it("aceita documentação, privadas, loopback, link-local e DNS públicos, inclusive no fim de frase", () => {
    const ok = [ip(203, 0, 113, 7), ip(198, 51, 100, 1), ip(192, 0, 2, 1), ip(127, 0, 0, 1), ip(10, 0, 0, 1),
      ip(192, 168, 1, 1), ip(172, 16, 0, 1), ip(169, 254, 1, 1), ip(1, 1, 1, 1), ip(8, 8, 8, 8)].join(" ");
    expect(reprova(ok)).toBe(0);
    expect(reprova(`o IP é ${ip(203, 0, 113, 7)}.`)).toBe(0);
  });

  it("compara as faixas da Cloudflare por CIDR, não por prefixo de texto", () => {
    for (const dentro of [ip(104, 21, 32, 1), ip(172, 67, 150, 2), ip(131, 0, 72, 5), ip(173, 245, 48, 9), ip(103, 21, 244, 1), ip(190, 93, 240, 1)]) {
      expect(reprova(dentro)).toBe(0);
    }
    for (const fora of [ip(104, 32, 0, 1), ip(131, 0, 1, 1), ip(173, 245, 1, 1), ip(103, 21, 1, 1), ip(190, 93, 1, 1), ip(172, 72, 0, 1)]) {
      expect(reprova(fora)).toBe(1);
    }
  });
});

describe("check-no-real-hosts: varredura", () => {
  it("o repositório contém apenas valores de exemplo", () => {
    expect(varrerRepositorio()).toEqual([]);
  });

  it("sem git, percorre a árvore ignorando node_modules, dist, coverage e .git; no CI falha", () => {
    const dir = mkdtempSync(join(tmpdir(), "hosts-"));
    try {
      mkdirSync(join(dir, "src"));
      mkdirSync(join(dir, "node_modules"));
      mkdirSync(join(dir, "dist"));
      writeFileSync(join(dir, "src", "a.txt"), `host a.${zona}\n`);
      writeFileSync(join(dir, "node_modules", "b.txt"), `host b.${zona}\n`);
      writeFileSync(join(dir, "dist", "c.txt"), `ip ${PUBLICO}\n`);
      const achados = varrerRepositorio(dir, { ci: false });
      expect(achados).toHaveLength(1);
      expect(achados[0]).toContain("src/a.txt:1");
      expect(() => varrerRepositorio(dir, { ci: true })).toThrow(/git indisponível/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("com GIT_DIR/GIT_WORK_TREE herdados (hook em worktree) ainda não usa o git de outro repositório", () => {
    const dir = mkdtempSync(join(tmpdir(), "hosts-"));
    const antes = { d: process.env.GIT_DIR, w: process.env.GIT_WORK_TREE, i: process.env.GIT_INDEX_FILE };
    try {
      writeFileSync(join(dir, "a.txt"), `host a.${zona}\n`);
      process.env.GIT_DIR = join(process.cwd(), "..", "..", ".git");
      process.env.GIT_WORK_TREE = process.cwd();
      process.env.GIT_INDEX_FILE = join(dir, "index-que-nao-existe");
      const achados = varrerRepositorio(dir, { ci: false });
      expect(achados).toHaveLength(1);
      expect(achados[0]).toContain("a.txt:1");
    } finally {
      for (const [k, v] of [["GIT_DIR", antes.d], ["GIT_WORK_TREE", antes.w], ["GIT_INDEX_FILE", antes.i]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
