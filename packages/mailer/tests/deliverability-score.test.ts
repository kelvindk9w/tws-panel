/**
 * Nota de entregabilidade ("Prontidão para a caixa de entrada", 0 a 100),
 * seguindo a seção 3.3 de comoFuncionaSistema/email/_PESQUISA-entregabilidade.md.
 * Regras de honestidade: o que não foi verificado não ganha ponto e aparece
 * como "não deu para verificar"; um servidor novo não chega ao verde antes
 * de terminar o aquecimento.
 */
import { describe, expect, it } from "vitest";
import type { BlacklistCheckResponse, BlacklistResult } from "@paas/core";
import { deliverabilityScore, type DeliverabilityInput } from "../src/deliverability-score.js";

const NOW = new Date("2026-10-04T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function bl(results: Array<Partial<BlacklistResult> & { dnsbl: string; status: BlacklistResult["status"] }>, checkedAt = daysAgo(0)): BlacklistCheckResponse {
  const full = results.map((r) => ({ label: r.dnsbl, detail: null, removalUrl: null, ...r }));
  return {
    checkedAt,
    ip: { target: "203.0.113.10", results: full.filter((r) => r.dnsbl !== "spamhaus-dbl") },
    domains: [{ target: "envio.exemplo.com.br", results: full.filter((r) => r.dnsbl === "spamhaus-dbl") }],
    listedCount: full.filter((r) => r.status === "listed").length,
  };
}

const CLEAN = bl([
  { dnsbl: "spamhaus-zen", status: "clean" },
  { dnsbl: "spamcop", status: "clean" },
  { dnsbl: "barracuda", status: "clean" },
  { dnsbl: "spamhaus-dbl", status: "clean" },
]);

function perfect(): DeliverabilityInput {
  return {
    now: NOW,
    domains: [{ name: "envio.exemplo.com.br", dnsOk: 6, dnsTotal: 6, ptr: "found" }],
    factsAt: daysAgo(0),
    tls: { ok: 1, total: 1 },
    blacklist: CLEAN,
    volume7d: { delivered: 500, bounced: 2, deferredRecipients: 1, recipients: 503 },
    firstSendAt: daysAgo(45),
    marks: { googleAt: daysAgo(40), microsoftAt: daysAgo(40), spamRateOkAt: daysAgo(3) },
  };
}

function item(input: DeliverabilityInput, id: string) {
  const found = deliverabilityScore(input).items.find((i) => i.id === id);
  if (!found) throw new Error(`item ${id} ausente`);
  return found;
}

