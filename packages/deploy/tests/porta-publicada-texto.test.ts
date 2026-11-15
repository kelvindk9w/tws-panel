/**
 * Texto dos avisos de porta publicada (internal-port-exposed e public-port-published): dizem a verdade sobre
 * onde a porta fica. "Todas as interfaces" só para endereço vazio, 0.0.0.0 ou ::; loopback é "só a própria VPS";
 * endereço vindo de variável diz o padrão do compose e que a variável pode mudá-lo. A decisão (bloquear ou
 * avisar) não muda: continua com bindScope.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeCompose } from "../src/guardrails.js";
import { bindInfo, bindPhrase, formatPortMapping, publishedPorts } from "../src/compose-ports.js";
import { runGuardrails } from "../src/rules.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-porta-texto-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function achados(body: string) {
  await writeFile(path.join(dir, "compose.yml"), `services:\n${body}\n`);
  const report = await runGuardrails(dir);
  return {
    internas: report.findings.filter((f) => f.rule === "internal-port-exposed"),
    publicas: report.findings.filter((f) => f.rule === "public-port-published"),
  };
}

/** Uma porta interna (Mailpit 8025) publicada com o endereço dado, na forma curta. */
async function mailpit(ip: string) {
  const r = await achados(`  mail:\n    image: axllent/mailpit:1\n    ports: ["${ip}:8025:8025"]`);
  expect(r.internas).toHaveLength(1);
  return r.internas[0]!;
}

