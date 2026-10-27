/**
 * routes-mail-test.test.ts — a caixa de teste de e-mail no painel REAL (Docker e Mailpit em dublê):
 * ligar/desligar/ver, lista e mensagem, o HTML isolado (CSP + sandbox, sem imagens remotas por
 * padrão), anexos que só baixam como binário, apagar, validação estrita e a política de tokens
 * (só o estado; mensagens, ligar/desligar e apagar são da pessoa).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MailTestService, type MailTestDockerLike } from "../src/services/mail-test-service.js";
import { startRealPanel, type RealPanel } from "./helpers/real-panel.js";

vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));

let panel: RealPanel;
let A = "";
let tokenRead = "";
let tokenAdmin = "";
let tokenScoped = "";
let tokenOther = "";
const human = () => ({ cookie: panel.cookie });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

const docker: MailTestDockerLike = {
  connectPanel: vi.fn(async () => undefined),
  status: vi.fn(async () => ({ installed: true, running: true })),
  address: vi.fn(async () => "172.30.0.9"),
  ensure: vi.fn(async () => undefined),
  remove: vi.fn(async () => ({ networkLeft: null })),
};

const client = {
  counts: vi.fn(async () => ({ total: 2, unread: 1 })),
  list: vi.fn(async (start: number, limit: number) => ({ total: 2, unread: 1, start, messages: [{ id: "m1", subject: `s${limit}`, from: null, to: [], created: "", read: false, size: 1, attachments: 0, snippet: "" }] })),
  message: vi.fn(async (id: string) => ({
    message: { id, subject: "Redefinir senha", links: ["https://app.example.com/reset"] },
    html: '<meta http-equiv="refresh" content="0;url=https://evil.example.net"><script>alert(1)</script><img src="cid:logo"><a href="https://app.example.com/reset">x</a>',
    inline: [{ partId: "2", contentId: "logo" }],
  })),
  part: vi.fn(async (_id: string, part: string) => ({
    body: Buffer.from("conteudo"),
    contentType: part === "2" ? "image/png" : part === "3" ? "image/svg+xml" : "application/pdf; name=a.pdf",
  })),
  remove: vi.fn(async () => undefined),
};

beforeAll(async () => {
  panel = await startRealPanel();
  A = await panel.createProject("Fazenda", "fazenda.example.com");
  const audit = panel.app.auditService;
  (panel.app as unknown as { mailTest: MailTestService }).mailTest = new MailTestService({
    dataDir: panel.dir,
    docker,
    panelContainer: "tws-panel",
    redirected: async () => ["SMTP_HOST"],
    audit,
    createClient: () => client as never,
  });
  tokenRead = (await panel.createToken({ name: "leitura", scope: "read", reach: "panel" })).token;
  tokenAdmin = (await panel.createToken({ name: "admin", scope: "admin", reach: "panel" })).token;
  tokenScoped = (await panel.createToken({ name: "so-a", scope: "admin", reach: "projects", projects: [A] })).token;
  const B = await panel.createProject("Loja", "loja.example.com");
  tokenOther = (await panel.createToken({ name: "so-b", scope: "admin", reach: "projects", projects: [B] })).token;
}, 120_000);

afterAll(async () => panel.close());

const url = (suffix = "") => `/api/projects/${A}/mail-test${suffix}`;

describe("ligar, ver e desligar", () => {
  it("projeto inexistente: 404 em todas", async () => {
    const res = await panel.app.inject({ method: "GET", url: "/api/projects/nao-existe/mail-test", headers: human() });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("project_not_found");
    for (const [method, suffix] of [["PUT", ""], ["GET", "/messages"], ["GET", "/messages/m1"], ["GET", "/messages/m1/html"], ["GET", "/messages/m1/parts/1"], ["DELETE", "/messages/m1"], ["DELETE", "/messages"]] as const) {
      const r = await panel.app.inject({ method, url: `/api/projects/nao-existe/mail-test${suffix}`, headers: human(), ...(method === "PUT" ? { payload: { enabled: false, deleteMessages: true } } : {}) });
      expect(r.statusCode, `${method} ${suffix}`).toBe(404);
    }
  });

  it("desligada por padrão", async () => {
    const res = await panel.app.inject({ method: "GET", url: url(), headers: human() });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toMatchObject({ enabled: false, container: "off", needsRestart: false });
  });

  it("sem ligar, as mensagens respondem 409 em português", async () => {
    const res = await panel.app.inject({ method: "GET", url: url("/messages"), headers: human() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "mail_test_off" });
  });

  it("liga com retenção própria e audita", async () => {
    const res = await panel.app.inject({ method: "PUT", url: url(), headers: human(), payload: { enabled: true, maxMessages: 100, maxAgeDays: 3 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, container: "running", settings: { maxMessages: 100, maxAgeDays: 3 }, messages: 2, unread: 1, redirectedVariables: ["SMTP_HOST"] });
    expect(docker.ensure).toHaveBeenCalledWith(expect.objectContaining({ slug: expect.any(String), maxMessages: 100, maxAgeDays: 3 }));
    await panel.app.auditService.flush();
    const audit = await panel.app.inject({ method: "GET", url: "/api/audit", headers: human() });
    expect(JSON.stringify(audit.json())).toContain("mailtest.enabled");
  });

  it("validação estrita do corpo", async () => {
    for (const payload of [{}, { enabled: "sim" }, { enabled: true, extra: 1 }, { enabled: true, maxMessages: "10" }, { enabled: true, maxMessages: 1.5 }, { enabled: false, deleteMessages: "sim" }]) {
      const res = await panel.app.inject({ method: "PUT", url: url(), headers: human(), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const range = await panel.app.inject({ method: "PUT", url: url(), headers: human(), payload: { enabled: true, maxMessages: 1 } });
    expect(range.statusCode).toBe(400);
    expect(range.json().error).toBe("invalid_max_messages");
  });
});

describe("mensagens", () => {
  it("lista com paginação e valida a consulta", async () => {
    const res = await panel.app.inject({ method: "GET", url: url("/messages?start=10&limit=20"), headers: human() });
    expect(res.statusCode).toBe(200);
    expect(client.list).toHaveBeenCalledWith(10, 20);
    expect(res.json().messages[0].subject).toBe("s20");
    expect(res.headers["cache-control"]).toBe("no-store");
    await panel.app.inject({ method: "GET", url: url("/messages"), headers: human() });
    expect(client.list).toHaveBeenLastCalledWith(0, 50);
    for (const q of ["limit=0", "limit=101", "start=-1", "start=x", "outro=1"]) {
      expect((await panel.app.inject({ method: "GET", url: url(`/messages?${q}`), headers: human() })).statusCode, q).toBe(400);
    }
  });

  it("abre uma mensagem sem o HTML dentro do JSON", async () => {
    const res = await panel.app.inject({ method: "GET", url: url("/messages/m1"), headers: human() });
    expect(res.statusCode).toBe(200);
    expect(res.json().message.links).toEqual(["https://app.example.com/reset"]);
    expect(res.body).not.toContain("<script");
    for (const bad of ["a%2Fb", "a.b", "..%2F..", "a%20b"]) {
      expect((await panel.app.inject({ method: "GET", url: url(`/messages/${bad}`), headers: human() })).statusCode, bad).toBe(400);
    }
  });

  it("o HTML sai isolado: CSP com sandbox, sem scripts, sem imagem remota, sem refresh e com cid ligado", async () => {
    const res = await panel.app.inject({ method: "GET", url: url("/messages/m1/html"), headers: human() });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("sandbox");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/https?:/);
    expect(csp).not.toContain("script-src");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).not.toContain("<script");
    expect(res.body).not.toMatch(/refresh/i);
    // a imagem do próprio e-mail vai embutida (o sandbox não leva o cookie de sessão)
    expect(res.body).toContain(`src="data:image/png;base64,${Buffer.from("conteudo").toString("base64")}"`);
  });

  it("imagens remotas só com images=1 (e só imagens)", async () => {
    const res = await panel.app.inject({ method: "GET", url: url("/messages/m1/html?images=1"), headers: human() });
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("img-src data: https: http:");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("sandbox");
    expect((await panel.app.inject({ method: "GET", url: url("/messages/m1/html?images=2"), headers: human() })).statusCode).toBe(400);
  });

  it("anexos: imagem comum aparece no corpo; o resto (PDF, SVG, ?download=1) só baixa como binário", async () => {
    const png = await panel.app.inject({ method: "GET", url: url("/messages/m1/parts/2"), headers: human() });
    expect(png.headers["content-type"]).toBe("image/png");
    expect(png.headers["content-disposition"]).toBe("inline");
    expect(String(png.headers["content-security-policy"])).toContain("sandbox");
    expect(png.headers["x-content-type-options"]).toBe("nosniff");
    const svg = await panel.app.inject({ method: "GET", url: url("/messages/m1/parts/3"), headers: human() });
    expect(svg.headers["content-type"]).toBe("application/octet-stream");
    expect(svg.headers["content-disposition"]).toBe("attachment");
    const pdf = await panel.app.inject({ method: "GET", url: url("/messages/m1/parts/1"), headers: human() });
    expect(pdf.headers["content-disposition"]).toBe("attachment");
    const forced = await panel.app.inject({ method: "GET", url: url("/messages/m1/parts/2?download=1"), headers: human() });
    expect(forced.headers["content-type"]).toBe("application/octet-stream");
    expect(forced.headers["content-disposition"]).toBe("attachment");
    expect(forced.body).toBe("conteudo");
    for (const bad of ["a%2Fb", "a.b", "1..2", "a%20b", "1."]) {
      expect((await panel.app.inject({ method: "GET", url: url(`/messages/m1/parts/${bad}`), headers: human() })).statusCode, bad).toBe(400);
    }
  });

  it("erro do Mailpit chega em português com o código dele", async () => {
    client.message.mockRejectedValueOnce(Object.assign(new Error("Mensagem não encontrada."), { statusCode: 404, code: "mail_test_message_not_found" }));
    const res = await panel.app.inject({ method: "GET", url: url("/messages/m9"), headers: human() });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "mail_test_message_not_found", message: "Mensagem não encontrada." });
    client.message.mockRejectedValueOnce(Object.assign(new Error("x"), { statusCode: 502, code: "mail_test_unreachable" }));
    expect((await panel.app.inject({ method: "GET", url: url("/messages/m1/html"), headers: human() })).statusCode).toBe(502);
    client.part.mockRejectedValueOnce(Object.assign(new Error("x"), { statusCode: 413, code: "mail_test_too_large" }));
    expect((await panel.app.inject({ method: "GET", url: url("/messages/m1/parts/1"), headers: human() })).statusCode).toBe(413);
    client.list.mockRejectedValueOnce(new Error("bug inesperado"));
    expect((await panel.app.inject({ method: "GET", url: url("/messages"), headers: human() })).statusCode).toBe(500);
  });

  it("apaga uma e esvazia, com auditoria", async () => {
    const one = await panel.app.inject({ method: "DELETE", url: url("/messages/m1"), headers: human() });
    expect(one.json()).toEqual({ ok: true });
    expect(client.remove).toHaveBeenLastCalledWith(["m1"]);
    const all = await panel.app.inject({ method: "DELETE", url: url("/messages"), headers: human() });
    expect(all.json()).toEqual({ ok: true });
    expect(client.remove).toHaveBeenLastCalledWith();
    await panel.app.auditService.flush();
    const audit = JSON.stringify((await panel.app.inject({ method: "GET", url: "/api/audit", headers: human() })).json());
    expect(audit).toContain("mailtest.message_deleted");
    expect(audit).toContain("mailtest.cleared");
  });
});

describe("política de tokens", () => {
  it("o estado é leitura; as mensagens, o ligar/desligar e o apagar são só da pessoa", async () => {
    for (const t of [tokenRead, tokenAdmin]) {
      expect((await panel.app.inject({ method: "GET", url: url(), headers: bearer(t) })).statusCode).toBe(200);
      for (const [method, suffix] of [["GET", "/messages"], ["GET", "/messages/m1"], ["GET", "/messages/m1/html"], ["GET", "/messages/m1/parts/1"], ["DELETE", "/messages/m1"], ["DELETE", "/messages"]] as const) {
        expect((await panel.app.inject({ method, url: url(suffix), headers: bearer(t) })).statusCode, `${method} ${suffix}`).toBe(403);
      }
      expect((await panel.app.inject({ method: "PUT", url: url(), headers: bearer(t), payload: { enabled: false, deleteMessages: true } })).statusCode).toBe(403);
    }
    // nada disso mexeu na caixa
    expect((await panel.app.inject({ method: "GET", url: url(), headers: human() })).json().enabled).toBe(true);
  });

  it("token limitado a projetos: o estado só do projeto dele (outro projeto = 404)", async () => {
    expect((await panel.app.inject({ method: "GET", url: url(), headers: bearer(tokenScoped) })).statusCode).toBe(200);
    expect((await panel.app.inject({ method: "GET", url: url(), headers: bearer(tokenOther) })).statusCode).toBe(404);
  });
});

describe("desligar", () => {
  it("pede a escolha sobre as mensagens, mantém ou apaga", async () => {
    const missing = await panel.app.inject({ method: "PUT", url: url(), headers: human(), payload: { enabled: false } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe("delete_choice_required");
    const kept = await panel.app.inject({ method: "PUT", url: url(), headers: human(), payload: { enabled: false, deleteMessages: false } });
    expect(kept.json()).toMatchObject({ enabled: false, container: "off" });
    expect(docker.remove).toHaveBeenLastCalledWith(expect.any(String), { deleteData: false });
    await panel.app.inject({ method: "PUT", url: url(), headers: human(), payload: { enabled: true } });
    await panel.app.inject({ method: "PUT", url: url(), headers: human(), payload: { enabled: false, deleteMessages: true } });
    expect(docker.remove).toHaveBeenLastCalledWith(expect.any(String), { deleteData: true });
  });
});

describe("tela de Variáveis", () => {
  it("traz o aviso da caixa de teste (null quando desligada)", async () => {
    const off = await panel.app.inject({ method: "GET", url: `/api/projects/${A}/env`, headers: human() });
    expect(off.json().mailTest).toBeNull();
  });
});
