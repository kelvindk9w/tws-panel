/**
 * MailReputationService — a checagem de listas de bloqueio que, até aqui,
 * NUNCA rodava (o gancho ficava no plugin de monitoramento, que não enxerga
 * o serviço de e-mail). Agora ela é do próprio e-mail: uma vez por dia e no
 * botão "Conferir agora", com o resultado guardado, alerta quando listado,
 * chave DQS da Spamhaus guardada como segredo (0600, nunca devolvida) e as
 * marcações do Postmaster Tools / SNDS.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlacklistResult } from "@paas/core";
import { MailReputationService, type ReputationDeps } from "../src/services/mail-reputation-service.js";

const NOW = Date.parse("2026-10-04T15:00:00Z");
const HOUR = 3_600_000;
let dir = "";
let clock = NOW;

function result(dnsbl: string, status: BlacklistResult["status"]): BlacklistResult {
  return { dnsbl, label: dnsbl, status, detail: null, removalUrl: status === "listed" ? `https://${dnsbl}.example/remover` : null };
}

function deps(over: Partial<ReputationDeps> = {}): ReputationDeps {
  return {
    dataDir: dir,
    targets: async () => ({ ip: "203.0.113.10", domains: ["envio.exemplo.com.br"] }),
    checkIp: async () => [result("spamhaus-zen", "clean"), result("spamcop", "clean")],
    checkDomain: async () => [result("spamhaus-dbl", "clean")],
    facts: async () => ({ domains: [{ name: "envio.exemplo.com.br", dnsOk: 6, dnsTotal: 6, ptr: "generic" }], tls: { ok: 1, total: 1 } }),
    now: () => clock,
    ...over,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-reputacao-"));
  clock = NOW;
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

describe("conferir agora", () => {
  it("confere IP e domínios, guarda o resultado e os fatos da nota", async () => {
    const s = new MailReputationService(deps());
    const state = await s.check({ manual: true });
    expect(state.lastCheck).toMatchObject({
      checkedAt: new Date(NOW).toISOString(),
      ip: { target: "203.0.113.10" },
      domains: [{ target: "envio.exemplo.com.br" }],
      listedCount: 0,
    });
    expect(state.lastError).toBeNull();
    expect(state.checking).toBe(false);
    expect(state.nextCheckAt).toBe(new Date(NOW + 24 * HOUR).toISOString());
    expect(await s.facts()).toMatchObject({ at: new Date(NOW).toISOString(), tls: { ok: 1, total: 1 } });
    // guardado: outro objeto lê o mesmo
    expect((await new MailReputationService(deps()).state()).lastCheck?.listedCount).toBe(0);
  });

  it("listado: cria o alerta com o link de remoção", async () => {
    const onListed = vi.fn(async () => undefined);
    const s = new MailReputationService(deps({ onListed, checkIp: async () => [result("spamhaus-zen", "listed")] }));
    const state = await s.check({ manual: false });
    expect(state.lastCheck?.listedCount).toBe(1);
    expect(onListed).toHaveBeenCalledWith([
      "203.0.113.10 listado em spamhaus-zen — remoção: https://spamhaus-zen.example/remover",
    ]);
  });

  it("listado sem link de remoção e falha no alerta não derrubam a conferência", async () => {
    const s = new MailReputationService(
      deps({
        onListed: async () => Promise.reject(new Error("alerta falhou")),
        checkDomain: async () => [{ ...result("spamhaus-dbl", "listed"), removalUrl: null }],
      }),
    );
    expect((await s.check({ manual: false })).lastCheck?.listedCount).toBe(1);
  });

  it("usa a chave DQS guardada", async () => {
    const checkIp = vi.fn(async () => [result("spamhaus-zen", "clean")]);
    const checkDomain = vi.fn(async () => [result("spamhaus-dbl", "clean")]);
    const s = new MailReputationService(deps({ checkIp, checkDomain }));
    await s.setDqsKey("abcdefghij0123456789abcdef");
    await s.check({ manual: true });
    expect(checkIp).toHaveBeenCalledWith("203.0.113.10", { dqsKey: "abcdefghij0123456789abcdef" });
    expect(checkDomain).toHaveBeenCalledWith("envio.exemplo.com.br", { dqsKey: "abcdefghij0123456789abcdef" });
  });

  it("sem domínio cadastrado: não confere e explica", async () => {
    const checkIp = vi.fn();
    const s = new MailReputationService(deps({ checkIp, targets: async () => ({ ip: "203.0.113.10", domains: [] }) }));
    const state = await s.check({ manual: true });
    expect(checkIp).not.toHaveBeenCalled();
    expect(state.lastCheck).toBeNull();
    expect(state.lastError).toMatch(/Nenhum domínio/);
  });

  it("falha na consulta: guarda o erro e tenta de novo em 1 hora", async () => {
    const s = new MailReputationService(deps({ checkIp: async () => Promise.reject(new Error("DNS fora")) }));
    const state = await s.check({ manual: true });
    expect(state.lastError).toContain("DNS fora");
    expect(state.nextCheckAt).toBe(new Date(NOW + HOUR).toISOString());
  });

  it("falha que não é Error e fatos que falham (mantém os anteriores)", async () => {
    const facts = vi.fn(async () => ({ domains: [], tls: null }));
    const s = new MailReputationService(deps({ facts }));
    await s.check({ manual: false });
    facts.mockRejectedValueOnce(new Error("fora"));
    clock += 2 * 60_000;
    await s.check({ manual: false });
    expect((await s.facts())?.at).toBe(new Date(NOW).toISOString());
    const t = new MailReputationService(deps({ targets: async () => Promise.reject("texto") }));
    expect((await t.check({ manual: false })).lastError).toBe("texto");
  });

  it("botão: no máximo uma conferência por minuto (429)", async () => {
    const s = new MailReputationService(deps());
    await s.check({ manual: true });
    clock += 30_000;
    await expect(s.check({ manual: true })).rejects.toMatchObject({ statusCode: 429 });
    clock += 31_000;
    await expect(s.check({ manual: true })).resolves.toBeTruthy();
  });

  it("duas conferências ao mesmo tempo viram uma, e o estado mostra 'conferindo'", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const s = new MailReputationService(
      deps({
        checkIp: async () => {
          calls++;
          await gate;
          return [];
        },
      }),
    );
    const a = s.check({ manual: false });
    const b = s.check({ manual: false });
    await vi.waitFor(async () => expect((await s.state()).checking).toBe(true));
    release();
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });
});

describe("chave DQS", () => {
  it("guardada em arquivo 0600 e nunca devolvida (só os 4 últimos caracteres)", async () => {
    const s = new MailReputationService(deps());
    await s.setDqsKey("  abcdefghij0123456789abcdef  ");
    const state = await s.state();
    expect(state.dqs).toEqual({ configured: true, hint: "cdef" });
    expect(JSON.stringify(state)).not.toContain("abcdefghij0123456789abcdef");
    const file = path.join(dir, "mail", "reputacao.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toContain("abcdefghij0123456789abcdef");
  });

  it("chave inválida → 400; null apaga", async () => {
    const s = new MailReputationService(deps());
    await expect(s.setDqsKey("x.evil.example")).rejects.toMatchObject({ statusCode: 400 });
    await s.setDqsKey("abcdefghij0123456789abcdef");
    await s.setDqsKey(null);
    expect((await s.state()).dqs).toEqual({ configured: false, hint: null });
  });
});

describe("marcações (Postmaster Tools, SNDS, taxa de spam)", () => {
  it("guarda as datas, apaga com null e mantém o que não veio", async () => {
    const s = new MailReputationService(deps());
    expect(await s.marks()).toEqual({ googleAt: null, microsoftAt: null, spamRateOkAt: null });
    await s.setMarks({ googleAt: "2026-10-01", microsoftAt: "2026-10-02T10:00:00Z" });
    expect(await s.marks()).toEqual({
      googleAt: "2026-10-01T00:00:00.000Z",
      microsoftAt: "2026-10-02T10:00:00.000Z",
      spamRateOkAt: null,
    });
    await s.setMarks({ googleAt: null, spamRateOkAt: "2026-10-03" });
    expect(await s.marks()).toEqual({
      googleAt: null,
      microsoftAt: "2026-10-02T10:00:00.000Z",
      spamRateOkAt: "2026-10-03T00:00:00.000Z",
    });
  });

  it("data inválida ou no futuro → 400", async () => {
    const s = new MailReputationService(deps());
    await expect(s.setMarks({ googleAt: "ontem" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(s.setMarks({ googleAt: "2027-01-01" })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("agendamento diário", () => {
  it("confere 1 min depois de iniciar, depois uma vez por dia; parar cancela", async () => {
    const s = new MailReputationService(deps());
    await s.state(); // lê o arquivo antes do relógio de mentira (E/S de verdade)
    vi.useFakeTimers();
    // simula a conferência marcando a hora da tentativa SÓ em memória: gravar
    // em disco (E/S de verdade) com o relógio de mentira deixava o teste
    // instável com a máquina carregada (falhou 1 vez na suíte completa).
    const internal = s as unknown as { cache: { lastAttemptAt: string | null } };
    const check = vi.spyOn(s, "check").mockImplementation(async () => {
      internal.cache.lastAttemptAt = new Date(clock).toISOString();
      return undefined as never;
    });
    s.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(check).toHaveBeenCalledTimes(1);
    clock += 61_000;
    // as conferências de hora em hora só rodam quando passou um dia
    for (let h = 0; h < 23; h++) {
      clock += HOUR;
      await vi.advanceTimersByTimeAsync(HOUR);
    }
    expect(check).toHaveBeenCalledTimes(1);
    clock += HOUR;
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(check).toHaveBeenCalledTimes(2);
    s.stop();
    clock += 48 * HOUR;
    await vi.advanceTimersByTimeAsync(48 * HOUR);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("antes de qualquer conferência, a próxima é logo depois de iniciar", async () => {
    const s = new MailReputationService(deps());
    expect((await s.state()).nextCheckAt).toBe(new Date(NOW + 60_000).toISOString());
  });

  it("falha no agendado não derruba o painel", async () => {
    vi.useFakeTimers();
    const s = new MailReputationService(deps());
    vi.spyOn(s, "check").mockRejectedValue(new Error("x"));
    s.start();
    await vi.advanceTimersByTimeAsync(61_000);
    s.stop();
  });
});
