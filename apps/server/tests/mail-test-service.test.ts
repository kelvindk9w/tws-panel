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
    remove: vi.fn(async (slug, o) => {
      calls.push(`remove:${slug}:${o.deleteData}`);
      return { networkLeft: null };
    }),
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
    databaseSize: vi.fn(async () => 2048),
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
    expect(await svc.prepare(project(), await svc.snapshot(project()))).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("ligar", () => {
  it("sobe o Mailpit com a retenção padrão, guarda as senhas (0600), audita e diz que precisa reiniciar", async () => {
    const { docker, calls } = fakeDocker();
    const { svc } = service(docker);
    const view = await svc.update(project(), { enabled: true }, "kelvin");
    expect(calls).toEqual(["ensure:loja:500:7", "connect"]);
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
  const prep = async (svc: MailTestService, p = project()) => svc.prepare(p, await svc.snapshot(p));

  it("prepare sobe o Mailpit e devolve a rede, mas NÃO marca aplicado: só o deploy que terminou bem o faz", async () => {
    const { docker, calls } = fakeDocker();
    const { svc } = service(docker);
    await svc.update(project(), { enabled: true });
    const snap = await svc.snapshot(project());
    expect(snap.box).toEqual({ host: "paas-mailtest-loja", password: expect.any(String) });
    expect(snap.version).toMatch(/^[0-9a-f]{16}$/);
    calls.length = 0;
    expect(await svc.prepare(project(), snap)).toEqual({ network: "paas-mailtest-loja" });
    expect(calls).toContain("ensure:loja:500:7");
    // subiu a rede, mas os containers do app ainda têm o ambiente de antes
    expect((await svc.view(project())).needsRestart).toBe(true);
    await svc.applied(project(), snap.version);
    expect((await svc.view(project())).needsRestart).toBe(false);
    expect(await svc.prepare(project(), snap)).toEqual({ network: "paas-mailtest-loja" });
  });

  it("FALHA FECHADA: se o Mailpit não sobe, o deploy falha (nunca cai no e-mail real)", async () => {
    const { docker } = fakeDocker();
    const { svc } = service(docker);
    await svc.update(project(), { enabled: true });
    (docker.ensure as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("disco cheio"));
    await expect(prep(svc)).rejects.toMatchObject({
      statusCode: 502,
      code: "mail_test_unavailable",
      message: expect.stringMatching(/disco cheio.*destinatários reais/s),
    });
    expect((await svc.view(project())).needsRestart).toBe(true);
  });

  it("depois de desligada, o deploy que recria os containers registra o e-mail normal e solta o Mailpit que sobrou", async () => {
    const { docker, calls } = fakeDocker();
    const { svc } = service(docker);
    await svc.update(project(), { enabled: true });
    const on = await svc.snapshot(project());
    await svc.applied(project(), on.version);
    await svc.update(project(), { enabled: false, deleteMessages: false });
    expect((await svc.view(project())).needsRestart).toBe(true);
    const off = await svc.snapshot(project());
    expect(off).toEqual({ version: "off", box: null });
    expect(await svc.prepare(project(), off)).toBeNull();
    calls.length = 0;
    await svc.applied(project(), off.version);
    expect(calls).toEqual(["remove:loja:false"]);
    expect((await svc.view(project())).needsRestart).toBe(false);
    // e continua em paz nos deploys seguintes
    expect(await svc.prepare(project(), await svc.snapshot(project()))).toBeNull();
  });

  it("REVISÃO B2: religar containers antigos (boot do painel) não marca aplicado nem esconde o aviso", async () => {
    const { docker } = fakeDocker();
    const { svc } = service(docker);
    await svc.update(project(), { enabled: true });
    // joinMailNetwork: sem fotografia, os containers têm o ambiente ANTIGO (e-mail normal): nada de Mailpit
    expect(await svc.prepare(project(), null)).toBeNull();
    expect((await svc.view(project())).needsRestart).toBe(true);
    expect(docker.ensure).toHaveBeenCalledTimes(1); // só o do update
  });

  it("REVISÃO B2: sem fotografia, quem já tem o ambiente da caixa continua na rede dela", async () => {
    const { docker } = fakeDocker();
    const { svc } = service(docker);
    await svc.update(project(), { enabled: true });
    const snap = await svc.snapshot(project());
    await svc.applied(project(), snap.version);
    expect(await svc.prepare(project(), null)).toEqual({ network: "paas-mailtest-loja" });
    expect(docker.ensure).toHaveBeenCalledTimes(2);
    // desligada depois: o Mailpit saiu de propósito e não ressuscita; só a rede para religar
    await svc.update(project(), { enabled: false, deleteMessages: false });
    expect(await svc.prepare(project(), null)).toEqual({ network: "paas-mailtest-loja" });
    expect(docker.ensure).toHaveBeenCalledTimes(2);
  });

  it("REVISÃO B2: ligar durante um build (fotografia sem a caixa) mantém o aviso depois do deploy", async () => {
    const { svc } = service(fakeDocker().docker);
    const before = await svc.snapshot(project()); // começo do deploy: caixa desligada
    await svc.update(project(), { enabled: true }); // alguém liga durante o build
    expect(await svc.prepare(project(), before)).toBeNull();
    await svc.applied(project(), before.version);
    expect((await svc.view(project())).needsRestart).toBe(true);
  });

  it("M2: desligar durante o build NÃO recria o Mailpit: o deploy para e nada fica órfão", async () => {
    const { docker, calls } = fakeDocker();
    const { svc } = service(docker);
    await svc.update(project(), { enabled: true });
    const during = await svc.snapshot(project());
    await svc.update(project(), { enabled: false, deleteMessages: true });
    calls.length = 0;
    await expect(svc.prepare(project(), during)).rejects.toMatchObject({ code: "mail_test_changed" });
    // não subiu Mailpit novo nem tocou no volume
    expect(docker.ensure).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.startsWith("ensure"))).toEqual([]);
    expect(calls.filter((c) => c.startsWith("remove"))).toEqual([]);
  });

  it("M2: ao voltar ao e-mail normal com a caixa desligada, o Mailpit sai respeitando a escolha Apagar / Manter", async () => {
    for (const deleteMessages of [true, false]) {
      const { docker, calls } = fakeDocker();
      const { svc } = service(docker);
      await svc.update(project(), { enabled: true });
      await svc.applied(project(), (await svc.snapshot(project())).version);
      await svc.update(project(), { enabled: false, deleteMessages });
      calls.length = 0;
      await svc.applied(project(), "off");
      expect(calls).toEqual([`remove:loja:${deleteMessages}`]);
    }
  });

  it("M1: pending diz se o app no ar ainda não acompanha a caixa (ligada sem reinício = on; desligada sem reinício = off)", async () => {
    const { svc } = service(fakeDocker().docker);
    expect(await svc.pending(project())).toBeNull();
    await svc.update(project(), { enabled: true });
    expect(await svc.pending(project())).toBe("on");
    expect((await svc.view(project())).needsRestart).toBe(true);
    await svc.applied(project(), (await svc.snapshot(project())).version);
    expect(await svc.pending(project())).toBeNull();
    await svc.update(project(), { enabled: false, deleteMessages: false });
    expect(await svc.pending(project())).toBe("off");
    await svc.applied(project(), "off");
    expect(await svc.pending(project())).toBeNull();
    // site estático / nunca publicado: não há app rodando
    await svc.update(project(), { enabled: true });
    expect(await svc.pending(project({ detection: { type: "static" } } as never))).toBeNull();
  });

  it("M4: a tela recebe o teto por mensagem, o orçamento de disco e o tamanho atual do banco", async () => {
    const { svc } = service(fakeDocker().docker);
    const view = await svc.update(project(), { enabled: true });
    // A1: o que a tela mostra é o que o Mailpit aplica (MB inteiros): 2048 MB / 500 mensagens = 4 MB
    expect(view.maxMessageBytes).toBe(4 * 1024 * 1024);
    expect(view.diskBudgetBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(view.databaseBytes).toBe(2048);
    expect(view.maxMessageBytes * view.settings.maxMessages).toBeLessThanOrEqual(view.diskBudgetBytes);
  });

  it("B4: se o Docker falhar ao apagar o projeto, o registro com as senhas sai mesmo assim e a sobra fica anotada (sem senha)", async () => {
    let fail = true;
    const remove = vi.fn(async (slug: string) => {
      if (fail) throw new Error("daemon fora");
      return { networkLeft: null as string | null, slug };
    });
    const { svc } = service(fakeDocker({ remove: remove as never }).docker);
    await svc.update(project(), { enabled: true });
    await expect(svc.removed(project())).rejects.toThrow(/daemon fora/);
    const saved = await readFile(path.join(dir, "mail-test.json"), "utf8");
    expect(JSON.parse(saved).projects).toEqual({});
    expect(saved).not.toMatch(/smtpPassword|uiPassword/);
    expect(await svc.leftoverSlugs()).toEqual(["loja"]);
    // na próxima oportunidade (outro projeto sobe a caixa) a sobra é limpa
    fail = false;
    await svc.update(project({ id: "p2", slug: "outra" }), { enabled: true });
    expect(remove).toHaveBeenCalledWith("loja", { deleteData: true });
    expect(await svc.leftoverSlugs()).toEqual([]);
  });

  it("slug reaproveitado: a sobra do projeto apagado é limpa (container, volume, redes) ANTES de criar a caixa nova", async () => {
    let fail = true;
    const order: string[] = [];
    const remove = vi.fn(async (slug: string, o: { deleteData: boolean }) => {
      order.push(`remove:${slug}:${o.deleteData}`);
      if (fail) throw new Error("daemon fora");
      return { networkLeft: null as string | null };
    });
    const ensure = vi.fn(async () => void order.push("ensure"));
    const { svc } = service(fakeDocker({ remove: remove as never, ensure }).docker);
    await svc.update(project(), { enabled: true });
    await expect(svc.removed(project())).rejects.toThrow();
    order.length = 0;
    // enquanto a sobra não sai, a caixa nova NÃO sobe (não reaproveita o volume do projeto apagado)
    await expect(svc.update(project({ id: "p9" }), { enabled: true })).rejects.toMatchObject({ code: "mail_test_docker" });
    expect(order).not.toContain("ensure");
    expect(await svc.leftoverSlugs()).toEqual(["loja"]);
    // com o Docker de volta: apaga a sobra (com o volume) e só então cria
    fail = false;
    order.length = 0;
    await svc.update(project({ id: "p9" }), { enabled: true });
    expect(order).toEqual(["remove:loja:true", "ensure"]);
    expect(await svc.leftoverSlugs()).toEqual([]);
  });

  it("B4: rede que não saiu também fica anotada", async () => {
    const { svc } = service(fakeDocker({ remove: vi.fn(async () => ({ networkLeft: "paas-mailtest-loja" })) }).docker);
    await svc.update(project(), { enabled: true });
    await expect(svc.removed(project())).rejects.toThrow(/paas-mailtest-loja/);
    expect(await svc.leftoverSlugs()).toEqual(["loja"]);
  });

  it("REVISÃO B2: deploy revertido (não chega a applied) deixa o aviso; trocar a senha/conjunto muda a versão", async () => {
    const { svc } = service(fakeDocker().docker);
    await svc.update(project(), { enabled: true });
    const snap = await svc.snapshot(project());
    await svc.prepare(project(), snap);
    // rollback do Next.js: applied nunca é chamado
    expect((await svc.view(project())).needsRestart).toBe(true);
    const { mailTestVersion } = await import("../src/services/mail-test-service.js");
    expect(mailTestVersion({ host: "h", password: "a" })).not.toBe(mailTestVersion({ host: "h", password: "b" }));
    expect(mailTestVersion(null)).toBe("off");
  });

  it("applied de projeto sem registro não cria nada; com registro desligado e versão ligada não remove o Mailpit", async () => {
    const { docker, calls } = fakeDocker();
    const { svc } = service(docker);
    await svc.applied(project(), "off");
    expect(calls).toEqual([]);
    await svc.update(project(), { enabled: true });
    await svc.update(project(), { enabled: false, deleteMessages: false });
    calls.length = 0;
    await svc.applied(project(), "abc123");
    expect(calls).toEqual([]);
  });

  it("deploy com fotografia ligada e registro apagado (projeto removido no meio): falha fechada", async () => {
    const { svc } = service(fakeDocker().docker);
    await expect(svc.prepare(project(), { version: "x", box: { host: "h", password: "p" } })).rejects.toMatchObject({ code: "mail_test_unavailable" });
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

  it("projeto removido com a rede ainda em uso: avisa (vai para o log) e o registro sai mesmo assim", async () => {
    const { docker } = fakeDocker({ remove: vi.fn(async () => ({ networkLeft: "paas-mailtest-loja" })) });
    const { svc } = service(docker);
    await svc.update(project(), { enabled: true });
    await expect(svc.removed(project())).rejects.toThrow(/paas-mailtest-loja.*docker network rm/);
    expect(JSON.parse(await readFile(path.join(dir, "mail-test.json"), "utf8")).projects).toEqual({});
  });
});

describe("variáveis que a caixa não controla", () => {
  it("só aparecem com a caixa ligada; falha na varredura vira lista vazia", async () => {
    const found = [{ name: "SENDGRID_API_KEY", file: ".env", kind: "api" as const }];
    const mk = (fn: () => Promise<typeof found>) =>
      new MailTestService({ dataDir: dir, docker: fakeDocker().docker, panelContainer: "tws-panel", redirected: async () => [], uncontrolled: fn, createClient: () => fakeClient() as never });
    const svc = mk(async () => found);
    expect((await svc.view(project())).uncontrolled).toEqual([]);
    await svc.update(project(), { enabled: true });
    expect((await svc.view(project())).uncontrolled).toEqual(found);
    const broken = mk(async () => Promise.reject(new Error("x")));
    expect((await broken.view(project())).uncontrolled).toEqual([]);
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

  it("o painel entra na rede de leitura uma vez só; falha dele NÃO impede ligar e vale na próxima tentativa de leitura", async () => {
    const connectPanel = vi.fn().mockRejectedValueOnce(new Error("negado")).mockResolvedValue(undefined);
    const { docker } = fakeDocker({ connectPanel });
    const { svc } = service(docker);
    // a caixa liga mesmo assim (o redirecionamento do SMTP é o que importa)
    await expect(svc.update(project(), { enabled: true })).resolves.toMatchObject({ enabled: true });
    await svc.update(project(), { enabled: true });
    await svc.list(project(), 0, 1);
    await svc.list(project(), 0, 1);
    expect(connectPanel).toHaveBeenCalledTimes(2);
  });

  it("painel sem acesso à rede de leitura: o deploy segue e a tela mostra o erro de leitura com o motivo", async () => {
    const connectPanel = vi.fn(async () => {
      throw new Error("negado");
    });
    const { docker } = fakeDocker({ connectPanel, address: vi.fn(async () => null) });
    const { svc } = service(docker);
    await svc.update(project(), { enabled: true });
    const snap = await svc.snapshot(project());
    // o deploy NÃO é bloqueado
    await expect(svc.prepare(project(), snap)).resolves.toEqual({ network: "paas-mailtest-loja" });
    const view = await svc.view(project());
    expect(view.problem).toMatch(/não encontrou a caixa/);
    expect(view.problem).toMatch(/não conseguiu entrar na rede de leitura da caixa: negado/);
  });

  it("A2: ligar → desligar → ligar reconecta o painel à rede recriada", async () => {
    const { docker } = fakeDocker();
    const { svc } = service(docker);
    await svc.update(project(), { enabled: true });
    await svc.update(project(), { enabled: false, deleteMessages: false });
    await svc.update(project(), { enabled: true });
    expect(docker.connectPanel).toHaveBeenCalledTimes(2);
  });

  it("A2: o reinício que remove o Mailpit (applied off) também esquece a conexão: religar reconecta", async () => {
    const { docker } = fakeDocker();
    const { svc } = service(docker);
    await svc.update(project(), { enabled: true });
    await svc.update(project(), { enabled: false, deleteMessages: false });
    await svc.applied(project(), "off");
    await svc.update(project(), { enabled: true });
    expect(docker.connectPanel).toHaveBeenCalledTimes(2);
  });

  it("A2: apagar o projeto esquece a conexão do slug", async () => {
    const { docker } = fakeDocker();
    const { svc } = service(docker);
    await svc.update(project(), { enabled: true });
    await svc.removed(project());
    await svc.update(project(), { enabled: true });
    expect(docker.connectPanel).toHaveBeenCalledTimes(2);
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
