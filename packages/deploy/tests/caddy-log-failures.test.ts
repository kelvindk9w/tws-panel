/**
 * Falhas de emissão em curso, resumidas do log do Caddy (fixtures, sem Docker):
 * quantas rodadas de tentativa falharam desde o último sucesso e desde quando.
 * Também: validade (início) do certificado servido e desempenho com entrada hostil.
 */
import { describe, expect, it } from "vitest";
import { ROUND_GAP_MS, explainIssueError, parseCaddyCertificateLog, sanitizeLogText, summarizeCaddyIssueFailures } from "../src/caddy-log.js";
import { parseCertDate } from "../src/tls-status.js";

const T0 = Date.parse("2027-03-01T10:00:00Z");
const sec = (n: number) => (T0 + n * 1000) / 1000;

function line(msg: string, host: string, at: number | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ level: "error", ...(at === null ? {} : { ts: sec(at) }), logger: "tls.obtain", msg, identifier: host, ...extra });
}

/** Uma rodada típica do certmagic: desafio falhou, emissor falhou, vai tentar de novo. */
function round(host: string, at: number): string[] {
  return [
    line("challenge failed", host, at, { problem: { type: "urn:ietf:params:acme:error:dns", detail: "NXDOMAIN" } }),
    line("could not get certificate from issuer", host, at + 1, { error: "HTTP 400 urn:ietf:params:acme:error:dns - NXDOMAIN" }),
    JSON.stringify({ level: "error", ts: sec(at + 2), logger: "tls.obtain", msg: "will retry", error: `[${host}] Obtain: falhou`, attempt: 1, retrying_in: 60 }),
  ];
}

const HOST = "loja.exemplo.com.br";

