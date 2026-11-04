/**
 * project-database-section.test.tsx — aba Banco do projeto: visão geral, estados sem suporte/indisponível, seleção de
 * tabelas, liberar a edição (uma vez), contagem regressiva, esvaziar, zerar, comandos do framework, restaurar, console
 * SQL com várias instruções (leitura direta, escrita só com a edição liberada) e o andamento dos trabalhos.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseJob, DatabaseOverview, DatabaseSqlResult, DatabaseSqlRun, DatabaseUnlockStatus } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});
const copyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", () => ({ copyText: copyMock }));

import { ApiRequestError } from "@/lib/api";
import { setLocale } from "@/i18n/core";
import { ProjectDatabaseSection } from "@/components/project/ProjectDatabaseSection";

const overview = (over: Partial<DatabaseOverview> = {}): DatabaseOverview => ({
  state: "ok",
  code: null,
  message: null,
  engine: "postgres",
  service: "db",
  version: "16.2",
  database: "appdb",
  sizeBytes: 9 * 1024 * 1024,
  tables: [
    { schema: "public", name: "users", rows: 1200, sizeBytes: 65536 },
    { schema: "public", name: "posts", rows: null, sizeBytes: null },
    { schema: "audit", name: "log", rows: 3, sizeBytes: 8192 },
  ],
  framework: null,
  commands: [],
  development: false,
  ...over,
});

const LARAVEL = [
  { id: "laravel-migrate-fresh-seed", framework: "laravel", display: "php artisan migrate:fresh --seed --force --no-interaction --no-ansi", dropsData: true },
  { id: "laravel-migrate", framework: "laravel", display: "php artisan migrate --force --no-interaction --no-ansi", dropsData: false },
  { id: "laravel-seed", framework: "laravel", display: "php artisan db:seed --force --no-interaction --no-ansi", dropsData: false },
] as const;

const job = (over: Partial<DatabaseJob> = {}): DatabaseJob => ({
  id: "j1",
  projectId: "p1",
  kind: "reset",
  status: "running",
  startedAt: "2026-10-30T12:00:00Z",
  finishedAt: null,
  steps: [
    { id: "backup", status: "skipped" },
    { id: "action", status: "running" },
  ],
  backupFileName: null,
  backupValidation: null,
  output: null,
  run: null,
  error: null,
  ...over,
});

const DONE_STEPS = [
  { id: "backup" as const, status: "skipped" as const },
  { id: "action" as const, status: "done" as const },
];

const UNLOCKED: DatabaseUnlockStatus = { unlocked: true, expiresAt: "2026-10-30T12:30:00Z", remainingMs: 1_800_000, duration: "30m", renewOnUse: true, lastEnd: null };
const LOCKED: DatabaseUnlockStatus = { unlocked: false, expiresAt: null, remainingMs: null, duration: "30m", renewOnUse: true, lastEnd: null };

const run = (over: Partial<DatabaseSqlRun> = {}): DatabaseSqlRun => ({
  statements: [
    { index: 1, verb: "select", kind: "read", result: { columns: ["id", "name"], rows: [["1", "Ana"], ["2", null]], truncated: false, empty: false }, affected: null },
  ],
  total: 1,
  truncated: false,
  transaction: false,
  ...over,
});

let view: DatabaseOverview;
let unlockStatus: DatabaseUnlockStatus;
let handlers: Record<string, (body: Record<string, unknown> | undefined) => unknown>;
let posts: Array<{ url: string; body: Record<string, unknown> }>;

beforeEach(() => {
  view = overview();
  unlockStatus = UNLOCKED;
  posts = [];
  handlers = {};
  apiFetchMock.mockReset();
  copyMock.mockReset();
  apiFetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    if (url === "/api/auth/email-code") return { enabled: false };
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    if (init?.method === "POST") posts.push({ url, body: body! });
    const h = handlers[`${init?.method ?? "GET"} ${url}`];
    if (h) {
      const out = h(body);
      if (out instanceof Error) throw out;
      return out;
    }
    if (url === "/api/projects/p1/database") return view;
    if (url === "/api/projects/p1/database/unlock") return unlockStatus;
    throw new Error(`sem dublê para ${url}`);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setLocale("pt-BR", { persist: false });
});

function renderSection(tickMs?: number) {
  return render(
    <MemoryRouter>
      <ProjectDatabaseSection projectId="p1" projectName="Loja" pollMs={5} {...(tickMs !== undefined ? { tickMs } : {})} />
    </MemoryRouter>,
  );
}

async function loaded() {
  renderSection();
  await screen.findByTestId("database-overview");
  await screen.findByTestId(unlockStatus.unlocked ? "database-unlocked" : "database-locked");
}

const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

async function dialogOpen() {
  return screen.findByTestId("database-action-dialog");
}

async function typeName(name = "Loja") {
  const dialog = await dialogOpen();
  type(within(dialog).getByLabelText(/nome do projeto/i), name);
  return dialog;
}

const confirmBtn = () => screen.getByRole("button", { name: /confirmar e executar/i });

describe("visão geral", () => {
  it("mostra motor, versão, banco, tamanho e as tabelas com linhas e tamanho aproximados", async () => {
    await loaded();
    const facts = screen.getByTestId("database-overview");
    expect(facts).toHaveTextContent("PostgreSQL");
    expect(facts).toHaveTextContent("16.2");
    expect(facts).toHaveTextContent("appdb");
    expect(facts).toHaveTextContent("9.0 MiB");
    expect(screen.getByTestId("db-table-users")).toHaveTextContent("~1.200");
    expect(screen.getByTestId("db-table-users")).toHaveTextContent("64.0 KiB");
    expect(screen.getByTestId("db-table-posts")).toHaveTextContent("—");
    expect(screen.getByTestId("db-table-audit.log")).toBeInTheDocument();
    expect(screen.getByText(/3 tabelas/)).toBeInTheDocument();
  });

  it("projeto de desenvolvimento ganha o selo", async () => {
    view = overview({ development: true });
    await loaded();
    expect(screen.getByText("Projeto de desenvolvimento")).toBeInTheDocument();
  });

  it("Atualizar consulta de novo", async () => {
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /atualizar/i }));
    await waitFor(() => expect(apiFetchMock.mock.calls.filter((c) => c[0] === "/api/projects/p1/database")).toHaveLength(2));
  });

  it("banco sem tabelas", async () => {
    view = overview({ tables: [] });
    await loaded();
    expect(screen.getByTestId("database-no-tables")).toBeInTheDocument();
  });

  it("MongoDB: estado de 'ainda sem suporte', sem tabelas nem console, com o atalho de backups", async () => {
    view = overview({ state: "unsupported", code: "unsupported_engine", message: "O banco deste projeto é MongoDB.", engine: "mongo", tables: [] });
    renderSection();
    const box = await screen.findByTestId("database-unsupported");
    expect(box).toHaveTextContent("Ainda sem suporte");
    expect(box).toHaveTextContent("MongoDB");
    expect(screen.queryByText("Console SQL")).not.toBeInTheDocument();
    expect(screen.queryByText("Tabelas")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /ir para backups/i })).toHaveAttribute("href", "/projects/p1/backups");
  });

  it("banco indisponível agora", async () => {
    view = overview({ state: "unavailable", code: "not_running", message: "O container do banco (db) não está em execução.", tables: [] });
    renderSection();
    expect(await screen.findByTestId("database-unavailable")).toHaveTextContent("não está em execução");
  });

  it("erro ao carregar: aviso e dá para tentar de novo", async () => {
    handlers["GET /api/projects/p1/database"] = () => new ApiRequestError(500, "internal_error", "Falhou");
    renderSection();
    expect(await screen.findByRole("alert")).toHaveTextContent("Falhou");
    handlers = {};
    fireEvent.click(screen.getByRole("button", { name: /atualizar/i }));
    await screen.findByTestId("database-overview");
  });
});

describe("restaurar backup", () => {
  it("leva ao fluxo existente da aba Backups, sem duplicá-lo", async () => {
    await loaded();
    expect(screen.getByRole("link", { name: /ir para backups/i })).toHaveAttribute("href", "/projects/p1/backups");
  });
});

describe("liberar a edição", () => {
  it("bloqueado: mostra o aviso e o botão; liberar pede senha + código, backup marcado, e depois mostra o selo", async () => {
    unlockStatus = LOCKED;
    handlers["POST /api/projects/p1/database/unlock"] = () => {
      unlockStatus = UNLOCKED;
      return { job: job({ kind: "unlock", status: "success", steps: [{ id: "backup", status: "done" }, { id: "action", status: "done" }], backupFileName: "b.7z" }) };
    };
    await loaded();
    expect(screen.getByTestId("database-locked")).toHaveTextContent("Edição do banco bloqueada");
    fireEvent.click(within(screen.getByTestId("database-locked")).getByRole("button", { name: /liberar edição/i }));
    const dialog = await screen.findByTestId("database-unlock-dialog");
    const submit = within(dialog).getByRole("button", { name: /liberar edição/i });
    expect(submit).toBeDisabled();
    expect(within(dialog).getByLabelText(/backup completo do projeto ao liberar/i)).toBeChecked();
    type(within(dialog).getByLabelText(/senha do painel/i), "Senha123");
    type(within(dialog).getByLabelText(/código do app/i), "123456");
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await screen.findByText("Concluído");
    expect(posts[0]).toEqual({ url: "/api/projects/p1/database/unlock", body: { currentPassword: "Senha123", code: "123456", backup: "full" } });
    expect(screen.getByText(/Backup feito: b.7z/)).toBeInTheDocument();
    await screen.findByTestId("database-unlocked");
    fireEvent.click(within(dialog).getByRole("button", { name: /fechar/i }));
    expect(screen.queryByTestId("database-unlock-dialog")).not.toBeInTheDocument();
  });

  it("projeto de desenvolvimento: o backup ao liberar começa desmarcado e vai como 'none'", async () => {
    view = overview({ development: true });
    unlockStatus = LOCKED;
    handlers["POST /api/projects/p1/database/unlock"] = () => ({ job: job({ kind: "unlock", status: "success", steps: DONE_STEPS }) });
    await loaded();
    fireEvent.click(within(screen.getByTestId("database-locked")).getByRole("button", { name: /liberar edição/i }));
    const dialog = await screen.findByTestId("database-unlock-dialog");
    expect(within(dialog).getByLabelText(/backup completo do projeto ao liberar/i)).not.toBeChecked();
    expect(dialog).toHaveTextContent("começa desmarcado");
    type(within(dialog).getByLabelText(/senha do painel/i), "x");
    type(within(dialog).getByLabelText(/código do app/i), "1");
    fireEvent.click(within(dialog).getByRole("button", { name: /liberar edição/i }));
    await screen.findByText("Concluído");
    expect(posts[0]!.body.backup).toBe("none");
  });

  it("senha errada: mostra o erro; backup que falha avisa que a edição não foi liberada", async () => {
    unlockStatus = LOCKED;
    handlers["POST /api/projects/p1/database/unlock"] = () => new ApiRequestError(401, "invalid_current_password", "A senha atual está incorreta.");
    await loaded();
    fireEvent.click(within(screen.getByTestId("database-locked")).getByRole("button", { name: /liberar edição/i }));
    const dialog = await screen.findByTestId("database-unlock-dialog");
    type(within(dialog).getByLabelText(/senha do painel/i), "x");
    type(within(dialog).getByLabelText(/código do app/i), "1");
    fireEvent.click(within(dialog).getByRole("button", { name: /liberar edição/i }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("senha atual está incorreta");
    handlers["POST /api/projects/p1/database/unlock"] = () => ({
      job: job({ kind: "unlock", status: "failed", steps: [{ id: "backup", status: "failed" }, { id: "action", status: "pending" }], error: { code: "backup_failed", message: "x", detail: "sem espaço" } }),
      alertWarning: "SMTP fora",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /liberar edição/i }));
    expect(await screen.findByText(/A ação não foi concluída/)).toBeInTheDocument();
    expect(screen.getByTestId("database-locked")).toBeInTheDocument();
    expect(screen.getByText(/aviso por e-mail não pôde ser enviado/)).toBeInTheDocument();
  });

  it("desbloqueado: selo com a contagem regressiva e 'Bloquear agora'", async () => {
    unlockStatus = { ...UNLOCKED, remainingMs: 125_000 };
    handlers["POST /api/projects/p1/database/lock"] = () => {
      unlockStatus = LOCKED;
      return LOCKED;
    };
    await loaded();
    expect(screen.getByTestId("database-unlocked")).toHaveTextContent(/Edição liberada — expira em 0[12]:\d\d/);
    fireEvent.click(screen.getByRole("button", { name: /bloquear agora/i }));
    await screen.findByTestId("database-locked");
    expect(posts[0]!.url).toBe("/api/projects/p1/database/lock");
  });

  it("falha ao bloquear: avisa", async () => {
    handlers["POST /api/projects/p1/database/lock"] = () => new ApiRequestError(500, "internal_error", "x");
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /bloquear agora/i }));
    expect(await screen.findByText(/Não foi possível bloquear agora/)).toBeInTheDocument();
    expect(screen.getByTestId("database-unlocked")).toBeInTheDocument();
  });

  it("até encerrar a sessão: o selo não tem contagem", async () => {
    unlockStatus = { ...UNLOCKED, duration: "session", remainingMs: null, expiresAt: null };
    await loaded();
    expect(screen.getByTestId("database-unlocked")).toHaveTextContent("até encerrar a sessão");
  });

  it("horas na contagem: h:mm:ss", async () => {
    unlockStatus = { ...UNLOCKED, remainingMs: 3_700_000 };
    await loaded();
    expect(screen.getByTestId("database-unlocked")).toHaveTextContent(/expira em 1:01:\d\d/);
  });

  it("o prazo acaba: a contagem chega a zero, o painel volta ao bloqueio sozinho e explica", async () => {
    unlockStatus = { ...UNLOCKED, remainingMs: 120 };
    let gets = 0;
    handlers["GET /api/projects/p1/database/unlock"] = () => {
      gets++;
      return gets === 1 ? unlockStatus : LOCKED;
    };
    renderSection(20);
    await screen.findByTestId("database-unlocked");
    const locked = await screen.findByTestId("database-locked", undefined, { timeout: 3000 });
    expect(locked).toHaveTextContent("A liberação da edição acabou");
    expect(gets).toBeGreaterThanOrEqual(2);
  });

  it("o servidor ainda diz liberado ao fim do prazo local (renovado): continua liberado", async () => {
    unlockStatus = { ...UNLOCKED, remainingMs: 100 };
    let gets = 0;
    handlers["GET /api/projects/p1/database/unlock"] = () => {
      gets++;
      return gets === 1 ? unlockStatus : { ...UNLOCKED, remainingMs: 600_000 };
    };
    renderSection(20);
    await screen.findByTestId("database-unlocked");
    await waitFor(() => expect(gets).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.getByTestId("database-unlocked")).toHaveTextContent(/expira em 1\d:\d\d|expira em 09:\d\d/));
  });

  it("bloqueado: esvaziar, zerar e comando levam ao diálogo de liberar, sem chamar o servidor", async () => {
    unlockStatus = LOCKED;
    view = overview({ framework: "laravel", commands: [...LARAVEL] });
    await loaded();
    fireEvent.click(screen.getByLabelText("Selecionar a tabela users"));
    fireEvent.click(screen.getByRole("button", { name: /esvaziar selecionadas/i }));
    await screen.findByTestId("database-unlock-dialog");
    fireEvent.click(screen.getByRole("button", { name: /cancelar/i }));
    fireEvent.click(screen.getByRole("button", { name: /zerar o banco/i }));
    await screen.findByTestId("database-unlock-dialog");
    fireEvent.click(screen.getByRole("button", { name: /cancelar/i }));
    fireEvent.click(within(screen.getByTestId("db-command-laravel-seed")).getByRole("button", { name: /executar/i }));
    await screen.findByTestId("database-unlock-dialog");
    expect(posts).toHaveLength(0);
    expect(screen.queryByTestId("database-action-dialog")).not.toBeInTheDocument();
  });

  it("a liberação acabou no servidor (unlock_required): avisa e volta ao bloqueio", async () => {
    handlers["POST /api/projects/p1/database/reset"] = () => {
      unlockStatus = LOCKED;
      return new ApiRequestError(403, "unlock_required", "x");
    };
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /zerar o banco/i }));
    await typeName();
    fireEvent.click(confirmBtn());
    expect(await screen.findByRole("alert")).toHaveTextContent("A edição do banco está bloqueada");
    await screen.findByTestId("database-locked");
  });
});

describe("esvaziar tabelas", () => {
  it("o botão só vale com tabelas escolhidas; selecionar todas marca e desmarca tudo", async () => {
    await loaded();
    const btn = () => screen.getByRole("button", { name: /esvaziar selecionadas/i });
    expect(btn()).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Selecionar todas as tabelas"));
    expect(btn()).toHaveTextContent("(3)");
    fireEvent.click(screen.getByLabelText("Selecionar todas as tabelas"));
    expect(btn()).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Selecionar a tabela users"));
    expect(btn()).toHaveTextContent("(1)");
    fireEvent.click(screen.getByLabelText("Selecionar a tabela users"));
    expect(btn()).toBeDisabled();
  });

  it("fluxo: diálogo leve (escolha do backup, sem senha nem nome), andamento e resultado", async () => {
    handlers["POST /api/projects/p1/database/truncate"] = () => ({ job: job({ kind: "truncate", steps: [{ id: "backup", status: "running" }, { id: "action", status: "pending" }] }) });
    let polls = 0;
    handlers["GET /api/projects/p1/database/jobs/j1"] = () => {
      polls++;
      return polls < 2
        ? job({ kind: "truncate", steps: [{ id: "backup", status: "done" }, { id: "action", status: "running" }], backupFileName: "2026-10-30_12-00.7z" })
        : job({ kind: "truncate", status: "success", steps: [{ id: "backup", status: "done" }, { id: "action", status: "done" }], backupFileName: "2026-10-30_12-00.7z" });
    };
    await loaded();
    fireEvent.click(screen.getByLabelText("Selecionar a tabela users"));
    fireEvent.click(screen.getByLabelText("Selecionar a tabela audit.log"));
    fireEvent.click(screen.getByRole("button", { name: /esvaziar selecionadas/i }));
    const dialog = await dialogOpen();
    expect(dialog).toHaveTextContent("2 tabelas: users, audit.log");
    expect(within(dialog).queryByLabelText(/senha do painel/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/nome do projeto/i)).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText("Backup completo do banco antes")).toBeChecked();
    fireEvent.click(confirmBtn());
    await screen.findByTestId("database-job");
    expect(posts[0]).toEqual({
      url: "/api/projects/p1/database/truncate",
      body: { tables: [{ schema: "public", name: "users" }, { schema: "audit", name: "log" }], backup: "full" },
    });
    await screen.findByText("Concluído");
    expect(screen.getByText(/Backup feito: 2026-10-30_12-00.7z/)).toBeInTheDocument();
    await waitFor(() => expect(apiFetchMock.mock.calls.filter((c) => c[0] === "/api/projects/p1/database").length).toBeGreaterThanOrEqual(2));
    fireEvent.click(screen.getByRole("button", { name: /fechar/i }));
    expect(screen.queryByTestId("database-action-dialog")).not.toBeInTheDocument();
  });

  it("CASCADE só aparece no PostgreSQL, com aviso, e vai no pedido", async () => {
    handlers["POST /api/projects/p1/database/truncate"] = () => ({ job: job({ kind: "truncate", status: "success", steps: DONE_STEPS }) });
    await loaded();
    fireEvent.click(screen.getByLabelText(/também esvaziar as tabelas que dependem/i));
    expect(screen.getAllByRole("alert")[0]).toHaveTextContent("CASCADE esvazia");
    fireEvent.click(screen.getByLabelText("Selecionar a tabela posts"));
    fireEvent.click(screen.getByRole("button", { name: /esvaziar selecionadas/i }));
    const dialog = await dialogOpen();
    expect(dialog).toHaveTextContent("CASCADE esvazia");
    fireEvent.click(within(dialog).getByLabelText("Não fazer backup"));
    fireEvent.click(confirmBtn());
    await screen.findByText("Concluído");
    expect(posts[0]!.body).toMatchObject({ cascade: true, backup: "none", tables: [{ schema: "public", name: "posts" }] });
  });

  it("MySQL não oferece CASCADE e a tabela vai sem esquema", async () => {
    view = overview({ engine: "mysql", tables: [{ schema: null, name: "users", rows: 1, sizeBytes: 1 }] });
    handlers["POST /api/projects/p1/database/truncate"] = () => ({ job: job({ status: "success", steps: DONE_STEPS }) });
    await loaded();
    expect(screen.queryByLabelText(/CASCADE/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Selecionar a tabela users"));
    fireEvent.click(screen.getByRole("button", { name: /esvaziar selecionadas/i }));
    await dialogOpen();
    fireEvent.click(confirmBtn());
    await screen.findByText("Concluído");
    expect(posts[0]!.body.tables).toEqual([{ name: "users" }]);
    expect(posts[0]!.body.cascade).toBeUndefined();
  });

  it("Cancelar fecha o diálogo sem enviar nada", async () => {
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /zerar o banco/i }));
    await dialogOpen();
    fireEvent.click(screen.getByRole("button", { name: /cancelar/i }));
    expect(screen.queryByTestId("database-action-dialog")).not.toBeInTheDocument();
    expect(posts).toHaveLength(0);
  });
});

describe("zerar o banco", () => {
  it("projeto de desenvolvimento: o padrão do backup é 'Não fazer backup'", async () => {
    view = overview({ development: true });
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /zerar o banco/i }));
    const dialog = await dialogOpen();
    expect(within(dialog).getByLabelText("Não fazer backup")).toBeChecked();
    expect(dialog).toHaveTextContent("marcado como de desenvolvimento");
  });

  it("exige o nome do projeto digitado e envia com a escolha do backup", async () => {
    handlers["POST /api/projects/p1/database/reset"] = () => ({ job: job({ status: "success", steps: DONE_STEPS }) });
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /zerar o banco/i }));
    const dialog = await typeName("loja");
    expect(dialog).toHaveTextContent("Vai apagar as tabelas e os objetos comuns");
    expect(confirmBtn()).toBeDisabled();
    type(within(dialog).getByLabelText(/nome do projeto/i), "Loja");
    expect(confirmBtn()).toBeEnabled();
    fireEvent.click(confirmBtn());
    await screen.findByText("Concluído");
    expect(posts[0]!.body).toEqual({ backup: "full", confirm: "Loja" });
  });

  it("erro com código do banco usa o texto traduzido e o motivo à parte", async () => {
    handlers["POST /api/projects/p1/database/reset"] = () => new ApiRequestError(409, "database_busy", "x", { detail: "motivo qualquer" });
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /zerar o banco/i }));
    await typeName();
    fireEvent.click(confirmBtn());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Já há uma ação no banco");
    expect(alert).toHaveTextContent("Motivo: motivo qualquer");
  });

  it("mostra o erro do trabalho (com o motivo) e avisa quando o backup falha", async () => {
    handlers["POST /api/projects/p1/database/reset"] = () => ({
      job: job({
        status: "failed",
        steps: [{ id: "backup", status: "failed" }, { id: "action", status: "pending" }],
        error: { code: "backup_failed", message: "x", detail: "sem espaço em disco" },
      }),
      alertWarning: "SMTP fora",
    });
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /zerar o banco/i }));
    await typeName();
    fireEvent.click(confirmBtn());
    const failed = await screen.findByText(/A ação não foi concluída/);
    expect(failed.closest("p")).toHaveTextContent("Nada foi alterado");
    expect(failed.closest("p")).toHaveTextContent("Motivo: sem espaço em disco");
    expect(screen.getByTestId("database-step-backup")).toHaveTextContent("falhou");
    expect(screen.getByTestId("database-step-action")).toHaveTextContent("aguardando");
    expect(screen.getByText(/aviso por e-mail não pôde ser enviado: SMTP fora/)).toBeInTheDocument();
  });

  it("falha ao acompanhar o trabalho: avisa e continua tentando até terminar", async () => {
    handlers["POST /api/projects/p1/database/reset"] = () => ({ job: job() });
    let polls = 0;
    handlers["GET /api/projects/p1/database/jobs/j1"] = () => {
      polls++;
      if (polls === 1) return new ApiRequestError(0, "network_error", "rede");
      return job({ status: "success", steps: DONE_STEPS });
    };
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /zerar o banco/i }));
    await typeName();
    fireEvent.click(confirmBtn());
    await screen.findByText(/Não foi possível acompanhar o andamento/);
    await screen.findByText("Concluído");
    expect(screen.queryByText(/Não foi possível acompanhar/)).not.toBeInTheDocument();
  });
});

describe("andamento do trabalho", () => {
  it("o painel reiniciou (404): para de consultar e manda conferir o resultado", async () => {
    handlers["POST /api/projects/p1/database/reset"] = () => ({ job: job() });
    let polls = 0;
    handlers["GET /api/projects/p1/database/jobs/j1"] = () => {
      polls++;
      return new ApiRequestError(404, "job_not_found", "x");
    };
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /zerar o banco/i }));
    await typeName();
    fireEvent.click(confirmBtn());
    expect(await screen.findByTestId("database-job-gone")).toHaveTextContent("reiniciado");
    await new Promise((r) => setTimeout(r, 40));
    expect(polls).toBe(1);
    expect(screen.queryByText(/Executando/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /fechar/i })).toBeEnabled();
  });

  it("mostra se a validação por restauração do backup passou ou não foi executada", async () => {
    const done = { status: "success" as const, steps: [{ id: "backup" as const, status: "done" as const }, { id: "action" as const, status: "done" as const }], backupFileName: "b.7z" };
    handlers["POST /api/projects/p1/database/reset"] = () => ({ job: job({ ...done, backupValidation: "passed" }) });
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /zerar o banco/i }));
    await typeName();
    fireEvent.click(confirmBtn());
    expect(await screen.findByTestId("database-validation")).toHaveTextContent("passou");
    cleanup();
    handlers["POST /api/projects/p1/database/reset"] = () => ({ job: job({ ...done, backupValidation: "not_run" }) });
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /zerar o banco/i }));
    await typeName();
    fireEvent.click(confirmBtn());
    expect(await screen.findByTestId("database-validation")).toHaveTextContent("não executada");
  });
});

describe("comandos do framework", () => {
  it("mais de um container com artisan: pede a escolha, sugere o de entrada e reenvia com o serviço", async () => {
    view = overview({ framework: "laravel", commands: [...LARAVEL] });
    let calls = 0;
    handlers["POST /api/projects/p1/database/command"] = (body) => {
      calls++;
      if (calls === 1) return new ApiRequestError(409, "app_ambiguous", "x", { services: ["web", "worker"], suggested: "worker" });
      expect(body!.service).toBe("worker");
      return { job: job({ kind: "command", status: "success", steps: DONE_STEPS, output: "ok" }) };
    };
    await loaded();
    fireEvent.click(within(screen.getByTestId("db-command-laravel-migrate")).getByRole("button", { name: /executar/i }));
    const dialog = await dialogOpen();
    fireEvent.click(confirmBtn());
    const select = await within(dialog).findByLabelText(/qual container/i);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Mais de um container");
    expect(select).toHaveValue("worker");
    expect(within(select).getByRole("option", { name: /worker \(entrada do projeto\)/ })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "web" } });
    fireEvent.change(select, { target: { value: "worker" } });
    fireEvent.click(confirmBtn());
    await screen.findByTestId("database-output");
    expect(posts.at(-1)!.body.service).toBe("worker");
  });

  it("lista de serviços sem sugestão ou com formato inválido: usa o primeiro / ignora", async () => {
    view = overview({ framework: "laravel", commands: [...LARAVEL] });
    handlers["POST /api/projects/p1/database/command"] = () => new ApiRequestError(409, "app_ambiguous", "x", { services: ["web", "worker"], suggested: null });
    await loaded();
    fireEvent.click(within(screen.getByTestId("db-command-laravel-migrate")).getByRole("button", { name: /executar/i }));
    const dialog = await dialogOpen();
    fireEvent.click(confirmBtn());
    expect(await within(dialog).findByLabelText(/qual container/i)).toHaveValue("web");
    handlers["POST /api/projects/p1/database/command"] = () => new ApiRequestError(409, "app_ambiguous", "x", { services: [1], suggested: 2 });
    fireEvent.click(confirmBtn());
    await waitFor(() => expect(posts.length).toBe(2));
  });

  it("sem framework reconhecido explica o que é reconhecido", async () => {
    await loaded();
    expect(screen.getByTestId("database-no-commands")).toHaveTextContent("Laravel");
  });

  it("Laravel: confirmação simples (sem senha, backup nem nome); mostra a saída e o botão Copiar", async () => {
    view = overview({ framework: "laravel", commands: [...LARAVEL] });
    handlers["POST /api/projects/p1/database/command"] = () => ({
      job: job({ kind: "command", status: "success", steps: DONE_STEPS, output: "Migrating: users\nDone." }),
    });
    await loaded();
    expect(screen.getByText("Laravel detectado")).toBeInTheDocument();
    for (const c of LARAVEL) expect(screen.getByTestId(`db-command-${c.id}`)).toHaveTextContent(c.display);
    expect(screen.getByTestId("db-command-laravel-migrate-fresh-seed")).toHaveTextContent("Apaga todas as tabelas");
    fireEvent.click(within(screen.getByTestId("db-command-laravel-migrate")).getByRole("button", { name: /executar/i }));
    const dialog = await dialogOpen();
    expect(within(dialog).getByTestId("database-action-preview")).toHaveTextContent("php artisan migrate --force");
    expect(within(dialog).queryByLabelText(/nome do projeto/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Cópia de segurança antes")).not.toBeInTheDocument();
    fireEvent.click(confirmBtn());
    const output = await screen.findByTestId("database-output");
    expect(output).toHaveTextContent("Migrating: users");
    expect(posts[0]).toEqual({ url: "/api/projects/p1/database/command", body: { command: "laravel-migrate" } });
    fireEvent.click(within(output).getByRole("button", { name: /copiar/i }));
    await waitFor(() => expect(copyMock).toHaveBeenCalledWith("Migrating: users\nDone."));
  });

  it("migrate:fresh conta como zerar: exige o nome do projeto; saída vazia tem texto próprio", async () => {
    view = overview({ framework: "laravel", commands: [...LARAVEL] });
    handlers["POST /api/projects/p1/database/command"] = () => ({
      job: job({ kind: "command", status: "failed", steps: [{ id: "backup", status: "skipped" }, { id: "action", status: "failed" }], output: "", error: { code: "command_failed", message: "x", detail: "1" } }),
    });
    await loaded();
    fireEvent.click(within(screen.getByTestId("db-command-laravel-migrate-fresh-seed")).getByRole("button", { name: /executar/i }));
    const dialog = await typeName("outro");
    expect(dialog).toHaveTextContent("Apaga todas as tabelas e recria o banco");
    expect(confirmBtn()).toBeDisabled();
    type(within(dialog).getByLabelText(/nome do projeto/i), "Loja");
    fireEvent.click(confirmBtn());
    await screen.findByText(/O comando terminou com erro/);
    expect(screen.getByTestId("database-output")).toHaveTextContent("Sem saída.");
    expect(posts[0]!.body).toEqual({ command: "laravel-migrate-fresh-seed", confirm: "Loja" });
  });
});

describe("console SQL", () => {
  const sqlBox = () => screen.getByLabelText("Comando SQL");

  it("consulta de leitura roda direto, com a sessão, e mostra a tabela (NULL em destaque)", async () => {
    handlers["POST /api/projects/p1/database/sql/read"] = () => run();
    await loaded();
    type(sqlBox(), "select id, name from users");
    expect(screen.getByTestId("sql-kind")).toHaveTextContent("Consulta de leitura");
    fireEvent.click(screen.getByRole("button", { name: /executar consulta/i }));
    const table = await screen.findByTestId("sql-result");
    expect(table).toHaveTextContent("Ana");
    expect(table).toHaveTextContent("NULL");
    expect(table).toHaveTextContent("2 linhas");
    expect(posts[0]).toEqual({ url: "/api/projects/p1/database/sql/read", body: { sql: "select id, name from users" } });
    expect(screen.queryByTestId("database-action-dialog")).not.toBeInTheDocument();
  });

  it("leitura com várias instruções: um resultado por instrução, sem precisar liberar a edição", async () => {
    unlockStatus = LOCKED;
    const two = run({
      total: 2,
      statements: [
        { index: 1, verb: "select", kind: "read", result: { columns: ["a"], rows: [["1"]], truncated: false, empty: false }, affected: null },
        { index: 2, verb: "show", kind: "read", result: null, affected: null },
      ],
    });
    handlers["POST /api/projects/p1/database/sql/read"] = () => two;
    await loaded();
    type(sqlBox(), "select 1 as a; -- depois\nshow tables;");
    expect(screen.getByTestId("sql-kind")).toHaveTextContent("Consulta de leitura");
    fireEvent.click(screen.getByRole("button", { name: /executar consulta/i }));
    await screen.findByTestId("sql-run");
    expect(screen.getByTestId("sql-statement-1")).toHaveTextContent("Instrução 1 — SELECT");
    expect(screen.getByTestId("sql-statement-2")).toHaveTextContent("Sem linhas");
    expect(posts[0]!.body.sql).toContain("show tables");
  });

  it("resultado cortado, resultado vazio e execução parcial", async () => {
    handlers["POST /api/projects/p1/database/sql/read"] = () =>
      run({ truncated: true, total: 3, statements: [{ index: 1, verb: "select", kind: "read", result: { columns: ["a"], rows: [], truncated: true, empty: false }, affected: null }] });
    await loaded();
    type(sqlBox(), "select 1");
    fireEvent.click(screen.getByRole("button", { name: /executar consulta/i }));
    expect(await screen.findByText(/no máximo 500 linhas/)).toBeInTheDocument();
    expect(screen.getByText("A saída passou do limite e foi cortada.")).toBeInTheDocument();
    expect(screen.getByTestId("sql-run-partial")).toHaveTextContent("Executadas 1 de 3");
    handlers["POST /api/projects/p1/database/sql/read"] = () =>
      run({ statements: [{ index: 1, verb: "select", kind: "read", result: { columns: [], rows: [], truncated: false, empty: true } satisfies DatabaseSqlResult, affected: null }] });
    fireEvent.click(screen.getByRole("button", { name: /executar consulta/i }));
    expect(await screen.findByText("Sem linhas.")).toBeInTheDocument();
  });

  it("erro do banco na leitura: frase fixa traduzida, o motivo e o número da instrução", async () => {
    handlers["POST /api/projects/p1/database/sql/read"] = () => new ApiRequestError(400, "query_failed", "x", { detail: 'relation "x" does not exist', statement: 2 });
    await loaded();
    type(sqlBox(), "select 1; select * from x");
    fireEvent.click(screen.getByRole("button", { name: /executar consulta/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("O banco recusou o comando");
    expect(alert).toHaveTextContent('relation "x" does not exist');
    expect(alert).toHaveTextContent("Parou na instrução 2");
  });

  it("escrita com a edição bloqueada: avisa, não chama o servidor e leva ao diálogo de liberar", async () => {
    unlockStatus = LOCKED;
    await loaded();
    type(sqlBox(), "select 1; update users set a = 1");
    expect(screen.getByTestId("sql-kind")).toHaveTextContent("Comando de escrita");
    expect(screen.getByTestId("sql-locked")).toHaveTextContent("Libere a edição do banco para rodar comandos que alteram dados");
    expect(screen.queryByRole("button", { name: /executar consulta/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /executar comando de escrita/i })).not.toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: /liberar edição/i });
    fireEvent.click(buttons[buttons.length - 1]!);
    await screen.findByTestId("database-unlock-dialog");
    expect(posts).toHaveLength(0);
  });

  it("escrita com a edição liberada: roda na hora, sem senha nem nome, com transação no PostgreSQL; mostra o resultado por instrução", async () => {
    handlers["POST /api/projects/p1/database/sql/write"] = () => ({
      job: job({
        kind: "sql",
        status: "success",
        steps: DONE_STEPS,
        run: run({
          total: 2,
          transaction: true,
          statements: [
            { index: 1, verb: "update", kind: "write", result: null, affected: 3 },
            { index: 2, verb: "select", kind: "read", result: { columns: ["id", "name"], rows: [["1", "Ana"]], truncated: false, empty: false }, affected: null },
          ],
        }),
      }),
    });
    await loaded();
    type(sqlBox(), "update users set a = 1; select id, name from users");
    expect(screen.queryByTestId("sql-ddl-hint")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/executar tudo numa transação/i)).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: /executar comando de escrita/i }));
    expect(await screen.findByTestId("sql-affected-1")).toHaveTextContent("3 linhas afetadas");
    expect(screen.getByTestId("sql-statement-2")).toHaveTextContent("Ana");
    expect(screen.getByText("Rodou dentro de uma transação.")).toBeInTheDocument();
    expect(posts[0]).toEqual({ url: "/api/projects/p1/database/sql/write", body: { sql: "update users set a = 1; select id, name from users", transaction: true } });
    expect(screen.queryByLabelText(/senha do painel/i)).not.toBeInTheDocument();
  });

  it("PostgreSQL: desmarcar a transação vai no pedido", async () => {
    handlers["POST /api/projects/p1/database/sql/write"] = () => ({
      job: job({ kind: "sql", status: "success", steps: DONE_STEPS, run: run({ statements: [{ index: 1, verb: "vacuum", kind: "write", result: null, affected: null }] }) }),
    });
    await loaded();
    type(sqlBox(), "vacuum");
    fireEvent.click(screen.getByLabelText(/executar tudo numa transação/i));
    fireEvent.click(screen.getByRole("button", { name: /executar comando de escrita/i }));
    await screen.findByTestId("sql-run");
    expect(posts[0]!.body.transaction).toBe(false);
  });

  it("MySQL: avisa que o DDL confirma sozinho, sem opção de transação, e não manda 'transaction'", async () => {
    view = overview({ engine: "mysql", tables: [{ schema: null, name: "users", rows: 1, sizeBytes: 1 }] });
    handlers["POST /api/projects/p1/database/sql/write"] = () => ({ job: job({ kind: "sql", status: "success", steps: DONE_STEPS, run: run({ statements: [{ index: 1, verb: "alter", kind: "write", result: null, affected: null }] }) }) });
    await loaded();
    type(sqlBox(), "alter table users add b int");
    expect(screen.getByTestId("sql-ddl-hint")).toHaveTextContent("confirmam sozinhos");
    expect(screen.queryByLabelText(/executar tudo numa transação/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /executar comando de escrita/i }));
    await screen.findByTestId("sql-run");
    expect(posts[0]!.body).toEqual({ sql: "alter table users add b int" });
  });

  it("falha numa instrução: mostra o motivo e destaca a instrução que parou", async () => {
    handlers["POST /api/projects/p1/database/sql/write"] = () => ({
      job: job({
        kind: "sql",
        status: "failed",
        steps: [{ id: "backup", status: "skipped" }, { id: "action", status: "failed" }],
        error: { code: "statement_failed", message: "x", detail: "Instrução 2: syntax error" },
        run: run({
          total: 3,
          statements: [
            { index: 1, verb: "insert", kind: "write", result: null, affected: 1 },
            { index: 2, verb: "insert", kind: "write", result: null, affected: null },
          ],
        }),
      }),
    });
    await loaded();
    type(sqlBox(), "insert into a values (1); insert into b values (x); select 1");
    fireEvent.click(screen.getByRole("button", { name: /executar comando de escrita/i }));
    const failed = await screen.findByText(/A ação não foi concluída/);
    expect(failed.closest("p")).toHaveTextContent("Instrução 2: syntax error");
    expect(screen.getByTestId("sql-statement-2").className).toContain("border-destructive");
    expect(screen.getByTestId("sql-statement-1").className).not.toContain("border-destructive");
  });

  it("a instrução que falhou pode nem ter resultado: mostra onde parou", async () => {
    handlers["POST /api/projects/p1/database/sql/write"] = () => ({
      job: job({
        kind: "sql",
        status: "failed",
        steps: [{ id: "backup", status: "skipped" }, { id: "action", status: "failed" }],
        error: { code: "statement_failed", message: "x", detail: "Instrução 3: erro" },
        run: run({ total: 3, statements: [{ index: 1, verb: "insert", kind: "write", result: null, affected: 1 }] }),
      }),
    });
    await loaded();
    type(sqlBox(), "insert into a values (1); insert into a values (2); insert into a values (3)");
    fireEvent.click(screen.getByRole("button", { name: /executar comando de escrita/i }));
    expect(await screen.findByTestId("sql-failed-at")).toHaveTextContent("Parou na instrução 3");
  });

  it("escrita rejeitada porque a liberação acabou: mostra o erro, fecha e volta ao bloqueio", async () => {
    handlers["POST /api/projects/p1/database/sql/write"] = () => {
      unlockStatus = LOCKED;
      return new ApiRequestError(403, "unlock_required", "x");
    };
    await loaded();
    type(sqlBox(), "delete from users");
    fireEvent.click(screen.getByRole("button", { name: /executar comando de escrita/i }));
    expect(await within(await dialogOpen()).findByRole("alert")).toHaveTextContent("A edição do banco está bloqueada");
    fireEvent.click(within(screen.getByTestId("database-action-dialog")).getByRole("button", { name: /fechar/i }));
    expect(screen.queryByTestId("database-action-dialog")).not.toBeInTheDocument();
    await screen.findByTestId("database-locked");
  });

  it("recusa antes de enviar: instrução com erro (com o número), comando do cliente, vazio, texto grande e instruções demais", async () => {
    await loaded();
    const box = sqlBox();
    type(box, "select 1; \\! ls");
    expect(screen.getByTestId("sql-refusal")).toHaveTextContent("Instrução 2: Comandos do cliente");
    expect(screen.getByRole("button", { name: /executar consulta/i })).toBeDisabled();
    type(box, "select 'aberto");
    expect(screen.getByTestId("sql-refusal")).toHaveTextContent("sem fechar");
    type(box, "");
    expect(screen.queryByTestId("sql-refusal")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /executar consulta/i })).toBeDisabled();
    type(box, "-- só um comentário");
    expect(screen.getByTestId("sql-refusal")).toHaveTextContent("Escreva um comando SQL");
    type(box, `select '${"x".repeat(21_000)}'`);
    expect(screen.getByTestId("sql-refusal")).toHaveTextContent("passa de 20000 caracteres");
    type(box, Array.from({ length: 51 }, () => "select 1").join(";"));
    expect(screen.getByTestId("sql-refusal")).toHaveTextContent("No máximo 50 instruções");
    expect(posts).toHaveLength(0);
  });

  it("ponto e vírgula dentro de texto, comentário e $$ não separa instruções", async () => {
    await loaded();
    type(sqlBox(), "select 'a;b'; select 'x;y' /* ; */");
    expect(screen.queryByTestId("sql-refusal")).not.toBeInTheDocument();
    expect(screen.getByTestId("sql-kind")).toHaveTextContent("Consulta de leitura");
  });

  it("leitura com $$ ou $tag$ é recusada com o aviso de aspas simples", async () => {
    await loaded();
    type(sqlBox(), "select $$x;y$$");
    expect(screen.getByTestId("sql-refusal")).toHaveTextContent(/aspas simples/);
  });
});

describe("idioma", () => {
  it("em inglês os textos e os erros vêm do dicionário em inglês", async () => {
    setLocale("en", { persist: false });
    handlers["POST /api/projects/p1/database/reset"] = () => new ApiRequestError(409, "database_busy", "Já há uma ação");
    renderSection();
    await screen.findByTestId("database-overview");
    await screen.findByTestId("database-unlocked");
    expect(screen.getByTestId("database-unlocked")).toHaveTextContent(/Editing unlocked — expires in/);
    expect(screen.getByText("Tables")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /reset the database/i }));
    const dialog = await dialogOpen();
    type(within(dialog).getByLabelText(/project name/i), "Loja");
    fireEvent.click(within(dialog).getByRole("button", { name: /confirm and run/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Another action on this project's database is already running");
  });
});