describe("bindInfo e bindPhrase: onde a porta fica", () => {
  it.each([
    [null, "all"],
    ["", "all"],
    ["0.0.0.0", "all"],
    ["::", "all"],
    ["[::]", "all"],
    ["0:0:0:0:0:0:0:0", "all"],
  ])("%s é todas as interfaces", (ip, kind) => {
    expect(bindInfo(ip).kind).toBe(kind);
    expect(bindInfo(ip).variable).toBeNull();
    expect(bindPhrase(ip)).toBe("em todas as interfaces do servidor");
  });

  it.each(["127.0.0.1", "127.0.0.2", "::1", "[::1]", "localhost"])("%s é só a própria VPS", (ip) => {
    expect(bindInfo(ip).kind).toBe("loopback");
    expect(bindPhrase(ip)).toMatch(/^só na própria VPS \(/);
    expect(bindPhrase(ip)).not.toContain("todas as interfaces");
  });

  it("IP específico fora do loopback é aquele endereço, não todas as interfaces", () => {
    expect(bindInfo("192.0.2.10")).toEqual({ kind: "address", address: "192.0.2.10", variable: null });
    expect(bindPhrase("192.0.2.10")).toBe("no endereço 192.0.2.10 do servidor");
  });

  it("variável com padrão loopback (${VAR:-127.0.0.1} e ${VAR-127.0.0.1}): diz o padrão e que a variável pode mudá-lo", () => {
    for (const ip of ["${DEV_BIND:-127.0.0.1}", "${DEV_BIND-127.0.0.1}", " ${DEV_BIND:- 127.0.0.1 } "]) {
      expect(bindInfo(ip)).toEqual({ kind: "loopback", address: "127.0.0.1", variable: "DEV_BIND" });
      expect(bindPhrase(ip)).toBe(
        "no endereço da variável DEV_BIND, que por padrão é 127.0.0.1 (só a própria VPS); a variável pode mudá-lo",
      );
    }
  });

  it("variável com padrão 0.0.0.0, :: ou vazio: o padrão é todas as interfaces", () => {
    expect(bindPhrase("${BIND:-0.0.0.0}")).toBe(
      "no endereço da variável BIND, que por padrão é 0.0.0.0 (todas as interfaces do servidor); a variável pode mudá-lo",
    );
    expect(bindInfo("${BIND:-::}").kind).toBe("all");
    expect(bindInfo("${BIND:-[::]}")).toEqual({ kind: "all", address: "::", variable: "BIND" });
    expect(bindPhrase("${BIND:-}")).toContain("por padrão é vazio (todas as interfaces do servidor)");
  });

  it("variável com padrão num IP específico", () => {
    expect(bindPhrase("${BIND:-192.0.2.10}")).toBe(
      "no endereço da variável BIND, que por padrão é 192.0.2.10 (um endereço do servidor); a variável pode mudá-lo",
    );
  });

  it.each(["${BIND}", "$BIND", "${BIND:?defina o endereço}", "${BIND?defina}"])("variável sem padrão (%s)", (ip) => {
    expect(bindInfo(ip)).toEqual({ kind: null, address: "", variable: "BIND" });
    expect(bindPhrase(ip)).toBe("no endereço da variável BIND, sem valor padrão no compose");
  });

  it("interpolação composta (padrão com outra variável) não inventa padrão", () => {
    const ip = "${A:-${B:-127.0.0.1}}";
    expect(bindInfo(ip)).toEqual({ kind: null, address: "", variable: ip });
    expect(bindPhrase(ip)).toBe(`num endereço que vem de variável (${ip}), só conhecido na hora do deploy`);
  });
});

describe("leitura do endereço no compose", () => {
  it("${DEV_BIND:-127.0.0.1}:8180:80 lê o endereço inteiro, sem confundir o ':' do padrão com IPv6", () => {
    const [p] = publishedPorts(["${DEV_BIND:-127.0.0.1}:8180:80"]);
    expect(p).toMatchObject({ hostIp: "${DEV_BIND:-127.0.0.1}", container: 80, host: { kind: "fixed", port: 8180 } });
    // antes saía "[${DEV_BIND:-127.0.0.1}]:8180:80", como se fosse IPv6
    expect(formatPortMapping(p!)).toBe("${DEV_BIND:-127.0.0.1}:8180:80");
    // IPv6 de verdade continua entre colchetes
    const [v6] = publishedPorts(["[::1]:8180:80"]);
    expect(formatPortMapping(v6!)).toBe("[::1]:8180:80");
  });

  it("forma longa: host_ip com variável", () => {
    const [p] = publishedPorts([{ target: 8025, published: 8025, host_ip: "${DEV_BIND:-127.0.0.1}" }]);
    expect(bindInfo(p!.hostIp).kind).toBe("loopback");
  });

  it("o caso do teste real (porta 80 em ${DEV_BIND:-127.0.0.1}) continua sem aviso de porta pública", async () => {
    const r = await achados('  web:\n    image: nginx:1\n    ports: ["${DEV_BIND:-127.0.0.1}:8180:80"]');
    expect(r.publicas).toHaveLength(0);
    expect(r.internas).toHaveLength(0);
  });
});

describe("internal-port-exposed: texto pelo endereço (decisão igual)", () => {
  it.each(["8025:8025", "0.0.0.0:8025:8025", "[::]:8025:8025", "::8025:8025"])(
    "%s: bloqueia e diz todas as interfaces / internet",
    async (porta) => {
      const r = await achados(`  mail:\n    image: axllent/mailpit:1\n    ports: ["${porta}"]`);
      const f = r.internas[0]!;
      expect(f.level).toBe("block");
      expect(f.title).toBe("Porta interna publicada para a internet (interface do Mailpit)");
      expect(f.fix).toContain("publicada em todas as interfaces do servidor, qualquer pessoa na internet chega nela");
    },
  );

  it("IP específico: bloqueia, sem dizer todas as interfaces", async () => {
    const f = await mailpit("192.0.2.10");
    expect(f.level).toBe("block");
    expect(f.title).toBe("Porta interna publicada no endereço 192.0.2.10 do servidor (interface do Mailpit)");
    expect(f.fix).toContain("publicada no endereço 192.0.2.10 do servidor");
    expect(f.fix).not.toContain("todas as interfaces");
  });

  it("${DEV_BIND:-127.0.0.1}: só avisa e diz que o padrão é só a própria VPS, e que a variável pode mudá-lo", async () => {
    const f = await mailpit("${DEV_BIND:-127.0.0.1}");
    expect(f.level).toBe("warn");
    expect(f.title).toBe("Porta interna publicada em endereço que vem de variável (interface do Mailpit)");
    expect(f.title).not.toContain("internet");
    expect(f.evidence).toContain('publica ${DEV_BIND:-127.0.0.1}:8025:8025 (no endereço da variável DEV_BIND, que por padrão é 127.0.0.1 (só a própria VPS)');
    expect(f.fix).toContain("Com o padrão do compose (127.0.0.1), só a própria VPS chega nela");
    expect(f.fix).toContain("se DEV_BIND for definida como 0.0.0.0, a porta fica em todas as interfaces");
    expect(f.fix).not.toContain("publicada em todas as interfaces");
    expect(f.fix).toContain("`127.0.0.1:8025:8025`, com o endereço escrito no compose em vez da variável.");
  });

  it("${BIND:-0.0.0.0}: diz que o padrão publica em todas as interfaces (nível igual ao de antes: aviso)", async () => {
    const f = await mailpit("${BIND:-0.0.0.0}");
    expect(f.level).toBe("warn");
    expect(f.fix).toContain("o padrão do compose (0.0.0.0) publica em todas as interfaces do servidor: se BIND não for definida");
  });

  it("${BIND:-192.0.2.10}: diz o endereço padrão", async () => {
    const f = await mailpit("${BIND:-192.0.2.10}");
    expect(f.fix).toContain("o padrão do compose é 192.0.2.10, um endereço do servidor");
  });

  it("${BIND} sem padrão: diz que não há padrão e o risco do 0.0.0.0", async () => {
    const f = await mailpit("${BIND}");
    expect(f.level).toBe("warn");
    expect(f.fix).toContain("o endereço vem da variável BIND, sem valor padrão no compose: se ela for 0.0.0.0");
  });

  it("loopback literal continua sem achado", async () => {
    const r = await achados('  mail:\n    image: axllent/mailpit:1\n    ports: ["127.0.0.1:8025:8025"]');
    expect(r.internas).toHaveLength(0);
  });
});

describe("public-port-published: texto pelo endereço", () => {
  it("todas as interfaces", async () => {
    const r = await achados('  svc:\n    image: app:1\n    ports: ["0.0.0.0:3000:3000"]');
    expect(r.publicas[0]!.title).toBe("Porta publicada em todas as interfaces do servidor");
    expect(r.publicas[0]!.fix).toMatch(/^Essa porta fica aberta para a internet, em todas as interfaces do servidor, sem passar/);
  });

  it("IP específico não vira todas as interfaces", async () => {
    const r = await achados('  svc:\n    image: app:1\n    ports: ["192.0.2.10:3000:3000"]');
    expect(r.publicas[0]!.level).toBe("warn");
    expect(r.publicas[0]!.title).toBe("Porta publicada no endereço 192.0.2.10 do servidor");
    expect(r.publicas[0]!.fix).toContain("aberta no endereço 192.0.2.10 do servidor (se for um IP público, para a internet)");
    expect(r.publicas[0]!.fix).not.toContain("todas as interfaces");
  });
});

describe("prévia do assistente (analyzeCompose)", () => {
  const mensagem = (ports: string) =>
    analyzeCompose(`services:\n  mail:\n    image: axllent/mailpit:1\n    ports: ["${ports}"]\n`, "compose.yml").find(
      (w) => w.id === "compose.internal-port-exposed",
    );

  it("endereço de variável: diz o padrão e que o deploy só avisa (a severidade não muda)", () => {
    const w = mensagem("${DEV_BIND:-127.0.0.1}:8025:8025");
    expect(w?.severity).toBe("critical");
    expect(w?.message).toContain("por padrão é 127.0.0.1 (só a própria VPS); a variável pode mudá-lo");
    expect(w?.message).toContain("o deploy só avisa");
    expect(w?.message).not.toContain("será bloqueado");
    // o endereço não aparece duas vezes
    expect(w?.message).not.toContain("(em ${DEV_BIND");
  });

  it("todas as interfaces: diz e avisa que o deploy será bloqueado", () => {
    const w = mensagem("8025:8025");
    expect(w?.message).toContain("em todas as interfaces do servidor");
    expect(w?.message).toContain("o deploy será bloqueado");
  });

  it("IP específico: diz o endereço", () => {
    const w = mensagem("192.0.2.10:8025:8025");
    expect(w?.message).toContain("no endereço 192.0.2.10 do servidor");
    expect(w?.message).not.toContain("todas as interfaces");
  });
});
