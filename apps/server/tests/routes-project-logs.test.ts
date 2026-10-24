/**
 * routes-project-logs.test.ts — GET /api/projects/:id/logs no painel REAL
 * (Docker em dublê injetado no serviço): validação estrita da consulta, 404 de
 * projeto/serviço, 503 sem Docker, máscara com as variáveis do projeto,
 * política de tokens (leitura; fora do alcance = 404 idêntico) e ausência de
 * auditoria da leitura.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DockerContainerInfo } from "@paas/core";
import { ProjectLogsService } from "../src/services/project-logs.js";
import { LOG_MASK } from "../src/services/log-mask.js";
import { startRealPanel, type RealPanel } from "./helpers/real-panel.js";

// criar projeto consulta os containers: sem Docker real, lista vazia
vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));

let panel: RealPanel;
let A = "";
let B = "";
let slugA = "";
const MISSING = "0000000000000000";
const SECRET = "Fazenda-Senha-9981";

function frame(text: string, type: 1 | 2 = 1): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

let dockerDown = false;
const logsCalls: string[] = [];
let customBody: Buffer | null = null;

beforeAll(async () => {
  panel = await startRealPanel();
  A = await panel.createProject("Fazenda", "fazenda.example.com");
  B = await panel.createProject("Loja", "loja.example.com");
  slugA = (await panel.app.deployService.getProject(A))!.slug;
  const put = await panel.app.inject({
    method: "PUT",
    url: `/api/projects/${A}/env`,
    headers: { cookie: panel.cookie },
    payload: { vars: [{ key: "DB_PASSWORD", value: SECRET }] },
  });
  expect(put.statusCode).toBe(200);

  const containers: DockerContainerInfo[] = [
    { id: "aaaaaaaaaaaa", name: `paas-${slugA}-api-1`, image: "i", state: "running", status: "Up 1 hour (healthy)", managed: true, projectSlug: slugA, composeProject: `paas-${slugA}`, service: "api", health: "healthy", ports: [] },
  ];
  (panel.app as unknown as { projectLogs: ProjectLogsService }).projectLogs = new ProjectLogsService({
    listContainers: async () => {
      if (dockerDown) throw new (await import("../src/services/docker-service.js")).DockerUnavailableError("sem docker");
      return containers;
    },
    inspect: async () => ({ state: "running", health: "healthy", restartCount: 2, startedAt: "2026-10-24T09:00:00Z", finishedAt: null, exitCode: 0, tty: false }),
    logs: async (id) => {
      logsCalls.push(id);
      if (customBody) return { ok: true, body: customBody };
      return { ok: true, body: Buffer.concat([frame(`2026-10-24T11:00:00Z conectou com ${SECRET}\n`), frame("2026-10-24T11:00:01Z falhou\n", 2)]) };
    },
    now: () => Date.parse("2026-10-24T12:00:00Z"),
  });
}, 120_000);

afterAll(async () => {
  await panel.close();
});

const get = (url: string, headers: Record<string, string>) => panel.app.inject({ method: "GET", url, headers });
const human = () => ({ cookie: panel.cookie });

describe("GET /api/projects/:id/logs", () => {
  it("sessão humana: linhas com stream e horário, estado dos serviços e segredo mascarado", async () => {
    const res = await get(`/api/projects/${A}/logs`, human());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lines).toEqual([
      { time: "2026-10-24T11:00:00Z", service: "api", container: `paas-${slugA}-api-1`, stream: "stdout", text: `conectou com ${LOG_MASK}` },
      { time: "2026-10-24T11:00:01Z", service: "api", container: `paas-${slugA}-api-1`, stream: "stderr", text: "falhou" },
    ]);
    expect(body.services[0]).toMatchObject({ service: "api", state: "running", health: "healthy", restartCount: 2 });
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(body.tail).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
  });

  it("aceita service, tail e since", async () => {
    const res = await get(`/api/projects/${A}/logs?service=api&tail=50&since=15m`, human());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ service: "api", tail: 50, since: "15m" });
  });

  it("consulta inválida: 400 (campo desconhecido, tail fora da faixa ou texto, since fora da lista, serviço com formato ruim)", async () => {
    for (const q of ["tail=0", "tail=2001", "tail=abc", "tail=1.5", "tail=-1", "since=7d", "since=", "service=..%2Fx", "service=--all", "service=a%20b", `service=${"a".repeat(64)}`, "foo=1", "service=api&service=web"]) {
      const res = await get(`/api/projects/${A}/logs?${q}`, human());
      expect(res.statusCode, q).toBe(400);
      expect(res.json().error, q).toBe("invalid_request");
    }
  });

  it("serviço bem formado que não é do projeto: 404 service_not_found", async () => {
    const res = await get(`/api/projects/${A}/logs?service=banco`, human());
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "service_not_found" });
  });

  it("projeto inexistente: 404 project_not_found", async () => {
    const res = await get(`/api/projects/${MISSING}/logs`, human());
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "project_not_found" });
  });

  it("sem sessão nem token: 401", async () => {
    expect((await get(`/api/projects/${A}/logs`, {})).statusCode).toBe(401);
  });

  it("Docker indisponível: 503 docker_unavailable (nunca 200 vazio)", async () => {
    dockerDown = true;
    try {
      const res = await get(`/api/projects/${A}/logs`, human());
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("docker_unavailable");
    } finally {
      dockerDown = false;
    }
  });

  it("não deu para ler as variáveis (cofre): falha fechada, 503 e NENHUM log é lido", async () => {
    const before = logsCalls.length;
    const spy = vi.spyOn(panel.app.deployService, "logSecretValues").mockRejectedValue(new Error("cofre quebrado: detalhe interno"));
    try {
      const res = await get(`/api/projects/${A}/logs`, human());
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("log_masking_unavailable");
      expect(JSON.stringify(res.json())).not.toContain("detalhe interno");
      expect(logsCalls.length).toBe(before);
    } finally {
      spy.mockRestore();
    }
  });

  it("mascara também a senha SMTP do e-mail do projeto e as variáveis ligadas a ele", async () => {
    const SMTP = "Smtp-Senha-77881";
    const LIGADA = "Ligada-Valor-445566";
    panel.app.deployService.setEnvProvider(async () => ({ SMTP_PASS: SMTP }));
    panel.app.deployService.setLinkedEnvProvider(async () => ({ EMAIL_SENHA: LIGADA }));
    customBody = frame(`2026-10-24T11:00:00Z smtp ${SMTP} e ${LIGADA} e ${SECRET}\n`);
    try {
      const res = await get(`/api/projects/${A}/logs`, human());
      expect(res.statusCode).toBe(200);
      expect(res.json().lines[0].text).toBe(`smtp ${LOG_MASK} e ${LOG_MASK} e ${LOG_MASK}`);
    } finally {
      customBody = null;
      panel.app.deployService.setEnvProvider(async () => ({}));
      panel.app.deployService.setLinkedEnvProvider(async () => ({}));
    }
  });

  it("leituras demais ao mesmo tempo: 429 logs_busy com a mensagem do serviço", async () => {
    const real = (panel.app as unknown as { projectLogs: ProjectLogsService }).projectLogs;
    const busy = Object.assign(new Error("Há leituras de logs demais em andamento."), { statusCode: 429, code: "logs_busy" });
    (panel.app as unknown as { projectLogs: unknown }).projectLogs = { read: async () => Promise.reject(busy) };
    try {
      const res = await get(`/api/projects/${A}/logs`, human());
      expect(res.statusCode).toBe(429);
      expect(res.json()).toEqual({ error: "logs_busy", message: "Há leituras de logs demais em andamento." });
    } finally {
      (panel.app as unknown as { projectLogs: ProjectLogsService }).projectLogs = real;
    }
  });

  it("a leitura não é auditada", async () => {
    await panel.app.auditService.flush();
    const before = (await panel.app.auditService.list(1, 200)).total;
    await get(`/api/projects/${A}/logs`, human());
    await get(`/api/projects/${A}/logs?service=banco`, human());
    await panel.app.auditService.flush();
    expect((await panel.app.auditService.list(1, 200)).total).toBe(before);
  });
});

describe("GET /api/projects/:id/logs com token de API", () => {
  it("token de leitura do painel inteiro lê", async () => {
    const t = await panel.createToken({ name: "leitura", scope: "read", reach: "panel" });
    const res = await get(`/api/projects/${A}/logs`, { authorization: `Bearer ${t.token}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain(SECRET);
  });

  it("token limitado ao projeto A: lê A; B e inexistente dão o MESMO 404", async () => {
    const t = await panel.createToken({ name: "so-a", scope: "read", reach: "projects", projects: [A] });
    const h = { authorization: `Bearer ${t.token}` };
    expect((await get(`/api/projects/${A}/logs`, h)).statusCode).toBe(200);
    const outro = await get(`/api/projects/${B}/logs`, h);
    const nenhum = await get(`/api/projects/${MISSING}/logs`, h);
    expect(outro.statusCode).toBe(404);
    expect(outro.body).toBe(nenhum.body);
    expect(outro.json()).toMatchObject({ error: "project_not_found" });
    // consulta inválida também não distingue projeto fora do alcance
    const ruim = await get(`/api/projects/${B}/logs?tail=0`, h);
    expect(ruim.statusCode).toBe(404);
  });
});