describe("summarizeCaddyIssueFailures", () => {
  it("log vazio ou sem eventos de emissão: nenhum nome", () => {
    expect(summarizeCaddyIssueFailures("").size).toBe(0);
    expect(summarizeCaddyIssueFailures('{"msg":"serving initial configuration"}\nlixo\n[1,2]').size).toBe(0);
  });

  it("linhas da mesma tentativa contam como UMA rodada", () => {
    const f = summarizeCaddyIssueFailures(round(HOST, 0).join("\n")).get(HOST)!;
    expect(f.rounds).toBe(1);
    expect(f.firstAt).toBe(new Date(T0).toISOString());
    expect(f.lastAt).toBe(new Date(T0 + 2000).toISOString());
    expect(f.detail).toMatch(/NXDOMAIN|Obtain/);
  });

  it("rodadas separadas por mais que o intervalo contam separado (fronteira inclusiva em 30 s)", () => {
    expect(ROUND_GAP_MS).toBe(30_000);
    const near = [line("challenge failed", HOST, 0), line("challenge failed", HOST, 29.999)].join("\n");
    expect(summarizeCaddyIssueFailures(near).get(HOST)!.rounds).toBe(1);
    const edge = [line("challenge failed", HOST, 0), line("challenge failed", HOST, 30)].join("\n");
    expect(summarizeCaddyIssueFailures(edge).get(HOST)!.rounds).toBe(2);
    const many = [0, 60, 180, 480].flatMap((t) => round(HOST, t)).join("\n");
    const f = summarizeCaddyIssueFailures(many).get(HOST)!;
    expect(f.rounds).toBe(4);
    expect(f.lastAt).toBe(new Date(T0 + 482_000).toISOString());
  });

  it("sucesso zera a contagem; falha depois do sucesso recomeça do 1", () => {
    const ok = line("certificate obtained successfully", HOST, 900);
    const logOk = [...round(HOST, 0), ...round(HOST, 100), ok].join("\n");
    expect(summarizeCaddyIssueFailures(logOk).has(HOST)).toBe(false);
    const depois = [...round(HOST, 0), ok, ...round(HOST, 1000)].join("\n");
    const f = summarizeCaddyIssueFailures(depois).get(HOST)!;
    expect(f.rounds).toBe(1);
    expect(f.firstAt).toBe(new Date(T0 + 1_000_000).toISOString());
  });

  it("renovação com sucesso também zera", () => {
    const renewed = line("certificate renewed successfully", HOST, 500);
    expect(summarizeCaddyIssueFailures([...round(HOST, 0), renewed].join("\n")).size).toBe(0);
  });

  it("tentativa em andamento ('trying') não zera nem conta", () => {
    const trying = line("trying to solve challenge", HOST, 50, { level: "info" });
    const f = summarizeCaddyIssueFailures([...round(HOST, 0), trying, ...round(HOST, 120)].join("\n")).get(HOST)!;
    expect(f.rounds).toBe(2);
  });

  it("cada nome tem a sua contagem", () => {
    const a = "a.exemplo.com.br";
    const b = "b.exemplo.com.br";
    const out = summarizeCaddyIssueFailures([...round(a, 0), ...round(b, 5), ...round(a, 100), line("certificate obtained successfully", b, 200)].join("\n"));
    expect(out.get(a)!.rounds).toBe(2);
    expect(out.has(b)).toBe(false);
  });

  it("nome vindo só do começo do erro ('[nome] ...') é reconhecido", () => {
    const l = JSON.stringify({ ts: sec(0), msg: "will retry", error: `[outro.exemplo.com.br] Obtain: falhou`, retrying_in: 60 });
    expect(summarizeCaddyIssueFailures(l).has("outro.exemplo.com.br")).toBe(true);
  });

  it("aceita nomes que não estão em nenhum Caddyfile (emissão sob demanda): o resumo é só por nome", () => {
    const out = summarizeCaddyIssueFailures(round("cliente-novo.imobiliaria.exemplo.com.br", 0).join("\n"));
    expect([...out.keys()]).toEqual(["cliente-novo.imobiliaria.exemplo.com.br"]);
  });

  it("sem hora no log, cada linha de erro conta como uma rodada e as datas ficam nulas", () => {
    const l = [line("challenge failed", HOST, null), line("challenge failed", HOST, null)].join("\n");
    const f = summarizeCaddyIssueFailures(l).get(HOST)!;
    expect(f.rounds).toBe(2);
    expect(f.firstAt).toBeNull();
    expect(f.lastAt).toBeNull();
  });

  it("hora que aparece só depois: vira a primeira conhecida e a última", () => {
    const l = [line("challenge failed", HOST, null), line("challenge failed", HOST, 100)].join("\n");
    const f = summarizeCaddyIssueFailures(l).get(HOST)!;
    expect(f.lastAt).toBe(new Date(T0 + 100_000).toISOString());
    expect(f.firstAt).toBe(new Date(T0 + 100_000).toISOString());
  });

  it("linha sem hora depois de uma com hora mantém a última hora conhecida", () => {
    const l = [line("challenge failed", HOST, 100), line("challenge failed", HOST, null)].join("\n");
    const f = summarizeCaddyIssueFailures(l).get(HOST)!;
    expect(f.lastAt).toBe(new Date(T0 + 100_000).toISOString());
    expect(f.rounds).toBe(2);
  });

  it("linha fora de ordem no tempo não vira nova rodada", () => {
    const l = [line("challenge failed", HOST, 100), line("challenge failed", HOST, 10)].join("\n");
    expect(summarizeCaddyIssueFailures(l).get(HOST)!.rounds).toBe(1);
  });

  it("detalhe do erro vem limitado e sem caracteres de controle", () => {
    const l = line("could not get certificate from issuer", HOST, 0, { error: "x\u001b[31m".repeat(400) + "\n" });
    const d = summarizeCaddyIssueFailures(l).get(HOST)!.detail!;
    expect(d.length).toBeLessThanOrEqual(300);
    // eslint-disable-next-line no-control-regex
    expect(d).not.toMatch(/[\u0000-\u001f]/);
  });

  it("o texto do erro é o da rodada mais recente, e dentro da rodada o que dá para classificar", () => {
    // rodada 1: causa conhecida (DNS); rodada 2: só a linha 'will retry' sem causa reconhecível
    const r1 = round(HOST, 0);
    const r2 = [
      JSON.stringify({ ts: sec(100), msg: "will retry", error: `[${HOST}] Obtain: coisa estranha`, retrying_in: 60 }),
    ];
    const f = summarizeCaddyIssueFailures([...r1, ...r2].join("\n")).get(HOST)!;
    expect(f.detail).toContain("coisa estranha");
    // dentro da MESMA rodada, a linha classificável não é trocada por uma sem causa
    const mesma = [r1[1]!, r1[2]!.replace("falhou", "sem causa")].join("\n");
    expect(summarizeCaddyIssueFailures(mesma).get(HOST)!.detail).toContain("NXDOMAIN");
    // e uma linha classificável posterior na mesma rodada vence a que não era
    const inversa = [r1[2]!.replace("falhou", "sem causa"), r1[1]!].join("\n");
    expect(summarizeCaddyIssueFailures(inversa).get(HOST)!.detail).toContain("NXDOMAIN");
  });

  it("linha de erro sem texto não apaga o texto que já havia", () => {
    const vazio = JSON.stringify({ ts: sec(1), msg: "job failed", identifier: HOST });
    const f = summarizeCaddyIssueFailures([line("challenge failed", HOST, 0, { error: "HTTP 400 urn:ietf:params:acme:error:dns - NXDOMAIN" }), vazio].join("\n")).get(HOST)!;
    expect(f.detail).toContain("NXDOMAIN");
  });

  it("o resultado de parseCaddyCertificateLog continua igual (último evento por nome)", () => {
    const ev = parseCaddyCertificateLog([...round(HOST, 0), line("certificate obtained successfully", HOST, 50)].join("\n"));
    expect(ev.get(HOST)?.kind).toBe("obtained");
  });
});

