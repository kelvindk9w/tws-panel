/**
 * Health check e a página do painel: durante o deploy, quando o app responde 502/503/504 ou não responde, quem
 * responde ao health check é a página "Atualizando" do Caddy (503). Antes o log dizia "a aplicação respondeu
 * HTTP 503", que é o status da PÁGINA, não do app. A página leva o cabeçalho X-Tws-Painel com o que o app fez
 * (`app=` o status dele, `proxy=` o erro do Caddy), e o log do deploy passa a dizer isso.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpGet, waitHealthy, type Probe, type ProbeResult } from "../src/health-check.js";
import { PANEL_PAGE_HEADER, describeAppOutcome, describePanelPage, parsePanelPage } from "../src/panel-page.js";

const DOMAIN = "loja.exemplo.test";

describe("parsePanelPage — o cabeçalho das páginas do painel", () => {
  it("resposta do app trocada pela página: status do app e do erro", () => {
    expect(parsePanelPage("pagina=atualizando; app=502; proxy=503")).toEqual({ kind: "atualizando", appStatus: 502, proxyStatus: 503 });
  });

  it("app que não respondeu: app vazio, o erro do Caddy diz se foi tempo esgotado ou sem conexão", () => {
    expect(parsePanelPage("pagina=atualizando; app=; proxy=504")).toEqual({ kind: "atualizando", appStatus: null, proxyStatus: 504 });
    expect(parsePanelPage("pagina=indisponivel; app=; proxy=502")).toEqual({ kind: "indisponivel", appStatus: null, proxyStatus: 502 });
    expect(parsePanelPage("pagina=manutencao")).toEqual({ kind: "manutencao", appStatus: null, proxyStatus: null });
  });

  it("aceita a lista do Node (primeiro valor) e ignora espaços e maiúsculas no nome do campo", () => {
    expect(parsePanelPage([" PAGINA = atualizando ;APP=503", "outro"])).toEqual({ kind: "atualizando", appStatus: 503, proxyStatus: null });
  });

  it.each([
    [undefined],
    [""],
    ["pagina=outra; app=502"],
    ["app=502; proxy=503"],
    ["sem-igual"],
    [[] as string[]],
    ["pagina=atualizando; app=" + "9".repeat(300)],
  ])("o que não é do painel (ou vem malformado) não conta: %j", (valor) => {
    expect(parsePanelPage(valor as string | string[] | undefined)).toBeNull();
  });

  it("status fora do formato vira desconhecido, sem quebrar", () => {
    expect(parsePanelPage("pagina=atualizando; app={vars.tws_status_app}; proxy=abc")).toEqual({ kind: "atualizando", appStatus: null, proxyStatus: null });
    expect(parsePanelPage("pagina=atualizando; app=999; proxy=0503")).toEqual({ kind: "atualizando", appStatus: null, proxyStatus: null });
  });
});

describe("describeAppOutcome / describePanelPage — o texto do log", () => {
  it("diz o status real do app quando ele respondeu", () => {
    expect(describeAppOutcome({ kind: "atualizando", appStatus: 502, proxyStatus: 503 })).toBe("o app respondeu HTTP 502");
  });

  it("distingue tempo esgotado, falta de conexão e o caso sem detalhe", () => {
    expect(describeAppOutcome({ kind: "atualizando", appStatus: null, proxyStatus: 504 })).toBe("o app aceitou a conexão mas não respondeu a tempo");
    expect(describeAppOutcome({ kind: "atualizando", appStatus: null, proxyStatus: 502 })).toBe("o proxy não conseguiu conexão com o app");
    expect(describeAppOutcome({ kind: "atualizando", appStatus: null, proxyStatus: null })).toBe("o app não respondeu");
  });

  it("nomeia a página e o status que o health check recebeu", () => {
    expect(describePanelPage(503, { kind: "atualizando", appStatus: 502, proxyStatus: 503 })).toBe('HTTP 503 da página "Atualizando" do painel: o app respondeu HTTP 502');
    expect(describePanelPage(undefined, { kind: "manutencao", appStatus: null, proxyStatus: 502 })).toBe(
      'HTTP ? da página "em manutenção" do painel: o proxy não conseguiu conexão com o app',
    );
    expect(describePanelPage(503, { kind: "indisponivel", appStatus: null, proxyStatus: 504 })).toContain('"temporariamente indisponível"');
  });
});

describe("httpGet lê o cabeçalho do painel", () => {
  let server: http.Server;
  let port = 0;
  let resposta: { status: number; headers: Record<string, string> } = { status: 200, headers: {} };

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(resposta.status, resposta.headers);
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("página Atualizando no lugar do app: o resultado traz o que o app fez", async () => {
    resposta = { status: 503, headers: { [PANEL_PAGE_HEADER]: "pagina=atualizando; app=502; proxy=503" } };
    expect(await httpGet("127.0.0.1", port, DOMAIN)).toEqual({ ok: false, status: 503, panelPage: { kind: "atualizando", appStatus: 502, proxyStatus: 503 } });
  });

  it("resposta do próprio app (sem a marca): nada de página do painel", async () => {
    resposta = { status: 502, headers: {} };
    expect(await httpGet("127.0.0.1", port, DOMAIN)).toEqual({ ok: false, status: 502 });
  });
});

/** Relógio falso: cada `sleep` avança o tempo, sem esperar de verdade. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

const fixed = (r: ProbeResult): Probe => async () => r;

function run(probeHttp: Probe, probeHttps: Probe) {
  const log: string[] = [];
  const done = waitHealthy({ host: "paas-caddy", httpPort: 80, httpsPort: 443, domain: DOMAIN, onLog: (s) => log.push(s), probeHttp, probeHttps, ...clock() });
  return { done, log };
}

const PAGINA_502: ProbeResult = { ok: false, status: 503, panelPage: { kind: "atualizando", appStatus: 502, proxyStatus: 503 } };
const PAGINA_TEMPO: ProbeResult = { ok: false, status: 503, panelPage: { kind: "atualizando", appStatus: null, proxyStatus: 504 } };

describe("waitHealthy com a página do painel respondendo no lugar do app", () => {
  it("HTTPS: o log e o erro dizem o status real do app (502), não o 503 da página", async () => {
    const { done, log } = run(fixed({ ok: true, status: 308, location: `https://${DOMAIN}/` }), fixed(PAGINA_502));
    await expect(done).rejects.toThrow(
      `health check falhou após 90s: o certificado está válido, mas https://${DOMAIN} mostrou a página do painel porque o app respondeu HTTP 502`,
    );
    expect(log.join("")).toContain('Última resposta do health check (HTTPS): HTTP 503 da página "Atualizando" do painel: o app respondeu HTTP 502');
  });

  it("HTTPS: app que não respondeu a tempo aparece como tal", async () => {
    const { done } = run(fixed({ ok: true, status: 308, location: `https://${DOMAIN}/` }), fixed(PAGINA_TEMPO));
    await expect(done).rejects.toThrow(/porque o app aceitou a conexão mas não respondeu a tempo — a aplicação não está no ar/);
  });

  it("HTTP (domínio local): a última resposta no log também diz o que o app fez", async () => {
    const log: string[] = [];
    const done = waitHealthy({
      host: "paas-caddy",
      httpPort: 80,
      httpsPort: 443,
      domain: "loja.localhost",
      onLog: (s) => log.push(s),
      probeHttp: fixed(PAGINA_502),
      probeHttps: fixed(PAGINA_502),
      timeoutMs: 10_000,
      ...clock(),
    });
    await expect(done).rejects.toThrow(/health check falhou após 10s \(HTTP 503 da página "Atualizando" do painel: o app respondeu HTTP 502\)/);
    expect(log.join("")).toContain("o app respondeu HTTP 502");
  });

  it("sem a marca, a mensagem de sempre (o status é do app)", async () => {
    const { done } = run(fixed({ ok: true, status: 308, location: `https://${DOMAIN}/` }), fixed({ ok: false, status: 502 }));
    await expect(done).rejects.toThrow(/mas a aplicação respondeu HTTP 502 por https:\/\/loja\.exemplo\.test/);
  });
});
