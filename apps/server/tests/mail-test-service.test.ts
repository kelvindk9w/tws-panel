/**
 * mail-test-service.ts — ligar/alterar/desligar a caixa de teste, o que o deploy usa (host, rede,
 * falha fechada), "precisa reiniciar", leitura/apagar mensagens e auditoria. Docker e Mailpit em dublê.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";
import { MailTestService, type MailTestDockerLike } from "../src/services/mail-test-service.js";

let dir: string;
const audit = { record: vi.fn(async () => ({})) };

const project = (extra: Partial<Project> = {}): Project =>
  ({ id: "p1", name: "Loja", slug: "loja", lastDeployStatus: "success", detection: { type: "compose" }, ...extra }) as unknown as Project;

function fakeDocker(over: Partial<MailTestDockerLike> = {}) {
  const calls: string[] = [];
  const docker: MailTestDockerLike = {
    connectPanel: vi.fn(async () => void calls.push("connect")),
    status: vi.fn(async () => ({ installed: true, running: true })),
    address: vi.fn(async () => "172.30.0.9"),
    ensure: vi.fn(async (s) => void calls.push(`ensure:${s.slug}:${s.maxMessages}:${s.maxAgeDays}`)),
    remove: vi.fn(async (slug, o) => void calls.push(`remove:${slug}:${o.deleteData}`)),
    ...over,
  };
  return { docker, calls };
}

function fakeClient() {
  return {
    counts: vi.fn(async () => ({ total: 3, unread: 1 })),
    list: vi.fn(async () => ({ total: 3, unread: 1, start: 0, messages: [] })),
    message: vi.fn(async () => ({ message: { id: "m1" }, html: "<p>oi</p>", inline: [] })),
    part: vi.fn(async () => ({ body: Buffer.from("x"), contentType: "image/png" })),
    remove: vi.fn(async () => undefined),
  };
}

function service(docker: MailTestDockerLike, client = fakeClient(), now = () => 1_000_000) {
  const createClient = vi.fn((_t: { baseUrl: string; user: string; password: string }) => client as never);
  const svc = new MailTestService({
    dataDir: dir,
    docker,
    panelContainer: "tws-panel",
    redirected: async () => ["SMTP_HOST", "SMTP_PORT"],
    audit,
    createClient,
    now,
  });
  return { svc, client, createClient };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-mailtest-"));
  audit.record.mockClear();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("estado inicial", () => {
  it("desligada por padrão; nada de Docker e nada a reiniciar", async () => {
    const { docker, calls } = fakeDocker();
    const { svc } = service(docker);
    expect(await svc.view(project())).toMatchObject({
      enabled: false,
      container: "off",
      settings: { enabled: false, maxMessages: 500, maxAgeDays: 7 },
      smtpHost: "paas-mailtest-loja",
      smtpPort: 1025,
      redirectedVariables: [],
      needsRestart: false,
      messages: null,
    });
    expect(await svc.active(project())).toBeNull();
    expect(await svc.prepare(project())).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("ligar", () => {
  it("sobe o Mailpit com a retenção padrão, guarda as senhas (0600), audita e diz que precisa reiniciar", async () => {
    const { docker, calls } = fakeDocker();
    const { svc } = service(docker);
    const view = await svc.update(project(), { enabled: true }, "kelvin");
    expect(calls).toEqual(["connect", "ensure:loja:500:7"]);
    expect(view).toMatchObject({ enabled: true, container: "running", messages: 3, unread: 1, needsRestart: true, redirectedVariables: ["SMTP_HOST", "SMTP_PORT"], problem: null });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "mailtest.enabled", target: "loja", actor: "kelvin" }));
    const file = path.join(dir, "mail-test.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(await readFile(file, "utf8")).projects.p1;
    expect(stored.smtpPassword.length).toBeGreaterThanOrEqual(20);
    expect(stored.uiPassword).not.toBe(stored.smtpPassword);
    // o app recebe o host do Mailpit e a senha gerada
    expect(await svc.active(project())).toEqual({ host: "paas-mailtest-loja", password: stored.smtpPassword });
    // a senha nunca aparece na tela
    expect(JSON.stringify(view)).not.toContain(stored.smtpPassword);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(stored.smtpPassword);
  });

  it("projeto que nunca foi publicado, ou site estático, não tem o que reiniciar", async () => {
    const { svc } = service(fakeDocker().docker);
    expect((await svc.update(project({ lastDeployStatus: null, deployedSource: null } as never), { enabled: true })).needsRestart).toBe(false);
    expect((await svc.view(project({ detection: { type: "static" } } as never))).needsRestart).toBe(false);
    expect((await svc.view(project({ detection: { type: "static-node" } } as never))).needsRestart).toBe(false);
  });

  it("retenção fora dos limites é recusada; dentro, vai para o container", async () => {
    const { docker, calls } = fakeDocker();
    const { svc } = service(docker);
    await expect(svc.update(project(), { enabled: true, maxMessages: 5 })).rejects.toMatchObject({ code: "invalid_max_messages" });
    await expect(svc.update(project(), { enabled: true, maxMessages: 6000 })).rejects.toMatchObject({ code: "invalid_max_messages" });
    await expect(svc.update(project(), { enabled: true, maxAgeDays: 0 })).rejects.toMatchObject({ code: "invalid_max_age" });
    await expect(svc.update(project(), { enabled: true, maxAgeDays: 31 })).rejects.toMatchObject({ code: "invalid_max_age" });
    expect(calls).toEqual([]);
    await svc.update(project(), { enabled: true, maxMessages: 100, maxAgeDays: 2 });
    expect(calls).toContain("ensure:loja:100:2");
  });

  it("Docker falhou: nada fica ligado e o erro é claro", async () => {
    const { docker } = fakeDocker({ ensure: vi.fn(async () => Promise.reject(new Error("sem imagem"))) });
    const { svc } = service(docker);
    await expect(svc.update(project(), { enabled: true })).rejects.toMatchObject({ statusCode: 502, code: "mail_test_docker", message: expect.stringContaining("sem imagem") });
    expect(await svc.active(project())).toBeNull();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("erro que não é Error também vira mensagem", async () => {
    const { docker } = fakeDocker({ ensure: vi.fn(async () => Promise.reject("texto")) });
    await expect(service(docker).svc.update(project(), { enabled: true })).rejects.toMatchObject({ message: expect.stringContaining("texto") });
  });

  it("ligada de novo com outra retenção: recria, mantém as senhas e audita como alteração", async () => {
    const { docker, calls } = fakeDocker();
    const { svc } = service(docker);
    await svc.update(project(), { enabled: true });
    const before = JSON.parse(await readFile(path.join(dir, "mail-test.json"), "utf8")).projects.p1;
    await svc.update(project(), { enabled: true, maxMessages: 50, maxAgeDays: 3 });
    const after = JSON.parse(await readFile(path.join(dir, "mail-test.json"), "utf8")).projects.p1;
    expect(after.smtpPassword).toBe(before.smtpPassword);
    expect(after.uiPassword).toBe(before.uiPassword);
    expect(after).toMatchObject({ maxMessages: 50, maxAgeDays: 3 });
    expect(calls).toContain("ensure:loja:50:3");
    expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: "mailtest.updated" }));
  });
});

describe("o que o deploy usa", () => {
  it("prepare sobe o Mailpit, devolve a rede e registra que o app já usa a caixa", async () => {
    const { docker, calls } = fakeDocker();
    const { svc } = service(docker);
    await svc.update(project(), { enabled: true });
    expect((await svc.view(project())).needsRestart).toBe(true);
    calls.length = 0;
    expect(await svc.prepare(project())).toEqual({ network: "paas-mailtest-loja" });
    expect(calls).toContain("ensure:loja:500:7");
    expect((await svc.view(project())).needsRestart).toBe(false);
    // de novo: nada muda, só garante
    expect(await svc.prepare(project())).toEqual({ network: "paas-mailtest-loja" });
  });

  it("FALHA FECHADA: se o Mailpit não sobe, o deploy falha (nunca cai no e-mail real)", async () => {
    const { docker } = fakeDocker();
    const { svc } = service(docker);
    await svc.update(project(), { enabled: true });
    (docker.ensure as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("disco cheio"));
    await expect(svc.prepare(project())).rejects.toMatchObject({
      statusCode: 502,
      code: "mail_test_unavailable",
      message: expect.stringMatching(/disco cheio.*destinatários reais/s),
    });
  });

  it("depois de desligada, o deploy registra que o app voltou ao e-mail normal", async () => {
    const { docker } = fakeDocker();
    const { svc } = service(docker);
    await svc.update(project(), { enabled: true });
    await svc.prepare(project());
    await svc.update(project(), { enabled: false, deleteMessages: false });
    expect((await svc.view(project())).needsRestart).toBe(true);
    expect(await svc.prepare(project())).toBeNull();
    expect((await svc.view(project())).needsRestart).toBe(false);
    // e continua em paz nos deploys seguintes
    expect(await svc.prepare(project())).toBeNull();
  });

  it("projeto removido: container, rede, volume e registro saem", async () => {
    const { docker, calls } = fakeDocker();
    const { svc } = service(docker);
    await svc.update(project(), { enabled: true });
    await svc.removed(project());
    expect(calls).toContain("remove:loja:true");
    expect(JSON.parse(await readFile(path.join(dir, "mail-test.json"), "utf8")).projects).toEqual({});
    // projeto que nunca teve caixa: só garante que nada sobrou
    await svc.removed(project({ id: "outro", slug: "outro" }));
    expect(calls).toContain("remove:outro:true");
  });
});

describe("desligar", () => {
  it("exige a escolha sobre as mensagens", async () => {
    const { svc } = service(fakeDocker().docker);
    await svc.update(project(), { enabled: true });
    await expect(svc.update(project(), { enabled: false })).rejects.toMatchObject({ statusCode: 400, code: "delete_choice_required" });
  });

  it("mantendo as mensagens: o container sai, o volume fica; audita", async () => {
    const { docker, calls } = fakeDocker();
    const { svc } = service(docker);
    await svc.update(project(), { enabled: true });
    const view = await svc.update(project(), { enabled: false, deleteMessages: false }, "kelvin");
    expect(calls).toContain("remove:loja:false");
    expect(view).toMatchObject({ enabled: false, container: "off", redirectedVariables: [] });
    expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: "mailtest.disabled", detail: expect.stringContaining("mantidas") }));
    // religar traz as mesmas senhas e as mensagens de volta
    await svc.update(project(), { enabled: true });
  });

  it("apagando: o volume sai e a auditoria diz", async () => {
    const { docker, calls } = fakeDocker();
    const { svc } = service(docker);
    await svc.update(project(), { enabled: true });
    await svc.update(project(), { enabled: false, deleteMessages: true });
    expect(calls).toContain("remove:loja:true");
    expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ detail: expect.stringContaining("apagadas") }));
  });

  it("nunca ligada: desligar com apagar ainda limpa o que sobrou, sem inventar registro", async () => {
    const { docker, calls } = fakeDocker();
    const { svc } = service(docker);
    await svc.update(project(), { enabled: false, deleteMessages: true });
    expect(calls).toContain("remove:loja:true");
    await expect(readFile(path.join(dir, "mail-test.json"), "utf8")).rejects.toThrow();
  });

  it("falha do Docker ao remover: erro claro e a caixa continua ligada", async () => {
    const { docker } = fakeDocker();
    const { svc } = service(docker);
    await svc.update(project(), { enabled: true });
    (docker.remove as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("daemon fora"));
    await expect(svc.update(project(), { enabled: false, deleteMessages: false })).rejects.toMatchObject({ code: "mail_test_docker" });
    expect((await svc.view(project())).enabled).toBe(true);
    (docker.remove as ReturnType<typeof vi.fn>).mockRejectedValueOnce("texto");
    await expect(svc.update(project(), { enabled: false, deleteMessages: false })).rejects.toMatchObject({ message: expect.stringContaining("texto") });
  });
});

describe("estado do container na tela", () => {
  it("parado, sumido, Docker indisponível e Mailpit que não responde", async () => {
    const { docker } = fakeDocker();
    const client = fakeClient();
    const { svc } = service(docker, client);
    await svc.update(project(), { enabled: true });
    const status = docker.status as ReturnType<typeof vi.fn>;
    status.mockResolvedValueOnce({ installed: true, running: false });
    expect(await svc.view(project())).toMatchObject({ container: "stopped", problem: expect.stringContaining("parada"), messages: null });
    status.mockResolvedValueOnce({ installed: false, running: false });
    expect(await svc.view(project())).toMatchObject({ container: "missing", problem: expect.stringContaining("não existe") });
    status.mockRejectedValueOnce(new Error("sem docker"));
    expect((await svc.view(project())).container).toBe("missing");
    client.counts.mockRejectedValueOnce(new Error("Mailpit não respondeu"));
    expect(await svc.view(project())).toMatchObject({ container: "running", problem: "Mailpit não respondeu", messages: null });
    client.counts.mockRejectedValueOnce("texto");
    expect((await svc.view(project())).problem).toBe("texto");
  });

  it("variáveis redirecionadas que falham a ler não derrubam a tela", async () => {
    const svc = new MailTestService({ dataDir: dir, docker: fakeDocker().docker, panelContainer: "tws-panel", redirected: async () => Promise.reject(new Error("x")), createClient: () => fakeClient() as never });
    await svc.update(project(), { enabled: true });
    expect((await svc.view(project())).redirectedVariables).toEqual([]);
  });
});

describe("mensagens", () => {
  it("só com a caixa ligada", async () => {
    const { svc } = service(fakeDocker().docker);
    await expect(svc.list(project(), 0, 50)).rejects.toMatchObject({ statusCode: 409, code: "mail_test_off" });
  });

  it("lê pelo IP interno com a senha da interface, e reaproveita o endereço por um tempo", async () => {
    const { docker } = fakeDocker();
    let t = 1_000_000;
    const { svc, client, createClient } = service(docker, fakeClient(), () => t);
    await svc.update(project(), { enabled: true });
    await svc.list(project(), 0, 50);
    await svc.message(project(), "m1");
    await svc.part(project(), "m1", "2");
    expect(client.list).toHaveBeenCalledWith(0, 50);
    expect(client.message).toHaveBeenCalledWith("m1");
    expect(client.part).toHaveBeenCalledWith("m1", "2");
    const target = createClient.mock.calls.at(-1)![0];
    expect(target.baseUrl).toBe("http://172.30.0.9:8025");
    expect(target.user).toBe("panel");
    expect(target.password.length).toBeGreaterThanOrEqual(20);
    const lookups = (docker.address as ReturnType<typeof vi.fn>).mock.calls.length;
    t += 60_000;
    await svc.list(project(), 0, 50);
    expect((docker.address as ReturnType<typeof vi.fn>).mock.calls.length).toBe(lookups + 1);
  });

  it("não achar o Mailpit na rede é erro claro; e esquece o IP depois de uma falha de rede", async () => {
    const { docker } = fakeDocker({ address: vi.fn(async () => null) });
    const client = fakeClient();
    const { svc } = service(docker, client);
    await svc.update(project(), { enabled: true });
    await expect(svc.list(project(), 0, 1)).rejects.toMatchObject({ code: "mail_test_unreachable" });
    (docker.address as ReturnType<typeof vi.fn>).mockResolvedValue("172.30.0.9");
    client.list.mockRejectedValueOnce(Object.assign(new Error("fora"), { code: "mail_test_unreachable" }));
    await expect(svc.list(project(), 0, 1)).rejects.toThrow("fora");
    const calls = (docker.address as ReturnType<typeof vi.fn>).mock.calls.length;
    await svc.list(project(), 0, 1);
    expect((docker.address as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls + 1);
  });

  it("apagar uma e esvaziar: audita sem conteúdo", async () => {
    const { svc, client } = service(fakeDocker().docker);
    await svc.update(project(), { enabled: true });
    await svc.deleteMessage(project(), "m1", "kelvin");
    expect(client.remove).toHaveBeenLastCalledWith(["m1"]);
    expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: "mailtest.message_deleted", actor: "kelvin", target: "loja" }));
    await svc.clear(project());
    expect(client.remove).toHaveBeenLastCalledWith();
    expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: "mailtest.cleared", detail: expect.stringContaining("3 mensagem") }));
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain("<p>");
  });

  it("o painel entra na rede de leitura uma vez só; falha dele vale na próxima tentativa", async () => {
    const connectPanel = vi.fn().mockRejectedValueOnce(new Error("negado")).mockResolvedValue(undefined);
    const { docker } = fakeDocker({ connectPanel });
    const { svc } = service(docker);
    await expect(svc.update(project(), { enabled: true })).rejects.toMatchObject({ code: "mail_test_docker" });
    await svc.update(project(), { enabled: true });
    await svc.list(project(), 0, 1);
    await svc.list(project(), 0, 1);
    expect(connectPanel).toHaveBeenCalledTimes(2);
  });
});

describe("arquivo de estado", () => {
  it("arquivo com formato estranho é tratado como vazio", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "mail-test.json"), JSON.stringify({ projects: null }));
    const { svc } = service(fakeDocker().docker);
    expect((await svc.view(project())).enabled).toBe(false);
  });

  it("constrói sem as opções de dublê (Date.now e cliente real)", () => {
    expect(() => new MailTestService({ dataDir: dir, docker: fakeDocker().docker, panelContainer: "tws-panel", redirected: async () => [] })).not.toThrow();
  });
});
