/**
 * UpdateCheckService — alerta de "nova atualização do projeto" (só aviso).
 * Dependências trocadas por dublês e relógio controlado: a comparação, o cache, o recuo em falha,
 * o limite de consultas simultâneas e, principalmente, que NÃO DAR PARA VERIFICAR nunca vira
 * "sem atualização".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitReadCredential, Project } from "@paas/core";
import {
  UPDATE_CHECK_CONCURRENCY,
  UPDATE_CHECK_ERROR_BASE_MS,
  UPDATE_CHECK_ERROR_MAX_MS,
  UPDATE_CHECK_HARD_TIMEOUT_MS,
  UPDATE_CHECK_MANUAL_MIN_MS,
  UPDATE_CHECK_SLOT_TIMEOUT_MS,
  UPDATE_CHECK_TTL_MS,
  UPDATE_CHECK_WAIT_MS,
  UpdateCheckService,
  type UpdateCheckDeps,
  branchOf,
  updateReasonOf,
} from "../src/services/update-check-service.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const TOKEN = "tkn_TOKENALERTAATUALIZACAOsupersecreto77";

let clock: number;
let remote: ReturnType<typeof vi.fn>;
let resolve: ReturnType<typeof vi.fn>;
let credential: GitReadCredential | null;
let svc: UpdateCheckService;

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "App",
    slug: "app",
    ingestMode: "git",
    source: "https://git.example.com/dono/repo.git",
    branch: "main",
    domain: "app.example.com",
    websocket: false,
    detection: null,
    proxyService: null,
    proxyPort: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastDeployAt: new Date(1_000).toISOString(),
    lastDeployStatus: "success",
    deployedBranch: "main",
    deployedSource: "https://git.example.com/dono/repo.git",
    deployedCommit: A,
    ...overrides,
  } as Project;
}

beforeEach(() => {
  clock = 1_000_000;
  credential = null;
  remote = vi.fn(async () => ({ ok: true, commit: A }));
  resolve = vi.fn(async () => ({ ok: true, pin: null }));
  svc = new UpdateCheckService({
    credentialFor: async () => credential,
    resolveTarget: resolve as unknown as UpdateCheckDeps["resolveTarget"],
    remoteBranchCommit: remote as unknown as UpdateCheckDeps["remoteBranchCommit"],
    now: () => clock,
    random: () => 0.5, // sem variação: o jitter é testado à parte
  });
});

afterEach(() => vi.useRealTimers());

describe("estados que não consultam o repositório", () => {
  it("projeto sem repositório (upload/pasta) não tem alerta", async () => {
    for (const ingestMode of ["upload", "existing"] as const) {
      const s = await svc.status(project({ ingestMode }));
      expect(s.state).toBe("not_applicable");
      expect(s.branch).toBeNull();
    }
    expect(remote).not.toHaveBeenCalled();
  });

  it("nunca implantado: 'never_deployed', sem consulta", async () => {
    const s = await svc.status(project({ lastDeployStatus: null, deployedSource: null, deployedBranch: null, deployedCommit: null }));
    expect(s.state).toBe("never_deployed");
    expect(remote).not.toHaveBeenCalled();
  });

  it("deploy que só falhou continua 'nunca implantado'", async () => {
    const s = await svc.status(project({ lastDeployStatus: "failed", deployedSource: null, deployedBranch: null, deployedCommit: null }));
    expect(s.state).toBe("never_deployed");
  });

  it("publicado antes do registro do commit: 'unknown', nunca atualização", async () => {
    const s = await svc.status(project({ deployedCommit: undefined }));
    expect(s.state).toBe("unknown");
    expect(s.deployedCommit).toBeNull();
    const s2 = await svc.status(project({ deployedCommit: null }));
    expect(s2.state).toBe("unknown");
    expect(remote).not.toHaveBeenCalled();
  });

  it("projeto muito antigo (sem deployedSource/deployedBranch, só lastDeployStatus) cai em 'unknown', não em 'config_changed'", async () => {
    const s = await svc.status(project({ deployedSource: null, deployedBranch: null, deployedCommit: null }));
    expect(s.state).toBe("unknown");
  });

  it("projeto criado SEM branch (deployedBranch vazio) é a branch padrão: não é 'config_changed' e consulta main", async () => {
    const sem = project({ branch: null, deployedBranch: null });
    expect((await svc.status(sem)).state).toBe("up_to_date");
    expect(remote.mock.calls[0]?.[0]).toMatchObject({ branch: "main" });
  });

  it("publicado sem branch e depois trocado para sandbox: 'config_changed', sem alerta falso", async () => {
    const s = await svc.status(project({ branch: "sandbox", deployedBranch: null }));
    expect(s.state).toBe("config_changed");
    expect(remote).not.toHaveBeenCalled();
  });

  it("branch (ou repositório) configurados diferem dos que estão no ar: 'config_changed', sem comparar commits", async () => {
    expect((await svc.status(project({ branch: "sandbox" }))).state).toBe("config_changed");
    expect((await svc.status(project({ source: "https://git.example.com/dono/outro.git" }))).state).toBe("config_changed");
    expect(remote).not.toHaveBeenCalled();
  });
});

describe("comparação com a ponta da branch", () => {
  it("mesmo commit: atualizado", async () => {
    const s = await svc.status(project());
    expect(s).toMatchObject({ state: "up_to_date", branch: "main", remoteCommit: A.slice(0, 7), deployedCommit: A.slice(0, 7), reason: null });
    expect(s.checkedAt).toBe(new Date(clock).toISOString());
  });

  it("commit remoto diferente: atualização disponível, com o commit curto", async () => {
    remote.mockResolvedValue({ ok: true, commit: B });
    const s = await svc.status(project());
    expect(s).toMatchObject({ state: "update_available", remoteCommit: B.slice(0, 7), deployedCommit: A.slice(0, 7) });
  });

  it("consulta o repositório e a BRANCH do projeto (sem o cliente escolher nada)", async () => {
    credential = { username: "x-access-token", token: TOKEN };
    const p = project({ branch: "sandbox", deployedBranch: "sandbox" });
    await svc.status(p);
    expect(remote).toHaveBeenCalledWith({
      source: p.source,
      branch: "sandbox",
      pin: null,
      credential,
      timeoutMs: expect.any(Number),
    });
    expect(resolve).toHaveBeenCalledWith(p.source);
  });

  it("branch ausente no projeto consulta 'main'", async () => {
    await svc.status(project({ branch: null, deployedBranch: "main" }));
    expect(remote.mock.calls[0]?.[0]).toMatchObject({ branch: "main" });
    expect(branchOf(project({ branch: "  " }))).toBe("main");
  });

  it("dois projetos com o mesmo repositório e branches diferentes são avaliados cada um na sua branch", async () => {
    remote.mockImplementation(async (i: { branch: string }) => ({ ok: true, commit: i.branch === "main" ? A : B }));
    const prod = project({ id: "prod", branch: "main", deployedBranch: "main", deployedCommit: A });
    const sbx = project({ id: "sbx", branch: "sandbox", deployedBranch: "sandbox", deployedCommit: A });
    const [x, y] = await svc.statuses([prod, sbx]);
    expect(x).toMatchObject({ projectId: "prod", state: "up_to_date", branch: "main" });
    expect(y).toMatchObject({ projectId: "sbx", state: "update_available", branch: "sandbox" });
  });

  it("deploy novo: o estado acompanha o commit no ar e a consulta anterior ao deploy não vale", async () => {
    remote.mockResolvedValue({ ok: true, commit: B });
    const antes = project();
    expect((await svc.status(antes)).state).toBe("update_available");
    // o deploy baixou B (depois da consulta): nova consulta, não o resultado velho
    clock += 1_000;
    const depois = project({ deployedCommit: B, lastDeployAt: new Date(clock).toISOString() });
    expect(svc.statusOf(depois).state).toBe("checking");
    expect((await svc.status(depois)).state).toBe("up_to_date");
    expect(remote).toHaveBeenCalledTimes(2);
  });
});

describe("cache", () => {
  it("dentro do prazo não consulta de novo; vencido, consulta e mantém o resultado antigo enquanto isso", async () => {
    const p = project();
    await svc.status(p);
    await svc.status(p);
    expect(remote).toHaveBeenCalledTimes(1);

    clock += UPDATE_CHECK_TTL_MS * 1.5;
    let liberar!: () => void;
    remote.mockImplementationOnce(() => new Promise((r) => (liberar = () => r({ ok: true, commit: B }))));
    vi.useFakeTimers();
    const pendente = svc.status(p);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_WAIT_MS + 10);
    const parcial = await pendente;
    // a consulta nova ainda não voltou: segue o estado anterior (sem piscar para "verificando")
    expect(parcial.state).toBe("up_to_date");
    liberar();
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.statusOf(p).state).toBe("update_available");
    expect(remote).toHaveBeenCalledTimes(2);
  });

  it("trocar de branch ou de repositório invalida o cache", async () => {
    await svc.status(project());
    const outraBranch = project({ branch: "sandbox", deployedBranch: "sandbox" });
    expect(svc.statusOf(outraBranch).state).toBe("checking");
    await svc.status(outraBranch);
    expect(remote).toHaveBeenCalledTimes(2);
    expect(remote.mock.calls[1]?.[0]).toMatchObject({ branch: "sandbox" });

    const outroRepo = project({ source: "https://git.example.com/dono/outro.git", deployedSource: "https://git.example.com/dono/outro.git" });
    expect(svc.statusOf(outroRepo).state).toBe("checking");
  });

  it("invalidate/invalidateAll esquecem o resultado", async () => {
    const p = project();
    await svc.status(p);
    svc.invalidate(p.id);
    expect(svc.statusOf(p).state).toBe("checking");
    await svc.status(p);
    svc.invalidateAll();
    expect(svc.statusOf(p).state).toBe("checking");
  });

  it("consultas simultâneas do mesmo projeto viram uma só", async () => {
    const p = project();
    await Promise.all([svc.status(p), svc.status(p), svc.status(p)]);
    expect(remote).toHaveBeenCalledTimes(1);
  });

  it("'Verificar agora' força nova consulta, mas só depois do intervalo mínimo", async () => {
    const p = project();
    await svc.status(p);
    await svc.status(p, { force: true });
    expect(remote).toHaveBeenCalledTimes(1); // repetido logo em seguida reaproveita
    clock += UPDATE_CHECK_MANUAL_MIN_MS + 1;
    remote.mockResolvedValue({ ok: true, commit: B });
    const s = await svc.status(p, { force: true });
    expect(remote).toHaveBeenCalledTimes(2);
    expect(s.state).toBe("update_available");
  });

  it("o jitter varia o prazo para os projetos não consultarem todos juntos", async () => {
    const baixo = new UpdateCheckService({
      credentialFor: async () => null,
      resolveTarget: resolve as unknown as UpdateCheckDeps["resolveTarget"],
      remoteBranchCommit: remote as unknown as UpdateCheckDeps["remoteBranchCommit"],
      now: () => clock,
      random: () => 0,
    });
    const p = project();
    await baixo.status(p);
    clock += UPDATE_CHECK_TTL_MS * 0.9; // com -20% o prazo é 0,8 do TTL: já venceu
    await baixo.status(p);
    expect(remote).toHaveBeenCalledTimes(2);
  });

  it("esquece o cache de projetos que não existem mais", async () => {
    const p = project();
    await svc.statuses([p]);
    await svc.statuses([]);
    expect(svc.statusOf(p).state).toBe("checking");
  });
});

describe("falha de verificação NÃO é 'sem atualização'", () => {
  it.each([
    ["unreachable", "unreachable"],
    ["timeout", "timeout"],
    ["invalid_token", "auth"],
    ["auth_required", "auth"],
    ["no_permission", "no_permission"],
    ["not_found", "not_found"],
    ["not_found_or_no_access", "not_found"],
    ["branch_not_found", "branch_not_found"],
    ["redirected", "redirected"],
    ["blocked_host", "blocked_host"],
    ["unsupported_host", "unsupported"],
    ["unknown", "unknown"],
    ["invalid_source", "unknown"],
  ])("motivo %s vira o código %s e o estado é 'error'", async (git, esperado) => {
    remote.mockResolvedValue({ ok: false, reason: git });
    const s = await svc.status(project());
    expect(s).toMatchObject({ state: "error", reason: esperado, remoteCommit: null });
    expect(updateReasonOf(git)).toBe(esperado);
  });

  it("endereço bloqueado (loopback/metadados) é erro e o git nem roda", async () => {
    resolve.mockResolvedValue({ ok: false, reason: "blocked_host" });
    const s = await svc.status(project());
    expect(s).toMatchObject({ state: "error", reason: "blocked_host" });
    expect(remote).not.toHaveBeenCalled();
  });

  it("exceção inesperada vira erro 'unknown' sem repassar a mensagem (que poderia ter o token)", async () => {
    remote.mockRejectedValue(new Error(`falhou com ${TOKEN}`));
    const s = await svc.status(project());
    expect(s).toMatchObject({ state: "error", reason: "unknown" });
    expect(JSON.stringify(s)).not.toContain(TOKEN);
  });

  it("consulta que pendura é cortada pelo teto e vira timeout (a vaga é devolvida)", async () => {
    vi.useFakeTimers();
    remote.mockImplementation(() => new Promise(() => undefined));
    const pendente = svc.status(project());
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_WAIT_MS + 10);
    expect((await pendente).state).toBe("checking");
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_HARD_TIMEOUT_MS);
    expect(svc.statusOf(project())).toMatchObject({ state: "error", reason: "timeout" });
  });

  it("recuo exponencial: 30 s, 1 min, 2 min… até o teto; sucesso zera", async () => {
    remote.mockResolvedValue({ ok: false, reason: "unreachable" });
    const p = project();
    let espera = UPDATE_CHECK_ERROR_BASE_MS;
    for (let i = 0; i < 12; i++) {
      await svc.status(p);
      const chamadas = remote.mock.calls.length;
      clock += Math.min(espera, UPDATE_CHECK_ERROR_MAX_MS) - 1_000; // ainda dentro do recuo
      await svc.status(p);
      expect(remote.mock.calls.length).toBe(chamadas);
      clock += 1_001;
      espera = Math.min(espera * 2, UPDATE_CHECK_ERROR_MAX_MS);
    }
    // depois de muitas falhas o recuo parou no teto
    await svc.status(p);
    const antes = remote.mock.calls.length;
    clock += UPDATE_CHECK_ERROR_MAX_MS - 1_000;
    await svc.status(p);
    expect(remote.mock.calls.length).toBe(antes);
    clock += 1_001;
    await svc.status(p);
    expect(remote.mock.calls.length).toBe(antes + 1);

    remote.mockResolvedValue({ ok: true, commit: A });
    clock += UPDATE_CHECK_ERROR_MAX_MS + 1;
    expect((await svc.status(p)).state).toBe("up_to_date");
    // sucesso: o próximo prazo é o do TTL
    clock += UPDATE_CHECK_TTL_MS + 1;
    remote.mockResolvedValue({ ok: false, reason: "timeout" });
    await svc.status(p);
    clock += UPDATE_CHECK_ERROR_BASE_MS + 1; // volta ao recuo inicial
    await svc.status(p);
    expect(svc.statusOf(p).state).toBe("error");
  });

  it("erro aparece como erro nas chamadas seguintes (o cache de falha não vira 'atualizado')", async () => {
    remote.mockResolvedValue({ ok: false, reason: "timeout" });
    const p = project();
    await svc.status(p);
    expect((await svc.status(p)).state).toBe("error");
    expect(svc.statusOf(p).state).toBe("error");
  });
});

describe("isolamento entre projetos", () => {
  it("um projeto que pendura ou falha não impede os outros de serem verificados", async () => {
    vi.useFakeTimers();
    remote.mockImplementation(async (i: { source: string }) => {
      if (i.source.includes("lento")) return new Promise(() => undefined);
      if (i.source.includes("ruim")) return { ok: false, reason: "invalid_token" };
      return { ok: true, commit: A };
    });
    const mk = (id: string, nome: string) =>
      project({ id, source: `https://git.example.com/dono/${nome}.git`, deployedSource: `https://git.example.com/dono/${nome}.git` });
    const lento = mk("lento", "lento");
    const ruim = mk("ruim", "ruim");
    const bom = mk("bom", "bom");
    const lista = svc.statuses([lento, ruim, bom]);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_WAIT_MS + 10);
    const [a, b, c] = await lista;
    expect(a?.state).toBe("checking");
    expect(b).toMatchObject({ state: "error", reason: "auth" });
    expect(c?.state).toBe("up_to_date");
  });

  it("limita as consultas simultâneas; as demais esperam a fila", async () => {
    let ativas = 0;
    let pico = 0;
    const liberar: Array<() => void> = [];
    remote.mockImplementation(
      () =>
        new Promise((r) => {
          ativas += 1;
          pico = Math.max(pico, ativas);
          liberar.push(() => {
            ativas -= 1;
            r({ ok: true, commit: A });
          });
        }),
    );
    const projetos = Array.from({ length: 8 }, (_, i) => project({ id: `p${i}` }));
    vi.useFakeTimers();
    const lista = svc.statuses(projetos);
    await vi.advanceTimersByTimeAsync(10);
    expect(liberar).toHaveLength(UPDATE_CHECK_CONCURRENCY);
    while (liberar.length > 0) {
      liberar.shift()?.();
      await vi.advanceTimersByTimeAsync(10);
    }
    const res = await lista;
    expect(pico).toBeLessThanOrEqual(UPDATE_CHECK_CONCURRENCY);
    expect(res.every((s) => s.state === "up_to_date")).toBe(true);
    expect(remote).toHaveBeenCalledTimes(8);
  });
});

describe("sem vazamento", () => {
  it("o estado nunca carrega o token, nem o hash completo", async () => {
    credential = { username: "x-access-token", token: TOKEN };
    remote.mockResolvedValue({ ok: true, commit: B });
    const s = await svc.status(project());
    const json = JSON.stringify(s);
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain(B);
    expect(Object.keys(s).sort()).toEqual(["branch", "checkedAt", "deployedCommit", "projectId", "reason", "remoteCommit", "state"]);
  });
});

describe("fila de consultas", () => {
  it("quem espera é atendido pelo projeto verificado há mais tempo (nunca verificado primeiro)", async () => {
    // dois projetos já verificados, um mais antigo que o outro
    const velho = project({ id: "velho", source: "https://git.example.com/dono/velho.git", deployedSource: "https://git.example.com/dono/velho.git" });
    const novo = project({ id: "novo", source: "https://git.example.com/dono/novo.git", deployedSource: "https://git.example.com/dono/novo.git" });
    await svc.status(velho);
    clock += 1_000;
    await svc.status(novo);
    clock += UPDATE_CHECK_TTL_MS * 2;
    remote.mockClear();

    vi.useFakeTimers();
    const liberar: Array<() => void> = [];
    const ordem: string[] = [];
    remote.mockImplementation((i: { source: string }) => {
      ordem.push(i.source);
      return new Promise((r) => liberar.push(() => r({ ok: true, commit: A })));
    });
    const mk = (id: string) => project({ id, source: `https://git.example.com/dono/${id}.git`, deployedSource: `https://git.example.com/dono/${id}.git` });
    const trabalho = svc.statuses([mk("l1"), mk("l2"), mk("l3"), velho, novo, mk("inedito")]);
    await vi.advanceTimersByTimeAsync(10);
    expect(ordem).toHaveLength(UPDATE_CHECK_CONCURRENCY);
    for (let i = 0; i < 3; i++) {
      liberar.shift()?.();
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(ordem.slice(3).map((u) => u.split("/").pop())).toEqual(["inedito.git", "velho.git", "novo.git"]);
    while (liberar.length) {
      liberar.shift()?.();
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_WAIT_MS);
    await trabalho;
  });

  it("o teto de tempo registra o resultado mas NÃO devolve a vaga enquanto o trabalho não termina", async () => {
    vi.useFakeTimers();
    const soltar: Array<() => void> = [];
    remote.mockImplementation(() => new Promise((r) => soltar.push(() => r({ ok: true, commit: A }))));
    const mk = (id: string) => project({ id });
    const tres = [mk("a"), mk("b"), mk("c")];
    void svc.statuses(tres);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_HARD_TIMEOUT_MS + 10);
    // os três estouraram o teto (erro registrado), mas seguem ocupando as vagas
    expect(svc.statusOf(tres[0] as Project)).toMatchObject({ state: "error", reason: "timeout" });
    void svc.statuses([mk("d")]);
    await vi.advanceTimersByTimeAsync(10);
    expect(remote).toHaveBeenCalledTimes(3);
    // um deles termina de verdade: o quarto começa
    soltar[0]?.();
    await vi.advanceTimersByTimeAsync(10);
    expect(remote).toHaveBeenCalledTimes(4);
    soltar.slice(1).forEach((f) => f());
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_WAIT_MS);
  });

  it("trabalho pendurado para sempre: o limite final devolve a vaga e a fila volta a andar (sonda do revisor)", async () => {
    vi.useFakeTimers();
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    resolve.mockImplementation((source: string) =>
      /\/(h1|h2|h3)\.git$/.test(source) ? new Promise(() => undefined) : Promise.resolve({ ok: true, pin: null }),
    );
    remote.mockResolvedValue({ ok: true, commit: B });
    const mk = (id: string) => project({ id, source: `https://git.example.com/d/${id}.git`, deployedSource: `https://git.example.com/d/${id}.git` });
    const penduradas = [mk("h1"), mk("h2"), mk("h3")];
    const saudavel = mk("saudavel");
    void svc.statuses(penduradas);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_HARD_TIMEOUT_MS + 10);
    // antes do limite final as três vagas seguem ocupadas: o saudável espera
    void svc.statuses([saudavel]);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_WAIT_MS);
    expect(svc.statusOf(saudavel).state).toBe("checking");
    // passado o limite final as vagas voltam e o saudável é verificado
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_SLOT_TIMEOUT_MS);
    expect(svc.statusOf(saudavel).state).toBe("update_available");
    expect(aviso).toHaveBeenCalledTimes(3);
    expect(aviso.mock.calls[0]?.[0]).toContain("h1");
    expect(aviso.mock.calls[0]?.[0]).not.toContain("git.example.com");
    aviso.mockRestore();
  });
});

