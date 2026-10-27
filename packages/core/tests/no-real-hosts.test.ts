import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error módulo .mjs de scripts/ sem declaração de tipos
import { acharViolacoes, carregarPadroesExternos, imagensSemRevisao, varrerRepositorio } from "../../../scripts/check-no-real-hosts.mjs";

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

describe("check-no-real-hosts: hostname de provedor e IPv6", () => {
  it("reprova vmi + dígitos, mas aceita o valor fictício dos testes", () => {
    expect(reprova(`root@vmi${"3000000"}`)).toBe(1);
    expect(reprova(`host vmi${"1234567"} e vmi${"0000000"}`)).toBe(0);
    expect(reprova("vmi")).toBe(0);
  });

  it("reprova IPv6 público, completo ou abreviado", () => {
    expect(reprova(`ip ${["2a01", "4f8", "1", "2", "", "3"].join(":")} fim`)).toBe(1);
    expect(reprova(["2a01", "4f8", "0", "0", "0", "0", "0", "9"].join(":"))).toBe(1);
    expect(reprova(`[${["2a01", "4f8", "", "9"].join(":")}]:443`)).toBe(1);
  });

  it("aceita IPv6 de documentação, loopback, ULA, link-local, Cloudflare e IPv4 mapeado permitido", () => {
    const ok = ["2001:db8::1", "::1", "::", "fe80::1", "fd12:3456::1", "2606:4700::1", "::ffff:8.8.8.8", "::ffff:102:304"].join(" ");
    expect(reprova(ok)).toBe(0);
    expect(reprova("12:30:45 e aa:bb:cc:dd:ee:ff e [::]::5432 e Foo::bar")).toBe(0);
  });

  it("IPv4 mapeado vale a regra do IPv4 embutido", () => {
    expect(reprova(`::ffff:${ip(93, 184, 216, 34).split(".").map(Number).reduce((a: string[], n, i, arr) => (i % 2 ? a : [...a, ((n << 8) | arr[i + 1]).toString(16)]), []).join(":")}`)).toBe(1);
  });
});

