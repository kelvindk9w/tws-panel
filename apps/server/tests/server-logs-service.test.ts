/**
 * server-logs-service.test.ts — a regra da página "Logs do servidor": só as três máquinas do painel pelo NOME exato
 * (nunca container de projeto), fontes do host só por id fechado, máscara dos segredos que o painel conhece,
 * limites, falha fechada sem a lista de segredos e o journal do host por um dublê do host bridge.
 */
import { describe, expect, it, vi } from "vitest";
import type { DockerContainerInfo } from "@paas/core";
import type { ContainerRuntime, DockerLogsResult } from "../src/services/docker-logs.js";
import { LOG_MASK } from "../src/services/log-mask.js";
import { ServerLogsService, type JournalResult, type ServerLogsDeps } from "../src/services/server-logs.js";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const MAIL_PASSWORD = "Caixa-Senha-77123";
const ADMIN = "Admin-Stalwart-99881";

function frame(text: string, type: 1 | 2 = 1): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function container(name: string, id: string, over: Partial<DockerContainerInfo> = {}): DockerContainerInfo {
  return { id, name, image: "img", state: "running", status: "Up 2 hours", managed: false, projectSlug: null, composeProject: null, ports: [], ...over };
}

const RUNTIME: ContainerRuntime = { state: "running", health: null, restartCount: 1, startedAt: "2026-10-30T09:00:00Z", finishedAt: null, exitCode: 0, tty: false };

function build(over: Partial<ServerLogsDeps> & { containers?: DockerContainerInfo[]; bodies?: Record<string, Buffer> } = {}) {
  const containers = over.containers ?? [
    container("tws-panel", "aaaaaaaaaaaa"),
    container("paas-caddy", "bbbbbbbbbbbb"),
    container("paas-stalwart", "cccccccccccc"),
    // containers de projeto e de terceiros: NUNCA podem aparecer
    container("paas-fazenda-api-1", "dddddddddddd", { managed: true, projectSlug: "fazenda", composeProject: "paas-fazenda", service: "api" }),
    container("postgres-externo", "eeeeeeeeeeee"),
    container("tws-panel-extra", "ffffffffffff"),
  ];
  const bodies = over.bodies ?? {};
  const logs = vi.fn(async (id: string): Promise<DockerLogsResult> => ({
    ok: true,
    body: bodies[id] ?? frame(`2026-10-30T11:00:00Z linha de ${id}\n`),
  }));
  const deps: ServerLogsDeps = {
    docker: {
      listContainers: vi.fn(async () => containers),
      inspect: vi.fn(async () => RUNTIME),
      logs,
      now: () => NOW,
    },
    journal: over.journal === undefined ? null : over.journal,
    secrets: over.secrets ?? (async () => [MAIL_PASSWORD, ADMIN]),
  };
  return { svc: new ServerLogsService(deps), deps, logs };
}

