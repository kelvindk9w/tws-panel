/**
 * Lote 6 / M7 — arquivo de dados que NÃO PÔDE ser lido não é "arquivo vazio".
 *
 * Antes: ~15 stores trocavam qualquer erro de leitura (E/S, permissão, JSON
 * ilegível) por uma lista vazia e a próxima gravação a escrevia por cima do
 * arquivo de verdade. O pior caso: a lista de projetos — o boot recalculava o
 * Caddyfile sem nenhum projeto. Agora o erro de leitura falha a operação (e o
 * arquivo não é tocado); o arquivo ilegível vai para `.corrompido-<data>`
 * (ou, nos dados sem os quais seguir é perigoso, a carga falha).
 *
 * Arquivo separado: o mock de node:fs/promises vale para o módulo todo.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";

const falha = vi.hoisted(() => ({ arquivo: null as string | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: (async (...args: Parameters<typeof original.readFile>) => {
      if (falha.arquivo && String(args[0]).endsWith(falha.arquivo)) {
        throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
      }
      return original.readFile(...args);
    }) as typeof original.readFile,
  };
});

const { UserStore } = await import("../src/services/user-store.js");
const { AlertsService } = await import("../src/services/alerts-service.js");
const { CredentialVault } = await import("../src/services/credential-vault.js");
const { SessionStore } = await import("../src/services/session-store.js");
const { SetupStateStore } = await import("../src/services/setup-state.js");
const { ManualCertificateStore } = await import("../src/services/certificate-store.js");
const { DeployService } = await import("../src/services/deploy-service.js");
const { PanelDomainService } = await import("../src/services/panel-domain.js");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-falha-fechada-"));
  falha.arquivo = null;
});
afterEach(async () => {
  falha.arquivo = null;
  await rm(dir, { recursive: true, force: true });
});

const ler = (nome: string) => readFile(path.join(dir, nome), "utf8");
const aparte = async (prefixo: string) => (await readdir(dir)).filter((n) => n.startsWith(`${prefixo}.corrompido-`));

describe("M7 — erro de leitura falha a operação e o arquivo não é tocado", () => {
  it("contas: erro de E/S não vira 'sem admin' (o assistente de instalação não reabre)", async () => {
    const primeiro = new UserStore(dir);
    await primeiro.create("admin", "$argon2id$hash");
    const antes = await ler("users.json");

    falha.arquivo = "users.json";
    const store = new UserStore(dir);
    await expect(store.hasAdmin()).rejects.toThrow();
    falha.arquivo = null;

    expect(await ler("users.json")).toBe(antes);
    // a MESMA instância se recupera quando o disco volta
    expect(await store.hasAdmin()).toBe(true);
  });

  it("alertas: erro de E/S não apaga os alertas existentes na próxima gravação", async () => {
    await new AlertsService(dir).create({ severity: "warning", source: "system", title: "um", message: "m" } as never);
    const antes = await ler("alerts.json");

    falha.arquivo = "alerts.json";
    const service = new AlertsService(dir);
    await expect(service.create({ severity: "warning", source: "system", title: "dois", message: "m" } as never)).rejects.toThrow();
    falha.arquivo = null;
    expect(await ler("alerts.json")).toBe(antes);

    await service.create({ severity: "warning", source: "system", title: "dois", message: "m" } as never);
    expect((await service.list()).alerts.map((a) => a.title).sort()).toEqual(["dois", "um"]);
  });

  it("cofre de credenciais: gravar uma credencial nova com o arquivo ilegível não perde as outras", async () => {
    await new CredentialVault(dir).set("p1", { username: "u", token: "token-um-1234" });

    falha.arquivo = "credentials.json";
    const cofre = new CredentialVault(dir);
    await expect(cofre.set("p2", { username: "u", token: "token-dois-5678" })).rejects.toThrow();
    falha.arquivo = null;

    await cofre.set("p2", { username: "u", token: "token-dois-5678" });
    expect((await cofre.get("p1"))?.token).toBe("token-um-1234");
    expect((await cofre.get("p2"))?.token).toBe("token-dois-5678");
  });

  it("sessões: erro de leitura não apaga as sessões abertas", async () => {
    const { cookieValue } = await new SessionStore(dir).create({ id: "u1", username: "admin" });

    falha.arquivo = "sessions.json";
    const store = new SessionStore(dir);
    await expect(store.create({ id: "u2", username: "outro" })).rejects.toThrow();
    falha.arquivo = null;

    expect((await store.resolve(cookieValue))?.username).toBe("admin");
  });

  it("assistente de instalação: erro de leitura não volta o passo a zero nem desfaz 'concluído'", async () => {
    const setup = new SetupStateStore(dir);
    await setup.complete();
    expect((await setup.load()).completed).toBe(true);

    falha.arquivo = "setup-state.json";
    await expect(setup.load()).rejects.toThrow();
    falha.arquivo = null;
    expect((await setup.load()).completed).toBe(true);
  });

  it("certificados manuais: erro de leitura do índice não deixa a próxima instalação apagar os outros", async () => {
    const store = new ManualCertificateStore(dir);
    await mkdir(path.join(dir, "certificates"), { recursive: true });
    await writeFile(path.join(dir, "certificates", "manual.json"), JSON.stringify({ certificates: [{ id: "a", host: "a.exemplo.com" }] }));
    falha.arquivo = "manual.json";
    await expect(store.list()).rejects.toThrow();
    falha.arquivo = null;
    expect((await store.list()).map((c) => c.host)).toEqual(["a.exemplo.com"]);
  });
});

describe("M7 — arquivo ilegível é guardado à parte, não sobrescrito", () => {
  it("alertas: JSON quebrado vai para alerts.json.corrompido-<data> e o serviço recomeça vazio", async () => {
    await writeFile(path.join(dir, "alerts.json"), "{quebrado");
    const service = new AlertsService(dir);
    expect((await service.list()).alerts).toEqual([]);
    const guardados = await aparte("alerts.json");
    expect(guardados).toHaveLength(1);
    expect(await readFile(path.join(dir, guardados[0]!), "utf8")).toBe("{quebrado");
  });

  it("cofre e sessões: formato desconhecido também é guardado à parte", async () => {
    await writeFile(path.join(dir, "credentials.json"), JSON.stringify({ credentials: "oops" }));
    expect(await new CredentialVault(dir).has("p1")).toBe(false);
    expect(await aparte("credentials.json")).toHaveLength(1);

    await writeFile(path.join(dir, "sessions.json"), "[]");
    const store = new SessionStore(dir);
    await store.create({ id: "u1", username: "admin" });
    expect(await aparte("sessions.json")).toHaveLength(1);
  });

  it("contas: users.json ilegível NÃO é movido nem vira 'sem admin' — a carga falha com mensagem clara", async () => {
    await writeFile(path.join(dir, "users.json"), "{quebrado");
    await expect(new UserStore(dir).hasAdmin()).rejects.toThrow(/users\.json está ilegível.*docs\/recuperar-acesso\.md/s);
    expect(await ler("users.json")).toBe("{quebrado");
    expect(await aparte("users.json")).toEqual([]);
  });

  it("setup-state.json ilegível: NÃO volta a 'setup não concluído' (reabriria o assistente) — falha e o arquivo fica", async () => {
    await writeFile(path.join(dir, "setup-state.json"), "{quebrado");
    await expect(new SetupStateStore(dir).load()).rejects.toThrow(/setup-state\.json está ilegível/);
    await expect(new SetupStateStore(dir).complete()).rejects.toThrow(/ilegível/);
    expect(await ler("setup-state.json")).toBe("{quebrado");
    expect(await aparte("setup-state.json")).toEqual([]);
  });
});

describe("M7 — lista de projetos (deploy-service) e o Caddyfile do boot", () => {
  function criar() {
    const svc = new DeployService(
      { dataDir: dir, projectsDir: path.join(dir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig,
      {},
    );
    const syncCaddy = vi.fn(async () => undefined);
    (svc as unknown as { engine: { syncCaddy: unknown } }).engine.syncCaddy = syncCaddy;
    (svc as unknown as { currentPanelSite: unknown }).currentPanelSite = { domain: "painel.exemplo.com", aliases: [], upstream: "paas-panel:9000" };
    return { svc, syncCaddy };
  }

  const PROJETOS = JSON.stringify({ projects: [{ id: "p1", slug: "loja", name: "Loja", domain: "loja.exemplo.com" }] });

  it("erro de leitura de projects.json: o boot NÃO recalcula o Caddyfile sem projetos e a lista volta depois", async () => {
    await writeFile(path.join(dir, "projects.json"), PROJETOS);
    const { svc, syncCaddy } = criar();

    falha.arquivo = "projects.json";
    await expect(svc.ensurePanelRoute()).rejects.toThrow();
    expect(syncCaddy).not.toHaveBeenCalled();
    await expect(svc.listProjects()).rejects.toThrow();
    falha.arquivo = null;

    expect((await svc.listProjects()).map((p) => p.slug)).toEqual(["loja"]);
    await svc.ensurePanelRoute();
    expect(syncCaddy).toHaveBeenCalledTimes(1);
    expect((syncCaddy.mock.calls[0] as unknown as [Array<{ slug: string }>])[0].map((p) => p.slug)).toEqual(["loja"]);
    expect(await ler("projects.json")).toBe(PROJETOS);
  });

  it("projects.json com JSON quebrado: a carga falha, o arquivo fica como está e o Caddy não é tocado", async () => {
    await writeFile(path.join(dir, "projects.json"), "{quebrado");
    const { svc, syncCaddy } = criar();
    await expect(svc.ensurePanelRoute()).rejects.toThrow(/projects\.json está ilegível.*restaurar-painel\.sh/s);
    expect(syncCaddy).not.toHaveBeenCalled();
    expect(await ler("projects.json")).toBe("{quebrado");
  });

  it("deploy-jobs.json ilegível (só histórico): guardado à parte e os projetos carregam", async () => {
    await writeFile(path.join(dir, "projects.json"), PROJETOS);
    await writeFile(path.join(dir, "deploy-jobs.json"), "{quebrado");
    const { svc } = criar();
    expect((await svc.listProjects()).map((p) => p.slug)).toEqual(["loja"]);
    expect((await readdir(dir)).filter((n) => n.includes(".corrompido-"))).toHaveLength(1);
  });
});

describe("M7 — domínio do painel", () => {
  const deps = (log: (m: string) => void = () => undefined) =>
    ({
      dataDir: dir,
      ipAddress: "203.0.113.10",
      serverIp: "203.0.113.10",
      serverIpv6: null,
      hostRepoDir: "/opt/tws-panel",
      applyAddresses: async () => undefined,
      setReserved: () => undefined,
      certificate: async () => null,
      domainInUse: async () => false,
      resolver: { resolve4: async () => [], resolve6: async () => [] },
      fallbackResolver: null,
      log,
    }) as unknown as ConstructorParameters<typeof PanelDomainService>[0];
  const SALVO = JSON.stringify({ domain: "painel.exemplo.com.br", active: false, ipAccessDisabled: false });

  it("erro de leitura: o boot falha em vez de seguir como 'sem domínio' e regravar por cima", async () => {
    await writeFile(path.join(dir, "panel-domain.json"), SALVO);
    falha.arquivo = "panel-domain.json";
    await expect(new PanelDomainService(deps()).init()).rejects.toThrow();
    falha.arquivo = null;
    expect(await ler("panel-domain.json")).toBe(SALVO);
  });

  it("JSON quebrado: guardado à parte, avisado no log, e o painel segue pelo IP", async () => {
    await writeFile(path.join(dir, "panel-domain.json"), "{quebrado");
    const avisos: string[] = [];
    const svc = new PanelDomainService(deps((m) => void avisos.push(m)));
    await svc.init();
    expect((await svc.status("203.0.113.10")).domain).toBeNull();
    expect(await aparte("panel-domain.json")).toHaveLength(1);
    expect(avisos.join(" ")).toMatch(/ilegível/);
  });
});