describe("check-no-real-hosts: padrões externos", () => {
  const padroes = carregarPadroesExternos("/nao-existe", { CHECK_REAL_HOSTS_PATTERNS: "zzcliente\\w*;;(?:outro-nome)\n# comentário" });

  it("lê regex da variável de ambiente, ignorando vazios e comentários", () => {
    expect(padroes).toHaveLength(2);
  });

  it("reprova pelo padrão, sem diferenciar maiúsculas, e a saída não repete o valor", () => {
    const v = acharViolacoes("projeto ZZClienteX aqui", "a.txt", padroes);
    expect(v).toEqual(["a.txt:1  padrão externo nº 1"]);
    expect(acharViolacoes("tudo neutro", "a.txt", padroes)).toEqual([]);
  });

  it("lê também o arquivo apontado e recusa regex inválido", () => {
    const dir = mkdtempSync(join(tmpdir(), "hosts-"));
    try {
      writeFileSync(join(dir, "padroes.txt"), "# lista\nzzoutro\n");
      expect(carregarPadroesExternos(dir, { CHECK_REAL_HOSTS_FILE: join(dir, "padroes.txt") })).toHaveLength(1);
      writeFileSync(join(dir, ".check-real-hosts.local"), "zzlocal\n");
      expect(carregarPadroesExternos(dir, {})).toHaveLength(1);
      expect(carregarPadroesExternos(join(dir, "vazio"), {})).toEqual([]);
      expect(() => carregarPadroesExternos(dir, { CHECK_REAL_HOSTS_PATTERNS: "(" })).toThrow(/inválido/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a varredura também confere o nome do arquivo", () => {
    const dir = mkdtempSync(join(tmpdir(), "hosts-"));
    try {
      writeFileSync(join(dir, "zzcliente-ledger.txt"), "neutro\n");
      const achados = varrerRepositorio(dir, { ci: false, padroes });
      expect(achados).toHaveLength(1);
      expect(achados[0]).toContain("nome do arquivo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("check-no-real-hosts: erro de regex externo", () => {
  it("regex inválido não repete o padrão na mensagem de erro", () => {
    let msg = "";
    try {
      carregarPadroesExternos("/nao-existe", { CHECK_REAL_HOSTS_PATTERNS: "zzsegredo(" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/padrão externo 1 inválido/);
    expect(msg).not.toContain("zzsegredo");
  });

  it("aceita vários padrões numa linha só separados por ;;, com espaços e vazios, e também um por linha", () => {
    const umaLinha = carregarPadroesExternos("/nao-existe", { CHECK_REAL_HOSTS_PATTERNS: "zzum ;; zzdois;;;; zztres\\.br " });
    expect(umaLinha).toHaveLength(3);
    expect(acharViolacoes("x ZZDois y", "a.txt", umaLinha)).toEqual(["a.txt:1  padrão externo nº 2"]);
    expect(acharViolacoes("zztres.br", "a.txt", umaLinha)).toHaveLength(1);
    expect(acharViolacoes("zztresXbr", "a.txt", umaLinha)).toEqual([]);
    expect(carregarPadroesExternos("/nao-existe", { CHECK_REAL_HOSTS_PATTERNS: "zzum\nzzdois" })).toHaveLength(2);
  });

  it("sem padrões (PR de fork, sem o secret) não falha e não acusa nada", () => {
    expect(carregarPadroesExternos("/nao-existe", {})).toEqual([]);
    expect(acharViolacoes("zzcliente em qualquer lugar", "a.txt", [])).toEqual([]);
  });

  it("um regex sem \\b pega o termo colado em outras palavras", () => {
    const padroes = carregarPadroesExternos("/nao-existe", { CHECK_REAL_HOSTS_PATTERNS: "zzcliente" });
    for (const t of ["zzcliente", "ZZCliente", "paas-zzcliente-web-1", "zzclienteWallet", "umzzcliente"]) {
      expect(acharViolacoes(t, "a.txt", padroes), t).toHaveLength(1);
    }
  });
});

describe("check-no-real-hosts: IPv6 exato dos testes", () => {
  it("aceita só os endereços exatos usados como exemplo, não o bloco inteiro", () => {
    expect(reprova(["2a00", "1450", "", "1"].join(":"))).toBe(0);
    expect(reprova(["2804", "14c", "", "1"].join(":"))).toBe(0);
    expect(reprova(["2804", "14c", "", "2"].join(":"))).toBe(1);
    expect(reprova(["2a00", "1450", "", "abcd"].join(":"))).toBe(1);
  });
});

describe("check-no-real-hosts: imagens", () => {
  it("avisa de imagem sem hash em scripts/imagens-revisadas.txt e silencia a revisada", () => {
    const dir = mkdtempSync(join(tmpdir(), "hosts-"));
    try {
      writeFileSync(join(dir, "a.png"), "conteudo-a");
      writeFileSync(join(dir, "b.JPG"), "conteudo-b");
      writeFileSync(join(dir, "c.txt"), "nao e imagem");
      const antes = imagensSemRevisao(dir, { ci: false });
      expect(antes.map((i: { caminho: string }) => i.caminho).sort()).toEqual(["a.png", "b.JPG"]);
      mkdirSync(join(dir, "scripts"));
      const a = antes.find((i: { caminho: string }) => i.caminho === "a.png");
      writeFileSync(join(dir, "scripts", "imagens-revisadas.txt"), `# revisadas\n${a.hash}  a.png\n`);
      expect(imagensSemRevisao(dir, { ci: false }).map((i: { caminho: string }) => i.caminho)).toEqual(["b.JPG"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no repositório, toda imagem versionada está marcada como revisada", () => {
    expect(imagensSemRevisao()).toEqual([]);
  });
});

describe("check-no-real-hosts: varredura", () => {
  it("o repositório contém apenas valores de exemplo", { timeout: 60000 }, () => {
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