describe("deliverabilityScore", () => {
  it("tudo feito: 95 de 100 (os relatórios DMARC o painel ainda não lê), verde", () => {
    const result = deliverabilityScore(perfect());
    expect(result.max).toBe(100);
    expect(result.items.reduce((a, i) => a + i.maxPoints, 0)).toBe(100);
    expect(result.score).toBe(95);
    expect(result.band).toBe("green");
    expect(item(perfect(), "dmarc-reports").status).toBe("unknown");
  });

  it("servidor novo, tudo certo no DNS mas sem aquecimento nem acompanhamento: não chega ao verde", () => {
    const input: DeliverabilityInput = {
      ...perfect(),
      firstSendAt: daysAgo(2),
      marks: { googleAt: null, microsoftAt: null, spamRateOkAt: null },
      volume7d: { delivered: 3, bounced: 0, deferredRecipients: 0, recipients: 3 },
    };
    const result = deliverabilityScore(input);
    expect(result.band).not.toBe("green");
    expect(item(input, "warmup")).toMatchObject({ status: "partial", points: 1 });
  });

  it("faixas: 85+ verde, 60–84 amarelo, abaixo de 60 vermelho", () => {
    const yellow = { ...perfect(), marks: { googleAt: null, microsoftAt: null, spamRateOkAt: null } };
    expect(deliverabilityScore(yellow).score).toBe(80);
    expect(deliverabilityScore(yellow).band).toBe("yellow");
    const red = { ...yellow, domains: [], tls: null, blacklist: null };
    expect(deliverabilityScore(red).band).toBe("red");
  });

  describe("DNS", () => {
    it("sem domínio cadastrado: a fazer", () => {
      expect(item({ ...perfect(), domains: [] }, "dns")).toMatchObject({ status: "todo", points: 0 });
    });

    it("domínio nunca verificado: não deu para verificar", () => {
      const input = { ...perfect(), domains: [{ name: "a.test", dnsOk: null, dnsTotal: null, ptr: null }] };
      expect(item(input, "dns")).toMatchObject({ status: "unknown", points: 0 });
      expect(item(input, "ptr")).toMatchObject({ status: "unknown", points: 0 });
    });

    it("parte dos registros: proporcional (o PTR conta à parte)", () => {
      const input = { ...perfect(), domains: [{ name: "a.test", dnsOk: 4, dnsTotal: 6, ptr: "found" as const }] };
      // 3 de 5 registros (o 4º ok é o PTR)
      expect(item(input, "dns")).toMatchObject({ status: "partial", points: 15 });
      expect(item(input, "dns").detail).toContain("4/6");
    });

    it("nenhum registro certo: a fazer", () => {
      const input = { ...perfect(), domains: [{ name: "a.test", dnsOk: 0, dnsTotal: 6, ptr: "action_required" as const }] };
      expect(item(input, "dns")).toMatchObject({ status: "todo", points: 0 });
    });
  });

  describe("PTR", () => {
    it.each([
      ["found", "done", 10],
      ["generic", "partial", 5],
      ["mismatch", "todo", 0],
      ["action_required", "todo", 0],
      ["missing", "todo", 0],
      ["pending", "unknown", 0],
    ] as const)("%s → %s (%d pontos)", (ptr, status, points) => {
      const input = { ...perfect(), domains: [{ name: "a.test", dnsOk: 6, dnsTotal: 6, ptr }] };
      expect(item(input, "ptr")).toMatchObject({ status, points });
    });

    it("sem domínio: não deu para verificar", () => {
      expect(item({ ...perfect(), domains: [] }, "ptr").status).toBe("unknown");
    });
  });

  describe("certificado", () => {
    it("válido, faltando e nunca conferido", () => {
      expect(item(perfect(), "tls")).toMatchObject({ status: "done", points: 5 });
      expect(item({ ...perfect(), tls: { ok: 0, total: 1 } }, "tls")).toMatchObject({ status: "todo", points: 0 });
      expect(item({ ...perfect(), tls: { ok: 1, total: 2 } }, "tls")).toMatchObject({ status: "partial", points: 0 });
      expect(item({ ...perfect(), tls: null }, "tls").status).toBe("unknown");
      expect(item({ ...perfect(), tls: { ok: 0, total: 0 } }, "tls").status).toBe("unknown");
    });
  });

  describe("listas de bloqueio", () => {
    it("nunca conferido: não deu para verificar", () => {
      expect(item({ ...perfect(), blacklist: null }, "blacklist")).toMatchObject({ status: "unknown", points: 0 });
    });

    it("Spamhaus listando: zero, com o link de remoção", () => {
      const input = {
        ...perfect(),
        blacklist: bl([
          { dnsbl: "spamhaus-zen", status: "listed", removalUrl: "https://check.spamhaus.org/" },
          { dnsbl: "spamcop", status: "clean" },
        ]),
      };
      expect(item(input, "blacklist")).toMatchObject({ status: "todo", points: 0 });
      expect(item(input, "blacklist").link?.href).toBe("https://check.spamhaus.org/");
    });

    it("listado só em outra lista: 5", () => {
      const input = {
        ...perfect(),
        blacklist: bl([
          { dnsbl: "spamhaus-zen", status: "clean" },
          { dnsbl: "spamcop", status: "listed" },
          { dnsbl: "spamhaus-dbl", status: "clean" },
        ]),
      };
      expect(item(input, "blacklist")).toMatchObject({ status: "todo", points: 5 });
      expect(item(input, "blacklist").link).toBeNull();
    });

    it("Spamhaus limpa e a Barracuda sem conferir: 12, parcial", () => {
      const input = {
        ...perfect(),
        blacklist: bl([
          { dnsbl: "spamhaus-zen", status: "clean" },
          { dnsbl: "spamcop", status: "clean" },
          { dnsbl: "barracuda", status: "unknown", lookupUrl: "https://www.barracudacentral.org/lookups" },
          { dnsbl: "spamhaus-dbl", status: "clean" },
        ]),
      };
      expect(item(input, "blacklist")).toMatchObject({ status: "partial", points: 12 });
    });

    it("Spamhaus sem conferir: zero, 'não deu para verificar', pedindo a chave DQS", () => {
      const input = {
        ...perfect(),
        blacklist: bl([
          { dnsbl: "spamhaus-zen", status: "unknown" },
          { dnsbl: "spamcop", status: "clean" },
        ]),
      };
      expect(item(input, "blacklist")).toMatchObject({ status: "unknown", points: 0 });
      expect(item(input, "blacklist").howTo).toMatch(/DQS/);
    });

    it("conferência antiga (mais de 2 dias) avisa no texto", () => {
      const input = { ...perfect(), blacklist: { ...CLEAN, checkedAt: daysAgo(5) } };
      expect(item(input, "blacklist").detail).toMatch(/5 dias/);
    });

    it("sem IP verificado: só os domínios contam", () => {
      const input = { ...perfect(), blacklist: { ...CLEAN, ip: null } };
      expect(item(input, "blacklist")).toMatchObject({ status: "done", points: 15 });
    });
  });

  describe("aquecimento", () => {
    it("sem envio registrado: a fazer", () => {
      expect(item({ ...perfect(), firstSendAt: null }, "warmup")).toMatchObject({ status: "todo", points: 0 });
    });

    it("30 dias ou mais: feito", () => {
      expect(item({ ...perfect(), firstSendAt: daysAgo(30) }, "warmup")).toMatchObject({ status: "done", points: 15 });
    });

    it("15 dias: metade", () => {
      expect(item({ ...perfect(), firstSendAt: daysAgo(15) }, "warmup")).toMatchObject({ status: "partial", points: 8 });
    });

    it("1 dia: singular", () => {
      expect(item({ ...perfect(), firstSendAt: daysAgo(1) }, "warmup").detail).toContain("há 1 dia:");
    });
  });

  describe("textos", () => {
    it("dois domínios no DNS", () => {
      const input = {
        ...perfect(),
        domains: [
          { name: "a.test", dnsOk: 6, dnsTotal: 6, ptr: "found" as const },
          { name: "b.test", dnsOk: 6, dnsTotal: 6, ptr: "found" as const },
        ],
      };
      expect(item(input, "dns").detail).toContain("2 domínios");
    });

    it("Spamhaus listando sem link de remoção", () => {
      const input = { ...perfect(), blacklist: bl([{ dnsbl: "spamhaus-zen", status: "listed" }]) };
      expect(item(input, "blacklist").link).toBeNull();
    });
  });

  describe("recusas e adiamentos (7 dias)", () => {
    it("sem envios: não deu para verificar", () => {
      const input = { ...perfect(), volume7d: { delivered: 0, bounced: 0, deferredRecipients: 0, recipients: 0 } };
      expect(item(input, "bounces")).toMatchObject({ status: "unknown", points: 0 });
    });

    it("abaixo de 2%: feito; entre 2% e 5%: parcial; acima: a fazer", () => {
      const v = (bounced: number) => ({ ...perfect(), volume7d: { delivered: 100 - bounced, bounced, deferredRecipients: 0, recipients: 100 } });
      expect(item(v(1), "bounces")).toMatchObject({ status: "done", points: 10 });
      expect(item(v(3), "bounces")).toMatchObject({ status: "partial", points: 5 });
      expect(item(v(10), "bounces")).toMatchObject({ status: "todo", points: 0 });
      expect(item(v(10), "bounces").detail).toContain("10%");
    });
  });

  describe("acompanhamento (marcado pela pessoa)", () => {
    it("Postmaster e SNDS: feitos com data, a fazer sem", () => {
      expect(item(perfect(), "google-postmaster")).toMatchObject({ status: "done", points: 3 });
      expect(item(perfect(), "microsoft-snds")).toMatchObject({ status: "done", points: 2 });
      const none = { ...perfect(), marks: { googleAt: null, microsoftAt: null, spamRateOkAt: null } };
      expect(item(none, "google-postmaster")).toMatchObject({ status: "todo", points: 0 });
      expect(item(none, "google-postmaster").link?.href).toBe("https://postmaster.google.com/");
      expect(item(none, "microsoft-snds").link?.href).toMatch(/sendersupport\.olc\.protection\.outlook\.com\/snds/);
    });

    it("taxa de spam: conferida há pouco = feito; há mais de 30 dias = parcial; nunca = a fazer", () => {
      const at = (spamRateOkAt: string | null) => ({ ...perfect(), marks: { ...perfect().marks, spamRateOkAt } });
      expect(item(at(daysAgo(3)), "spam-rate")).toMatchObject({ status: "done", points: 10 });
      expect(item(at(daysAgo(40)), "spam-rate")).toMatchObject({ status: "partial", points: 5 });
      expect(item(at(null), "spam-rate")).toMatchObject({ status: "todo", points: 0 });
    });
  });
});