describe("parseCertDate (validade do certificado servido)", () => {
  it("converte a data do TLS para ISO e devolve null para vazio ou ilegível", () => {
    expect(parseCertDate("Mar  1 10:00:00 2027 GMT")).toBe("2027-03-01T10:00:00.000Z");
    expect(parseCertDate(undefined)).toBeNull();
    expect(parseCertDate("")).toBeNull();
    expect(parseCertDate("não é data")).toBeNull();
  });
});

describe("desempenho com entrada hostil (regex lineares)", () => {
  const budgetMs = 5000; // linear: com entrada 20x maior, uma regex quadrática levaria minutos
  const time = (fn: () => void): number => {
    const t = performance.now();
    fn();
    return performance.now() - t;
  };

  it("linha enorme de colchetes e espaços não trava o resumo", () => {
    const huge = `{"msg":"will retry","error":"${"[".repeat(60_000)}"}`;
    const noSpace = `{"msg":"will retry","error":"[${"a".repeat(60_000)}"}`;
    const text = [huge, noSpace, "{".repeat(100_000), " ".repeat(100_000)].join("\n");
    expect(time(() => summarizeCaddyIssueFailures(text))).toBeLessThan(budgetMs);
    expect(time(() => parseCaddyCertificateLog(text))).toBeLessThan(budgetMs);
  });

  it("muitas linhas válidas e repetidas (log de 20 mil linhas) resumem rápido", () => {
    const lines: string[] = [];
    for (let i = 0; i < 20_000; i++) lines.push(line("challenge failed", `h${i % 50}.exemplo.com.br`, i * 40, { error: "x".repeat(200) }));
    const text = lines.join("\n");
    const out = summarizeCaddyIssueFailures(text);
    expect(out.size).toBe(50);
    expect(time(() => summarizeCaddyIssueFailures(text))).toBeLessThan(budgetMs);
  });

  it("sanitizeLogText com sequências de escape e espaços repetidos é linear", () => {
    const esc = "\u001b[".repeat(100_000) + "9".repeat(100_000);
    const blanks = ("a" + " ".repeat(50)).repeat(5_000);
    expect(time(() => sanitizeLogText(esc, 100_000))).toBeLessThan(budgetMs);
    expect(time(() => sanitizeLogText(blanks, 100_000))).toBeLessThan(budgetMs);
  });

  it("explainIssueError com 'retry after' e IPv6 hostis é linear", () => {
    const hostile = `rateLimited ${"retry after ".repeat(20_000)} 2606:4700 ${"2".repeat(50_000)}`;
    expect(time(() => explainIssueError(hostile))).toBeLessThan(budgetMs);
    const colons = ": 52".repeat(50_000);
    expect(time(() => explainIssueError(colons))).toBeLessThan(budgetMs);
  });
});