describe("fontes de container", () => {
  it("lê só painel, proxy e e-mail, pelo nome exato, com o id da fonte como serviço", async () => {
    const { svc, logs } = build();
    const r = await svc.read({}, {});
    expect(r.services.map((s) => [s.service, s.container])).toEqual([
      ["mail", "paas-stalwart"],
      ["panel", "tws-panel"],
      ["proxy", "paas-caddy"],
    ]);
    expect(logs.mock.calls.map((c) => c[0]).sort()).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]);
    expect(r.lines.map((l) => l.container).sort()).toEqual(["paas-caddy", "paas-stalwart", "tws-panel"]);
    expect(JSON.stringify(r)).not.toContain("fazenda");
    expect(JSON.stringify(r)).not.toContain("postgres-externo");
    expect(JSON.stringify(r)).not.toContain("tws-panel-extra");
  });

  it("uma fonte só: lê só aquele container", async () => {
    const { svc, logs } = build();
    const r = await svc.read({ source: "proxy", tail: 10, since: "1h" }, {});
    expect(r).toMatchObject({ service: "proxy", tail: 10, since: "1h" });
    expect(logs.mock.calls.map((c) => c[0])).toEqual(["bbbbbbbbbbbb"]);
  });

  it("fonte fora da lista: 400, sem tocar no Docker", async () => {
    const { svc, deps } = build();
    for (const source of ["fazenda", "paas-fazenda-api-1", "../etc", "sshd", "tws-panel", ""]) {
      await expect(svc.read({ source }, {}), source).rejects.toMatchObject({ statusCode: 400, code: "invalid_source" });
    }
    expect(deps.docker.listContainers).not.toHaveBeenCalled();
  });

  it("linhas e período inválidos: 400", async () => {
    const { svc } = build();
    for (const tail of [0, 2001, 1.5, Number.NaN]) {
      await expect(svc.read({ tail }, {})).rejects.toMatchObject({ statusCode: 400, code: "invalid_log_query" });
    }
    await expect(svc.read({ since: "7d" as never }, {})).rejects.toMatchObject({ statusCode: 400, code: "invalid_log_query" });
  });

  it("container da fonte não está rodando: 404 com mensagem própria", async () => {
    const { svc } = build({ containers: [container("tws-panel", "aaaaaaaaaaaa")] });
    await expect(svc.read({ source: "mail" }, {})).rejects.toMatchObject({ statusCode: 404, code: "source_not_found" });
    // sem nenhum container: a resposta vem vazia (não é erro)
    const empty = build({ containers: [] });
    expect((await empty.svc.read({}, {})).lines).toEqual([]);
  });

  it("máscara: senha de caixa, senha de administração e padrões óbvios", async () => {
    const body = frame(
      [
        `2026-10-30T11:00:00Z login ok com ${MAIL_PASSWORD}`,
        `2026-10-30T11:00:01Z admin=${ADMIN} e Authorization: Bearer abcdef1234567890xyz`,
        "2026-10-30T11:00:02Z smtp://app:segredo-url@mail.example.com:587 e token=tws_pat_abcDEF123456",
      ].join("\n") + "\n",
    );
    const { svc } = build({ bodies: { aaaaaaaaaaaa: body } });
    const r = await svc.read({ source: "panel" }, {});
    const all = r.lines.map((l) => l.text).join("\n");
    expect(all).not.toContain(MAIL_PASSWORD);
    expect(all).not.toContain(ADMIN);
    expect(all).not.toContain("abcdef1234567890xyz");
    expect(all).not.toContain("segredo-url");
    expect(all).not.toContain("tws_pat_abcDEF123456");
    expect(all).toContain(LOG_MASK);
  });

  it("sem conseguir montar a lista de segredos: 503 e NENHUM log é lido", async () => {
    const { svc, logs, deps } = build({
      secrets: async () => {
        throw new Error("cofre quebrado: detalhe interno");
      },
    });
    const err = await svc.read({}, {}).catch((e: unknown) => e as { statusCode: number; code: string; message: string });
    expect(err).toMatchObject({ statusCode: 503, code: "log_masking_unavailable" });
    expect((err as { message: string }).message).not.toContain("detalhe interno");
    expect(logs).not.toHaveBeenCalled();
    expect(deps.docker.listContainers).not.toHaveBeenCalled();
  });
});

describe("fontes do host (journal)", () => {
  const ok = (text: string[]): JournalResult => ({ ok: true, lines: text.map((t, i) => ({ time: `2026-10-30T11:00:0${i}.000Z`, text: t })) });

  it("docker e ssh pelo host bridge: janela e linhas viram argumentos validados", async () => {
    const read = vi.fn(async (): Promise<JournalResult> => ok(["vps sshd[1]: Failed password for root from 203.0.113.9 port 22", "vps sshd[1]: Accepted publickey"]));
    const { svc } = build({ journal: { read } });
    const r = await svc.read({ source: "ssh", tail: 50, since: "1h" }, {});
    expect(read).toHaveBeenCalledWith("ssh", 50, Math.floor(NOW / 1000) - 3600, undefined);
    expect(r).toMatchObject({ service: "ssh", tail: 50, since: "1h", truncated: false });
    expect(r.services).toEqual([expect.objectContaining({ service: "ssh", container: "journal:ssh", state: "journal", logsError: null })]);
    expect(r.lines[0]).toMatchObject({ service: "ssh", stream: "stdout", text: "vps sshd[1]: Failed password for root from 203.0.113.9 port 22" });
    await svc.read({ source: "docker" }, {});
    expect(read).toHaveBeenLastCalledWith("docker", 200, null, undefined);
    // o cliente desconectou: o sinal chega ao leitor do host para ele cancelar o helper
    const ac = new AbortController();
    await svc.read({ source: "docker" }, { signal: ac.signal });
    expect(read).toHaveBeenLastCalledWith("docker", 200, null, ac.signal);
  });

  it("segredos também são mascarados no journal; linhas enormes são cortadas", async () => {
    const big = "x".repeat(10_000);
    const read = async (): Promise<JournalResult> => ok([`vps dockerd: env ${MAIL_PASSWORD}`, big]);
    const { svc } = build({ journal: { read } });
    const r = await svc.read({ source: "docker" }, {});
    expect(r.lines[0]!.text).toBe(`vps dockerd: env ${LOG_MASK}`);
    expect(r.lines[1]!.text.length).toBeLessThan(2100);
  });

  it("devolve só as últimas `tail` linhas", async () => {
    const read = async (): Promise<JournalResult> => ok(["a", "b", "c"]);
    const { svc } = build({ journal: { read } });
    expect((await svc.read({ source: "docker", tail: 2 }, {})).lines.map((l) => l.text)).toEqual(["b", "c"]);
  });

  it("sem host bridge (fora da VPS), falha ou exceção: fonte indisponível, nunca erro vazado", async () => {
    const none = build({ journal: null });
    expect((await none.svc.read({ source: "ssh" }, {})).services[0]).toMatchObject({ logsError: "unavailable" });
    const failed = build({ journal: { read: async () => ({ ok: false }) } });
    expect((await failed.svc.read({ source: "ssh" }, {})).lines).toEqual([]);
    const thrown = build({
      journal: {
        read: async () => {
          throw new Error("detalhe interno do host");
        },
      },
    });
    const r = await thrown.svc.read({ source: "docker" }, {});
    expect(r.services[0]).toMatchObject({ logsError: "unavailable" });
    expect(JSON.stringify(r)).not.toContain("detalhe interno");
  });

  it("limite de leituras do host: 429, e a vaga volta depois", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const read = vi.fn(async (): Promise<JournalResult> => {
      await gate;
      return ok(["a"]);
    });
    const { svc } = build({ journal: { read } });
    const first = svc.read({ source: "docker" }, { human: true });
    const second = svc.read({ source: "ssh" }, { human: true });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await expect(svc.read({ source: "docker" }, { human: true })).rejects.toMatchObject({ statusCode: 429, code: "logs_busy" });
    release!();
    await Promise.all([first, second]);
    await expect(svc.read({ source: "docker" }, { human: true })).resolves.toBeTruthy();
  });

  it("token (não humano) usa só uma das duas vagas do host", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const read = vi.fn(async (): Promise<JournalResult> => {
      await gate;
      return ok(["a"]);
    });
    const { svc } = build({ journal: { read } });
    const first = svc.read({ source: "docker" }, { human: true });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await expect(svc.read({ source: "ssh" }, { human: false })).rejects.toMatchObject({ statusCode: 429 });
    release!();
    await first;
  });

  it("orçamento de máscara estourado: a linha sai omitida, nunca sem máscara", async () => {
    const read = async (): Promise<JournalResult> => ok(["a", "b", "c"]);
    let t = 0;
    const { svc, deps } = build({ journal: { read } });
    deps.docker.clock = () => (t += 1000);
    const r = await svc.read({ source: "docker" }, {});
    expect(r.truncated).toBe(true);
    expect(r.lines.every((l) => l.text.includes("omitida") || l.text === LOG_MASK || l.text.length > 0)).toBe(true);
    expect(r.lines.some((l) => l.text.includes("omitida"))).toBe(true);
  });

  it("resposta acima do limite de caracteres mantém só as mais recentes", async () => {
    const huge = "y".repeat(1900);
    const lines = Array.from({ length: 700 }, () => huge);
    const read = async (): Promise<JournalResult> => ok(lines);
    const { svc } = build({ journal: { read } });
    const r = await svc.read({ source: "docker", tail: 700 }, {});
    expect(r.truncated).toBe(true);
    expect(r.lines.length).toBeLessThan(700);
  });
});
