/**
 * project-database-section.test.tsx — aba Banco do projeto: visão geral, estados sem suporte/indisponível, seleção de
 * tabelas, esvaziar (com CASCADE só no PostgreSQL), zerar, comandos do framework, restaurar, console SQL (leitura
 * direta, escrita pelo diálogo) e o diálogo das ações destrutivas (backup, senha + código, nome do projeto, andamento).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseJob, DatabaseOverview, DatabaseSqlResult } from "@paas/core";

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
  result: null,
  error: null,
  ...over,
});

let view: DatabaseOverview;
let handlers: Record<string, (body: Record<string, unknown> | undefined) => unknown>;
let posts: Array<{ url: string; body: Record<string, unknown> }>;

beforeEach(() => {
  view = overview();
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
    throw new Error(`sem dublê para ${url}`);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderSection() {
  return render(
    <MemoryRouter>
      <ProjectDatabaseSection projectId="p1" projectName="Loja" pollMs={5} />
    </MemoryRouter>,
  );
}

async function loaded() {
  renderSection();
  await screen.findByTestId("database-overview");
}

const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

async function fillDialog({ password = "Senha123", code = "123456", confirm = "Loja" } = {}) {
  const dialog = await screen.findByTestId("database-action-dialog");
  type(within(dialog).getByLabelText(/senha do painel/i), password);
  type(within(dialog).getByLabelText(/código do app/i), code);
  type(within(dialog).getByLabelText(/nome do projeto/i), confirm);
  return dialog;
}

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
    // tabela de outro esquema aparece qualificada
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

  it("fluxo completo: diálogo, backup padrão 'completo', senha + código + nome, andamento e resultado", async () => {
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
    const dialog = await fillDialog();
    expect(dialog).toHaveTextContent("2 tabelas: users, audit.log");
    // padrão fora de desenvolvimento: backup completo
    expect(within(dialog).getByLabelText("Backup completo do banco antes")).toBeChecked();
    fireEvent.click(within(dialog).getByRole("button", { name: /confirmar e executar/i }));
    await screen.findByTestId("database-job");
    expect(posts[0]!.url).toBe("/api/projects/p1/database/truncate");
    expect(posts[0]!.body).toEqual({
      tables: [{ schema: "public", name: "users" }, { schema: "audit", name: "log" }],
      currentPassword: "Senha123",
      code: "123456",
      confirm: "Loja",
      backup: "full",
    });
    await screen.findByText("Concluído");
    expect(screen.getByText(/Backup feito: 2026-10-30_12-00.7z/)).toBeInTheDocument();
    // o fim do trabalho recarrega a visão
    await waitFor(() => expect(apiFetchMock.mock.calls.filter((c) => c[0] === "/api/projects/p1/database").length).toBeGreaterThanOrEqual(2));
    fireEvent.click(screen.getByRole("button", { name: /fechar/i }));
    expect(screen.queryByTestId("database-action-dialog")).not.toBeInTheDocument();
  });

  it("CASCADE só aparece no PostgreSQL, com aviso, e vai no pedido; o botão Enviar espera os três campos", async () => {
    handlers["POST /api/projects/p1/database/truncate"] = () => ({ job: job({ kind: "truncate", status: "success", steps: [{ id: "backup", status: "skipped" }, { id: "action", status: "done" }] }) });
    await loaded();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/também esvaziar as tabelas que dependem/i));
    expect(screen.getAllByRole("alert")[0]).toHaveTextContent("CASCADE esvazia");
    fireEvent.click(screen.getByLabelText("Selecionar a tabela posts"));
    fireEvent.click(screen.getByRole("button", { name: /esvaziar selecionadas/i }));
    const dialog = await screen.findByTestId("database-action-dialog");
    expect(dialog).toHaveTextContent("CASCADE esvazia");
    const submit = within(dialog).getByRole("button", { name: /confirmar e executar/i });
    expect(submit).toBeDisabled();
    await fillDialog({ confirm: "loja" });
    expect(submit).toBeDisabled();
    type(within(dialog).getByLabelText(/nome do projeto/i), "Loja");
    expect(submit).toBeEnabled();
    fireEvent.click(within(dialog).getByLabelText("Não fazer backup"));
    fireEvent.click(submit);
    await screen.findByText("Concluído");
    expect(posts[0]!.body).toMatchObject({ cascade: true, backup: "none", tables: [{ schema: "public", name: "posts" }] });
  });

  it("MySQL não oferece CASCADE e a tabela vai sem esquema", async () => {
    view = overview({ engine: "mysql", tables: [{ schema: null, name: "users", rows: 1, sizeBytes: 1 }] });
    handlers["POST /api/projects/p1/database/truncate"] = () => ({ job: job({ status: "success", steps: [{ id: "backup", status: "skipped" }, { id: "action", status: "done" }] }) });
    await loaded();
    expect(screen.queryByLabelText(/CASCADE/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Selecionar a tabela users"));
    fireEvent.click(screen.getByRole("button", { name: /esvaziar selecionadas/i }));
    await fillDialog();
    fireEvent.click(screen.getByRole("button", { name: /confirmar e executar/i }));
    await screen.findByText("Concluído");
    expect(posts[0]!.body.tables).toEqual([{ name: "users" }]);
    expect(posts[0]!.body.cascade).toBeUndefined();
  });

  it("projeto de desenvolvimento: o padrão do backup é 'Não fazer backup'", async () => {
    view = overview({ development: true });
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /zerar o banco/i }));
    const dialog = await screen.findByTestId("database-action-dialog");
    expect(within(dialog).getByLabelText("Não fazer backup")).toBeChecked();
    expect(dialog).toHaveTextContent("marcado como de desenvolvimento");
  });

  it("senha errada: mostra o erro e deixa tentar de novo no mesmo diálogo", async () => {
    handlers["POST /api/projects/p1/database/reset"] = () => new ApiRequestError(401, "invalid_current_password", "A senha atual está incorreta.");
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /zerar o banco/i }));
    await fillDialog();
    fireEvent.click(screen.getByRole("button", { name: /confirmar e executar/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("senha atual está incorreta");
    expect(screen.queryByTestId("database-job")).not.toBeInTheDocument();
  });

  it("erro com código do banco usa o texto traduzido e o motivo à parte", async () => {
    handlers["POST /api/projects/p1/database/reset"] = () => new ApiRequestError(409, "database_busy", "x", { detail: "motivo qualquer" });
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /zerar o banco/i }));
    await fillDialog();
    fireEvent.click(screen.getByRole("button", { name: /confirmar e executar/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Já há uma ação no banco");
    expect(alert).toHaveTextContent("Motivo: motivo qualquer");
  });

  it("Cancelar fecha o diálogo sem enviar nada", async () => {
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /zerar o banco/i }));
    await screen.findByTestId("database-action-dialog");
    fireEvent.click(screen.getByRole("button", { name: /cancelar/i }));
    expect(screen.queryByTestId("database-action-dialog")).not.toBeInTheDocument();
    expect(posts).toHaveLength(0);
  });
});

describe("zerar o banco", () => {
  it("descreve o que acontece, mostra o erro do trabalho (com o motivo) e avisa quando o backup falha", async () => {
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
    const dialog = await fillDialog();
    expect(dialog).toHaveTextContent("Vai apagar as tabelas e os objetos comuns");
    expect(dialog).toHaveTextContent("não é atômica");
    fireEvent.click(screen.getByRole("button", { name: /confirmar e executar/i }));
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
      return job({ status: "success", steps: [{ id: "backup", status: "skipped" }, { id: "action", status: "done" }] });
    };
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /zerar o banco/i }));
    await fillDialog();
    fireEvent.click(screen.getByRole("button", { name: /confirmar e executar/i }));
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
    await fillDialog();
    fireEvent.click(screen.getByRole("button", { name: /confirmar e executar/i }));
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
    await fillDialog();
    fireEvent.click(screen.getByRole("button", { name: /confirmar e executar/i }));
    expect(await screen.findByTestId("database-validation")).toHaveTextContent("passou");
    cleanup();
    handlers["POST /api/projects/p1/database/reset"] = () => ({ job: job({ ...done, backupValidation: "not_run" }) });
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /zerar o banco/i }));
    await fillDialog();
    fireEvent.click(screen.getByRole("button", { name: /confirmar e executar/i }));
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
      return { job: job({ kind: "command", status: "success", steps: [{ id: "backup", status: "skipped" }, { id: "action", status: "done" }], output: "ok" }) };
    };
    await loaded();
    fireEvent.click(within(screen.getByTestId("db-command-laravel-migrate")).getByRole("button", { name: /executar/i }));
    const dialog = await fillDialog();
    fireEvent.click(screen.getByRole("button", { name: /confirmar e executar/i }));
    const select = await within(dialog).findByLabelText(/qual container/i);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Mais de um container");
    expect(select).toHaveValue("worker");
    expect(within(select).getByRole("option", { name: /worker \(entrada do projeto\)/ })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "web" } });
    fireEvent.change(select, { target: { value: "worker" } });
    fireEvent.click(screen.getByRole("button", { name: /confirmar e executar/i }));
    await screen.findByTestId("database-output");
    expect(posts.at(-1)!.body.service).toBe("worker");
  });

  it("lista de serviços sem sugestão ou com formato inválido: usa o primeiro / ignora", async () => {
    view = overview({ framework: "laravel", commands: [...LARAVEL] });
    handlers["POST /api/projects/p1/database/command"] = () => new ApiRequestError(409, "app_ambiguous", "x", { services: ["web", "worker"], suggested: null });
    await loaded();
    fireEvent.click(within(screen.getByTestId("db-command-laravel-migrate")).getByRole("button", { name: /executar/i }));
    const dialog = await fillDialog();
    fireEvent.click(screen.getByRole("button", { name: /confirmar e executar/i }));
    expect(await within(dialog).findByLabelText(/qual container/i)).toHaveValue("web");
    handlers["POST /api/projects/p1/database/command"] = () => new ApiRequestError(409, "app_ambiguous", "x", { services: [1], suggested: 2 });
    fireEvent.click(screen.getByRole("button", { name: /confirmar e executar/i }));
    await waitFor(() => expect(posts.length).toBe(2));
  });

  it("sem framework reconhecido explica o que é reconhecido", async () => {
    await loaded();
    expect(screen.getByTestId("database-no-commands")).toHaveTextContent("Laravel");
  });

  it("Laravel: só os três comandos da lista; mostra a saída e o botão Copiar", async () => {
    view = overview({ framework: "laravel", commands: [...LARAVEL] });
    handlers["POST /api/projects/p1/database/command"] = () => ({
      job: job({ kind: "command", status: "success", steps: [{ id: "backup", status: "skipped" }, { id: "action", status: "done" }], output: "Migrating: users\nDone." }),
    });
    await loaded();
    expect(screen.getByText("Laravel detectado")).toBeInTheDocument();
    for (const c of LARAVEL) expect(screen.getByTestId(`db-command-${c.id}`)).toHaveTextContent(c.display);
    expect(screen.getByTestId("db-command-laravel-migrate-fresh-seed")).toHaveTextContent("Apaga todas as tabelas");
    fireEvent.click(within(screen.getByTestId("db-command-laravel-migrate")).getByRole("button", { name: /executar/i }));
    const dialog = await fillDialog();
    expect(within(dialog).getByTestId("database-action-preview")).toHaveTextContent("php artisan migrate --force");
    fireEvent.click(screen.getByRole("button", { name: /confirmar e executar/i }));
    const output = await screen.findByTestId("database-output");
    expect(output).toHaveTextContent("Migrating: users");
    expect(posts[0]!.body.command).toBe("laravel-migrate");
    fireEvent.click(within(output).getByRole("button", { name: /copiar/i }));
    await waitFor(() => expect(copyMock).toHaveBeenCalledWith("Migrating: users\nDone."));
  });

  it("comando que apaga tudo mostra o aviso no diálogo; saída vazia tem texto próprio", async () => {
    view = overview({ framework: "laravel", commands: [...LARAVEL] });
    handlers["POST /api/projects/p1/database/command"] = () => ({
      job: job({ kind: "command", status: "failed", steps: [{ id: "backup", status: "skipped" }, { id: "action", status: "failed" }], output: "", error: { code: "command_failed", message: "x", detail: "1" } }),
    });
    await loaded();
    fireEvent.click(within(screen.getByTestId("db-command-laravel-migrate-fresh-seed")).getByRole("button", { name: /executar/i }));
    const dialog = await fillDialog();
    expect(dialog).toHaveTextContent("Apaga todas as tabelas e recria o banco");
    fireEvent.click(screen.getByRole("button", { name: /confirmar e executar/i }));
    await screen.findByText(/O comando terminou com erro/);
    expect(screen.getByTestId("database-output")).toHaveTextContent("Sem saída.");
  });
});

describe("console SQL", () => {
  const result = (over: Partial<DatabaseSqlResult> = {}): DatabaseSqlResult => ({ columns: ["id", "name"], rows: [["1", "Ana"], ["2", null]], truncated: false, empty: false, ...over });

  it("consulta de leitura roda direto, com a sessão, e mostra a tabela (NULL em destaque)", async () => {
    handlers["POST /api/projects/p1/database/sql/read"] = () => result();
    await loaded();
    type(screen.getByLabelText("Comando SQL"), "select id, name from users");
    expect(screen.getByTestId("sql-kind")).toHaveTextContent("Consulta de leitura");
    fireEvent.click(screen.getByRole("button", { name: /executar consulta/i }));
    const table = await screen.findByTestId("sql-result");
    expect(table).toHaveTextContent("Ana");
    expect(table).toHaveTextContent("NULL");
    expect(table).toHaveTextContent("2 linhas");
    expect(posts[0]).toEqual({ url: "/api/projects/p1/database/sql/read", body: { sql: "select id, name from users" } });
    expect(screen.queryByTestId("database-action-dialog")).not.toBeInTheDocument();
  });

  it("resultado cortado e resultado vazio", async () => {
    handlers["POST /api/projects/p1/database/sql/read"] = () => result({ truncated: true });
    await loaded();
    type(screen.getByLabelText("Comando SQL"), "select 1");
    fireEvent.click(screen.getByRole("button", { name: /executar consulta/i }));
    expect(await screen.findByText(/no máximo 500 linhas/)).toBeInTheDocument();
    handlers["POST /api/projects/p1/database/sql/read"] = () => result({ columns: [], rows: [], empty: true });
    fireEvent.click(screen.getByRole("button", { name: /executar consulta/i }));
    expect(await screen.findByTestId("sql-result-empty")).toBeInTheDocument();
  });

  it("erro do banco na leitura: frase fixa traduzida e o motivo", async () => {
    handlers["POST /api/projects/p1/database/sql/read"] = () => new ApiRequestError(400, "query_failed", "x", { detail: 'relation "x" does not exist' });
    await loaded();
    type(screen.getByLabelText("Comando SQL"), "select * from x");
    fireEvent.click(screen.getByRole("button", { name: /executar consulta/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("O banco recusou o comando");
    expect(alert).toHaveTextContent('relation "x" does not exist');
  });

  it("comando de escrita: o painel avisa, troca o botão e abre o diálogo com senha + código", async () => {
    handlers["POST /api/projects/p1/database/sql/write"] = () => ({
      job: job({ kind: "sql", status: "success", steps: [{ id: "backup", status: "skipped" }, { id: "action", status: "done" }], result: result() }),
    });
    await loaded();
    type(screen.getByLabelText("Comando SQL"), "update users set a = 1 returning id, name");
    expect(screen.getByTestId("sql-kind")).toHaveTextContent("Comando de escrita");
    expect(screen.queryByRole("button", { name: /executar consulta/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /executar comando de escrita/i }));
    const dialog = await fillDialog();
    expect(within(dialog).getByTestId("database-action-preview")).toHaveTextContent("update users set a = 1");
    fireEvent.click(within(dialog).getByRole("button", { name: /confirmar e executar/i }));
    expect(await screen.findByTestId("sql-result")).toHaveTextContent("Ana");
    expect(posts[0]!.url).toBe("/api/projects/p1/database/sql/write");
    expect(posts[0]!.body).toMatchObject({ sql: "update users set a = 1 returning id, name", confirm: "Loja", code: "123456" });
  });

  it("recusa antes de enviar: mais de uma instrução, comando do cliente, vazio e texto grande", async () => {
    await loaded();
    const box = screen.getByLabelText("Comando SQL");
    type(box, "select 1; select 2");
    expect(screen.getByTestId("sql-refusal")).toHaveTextContent("uma instrução por vez");
    expect(screen.getByRole("button", { name: /executar consulta/i })).toBeDisabled();
    type(box, "\\! ls");
    expect(screen.getByTestId("sql-refusal")).toHaveTextContent("Comandos do cliente");
    type(box, "");
    expect(screen.queryByTestId("sql-refusal")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /executar consulta/i })).toBeDisabled();
    type(box, `select '${"x".repeat(21_000)}'`);
    expect(screen.getByTestId("sql-refusal")).toHaveTextContent("passa de 20000 caracteres");
    expect(posts).toHaveLength(0);
  });
});

describe("idioma", () => {
  it("em inglês os textos e os erros vêm do dicionário em inglês", async () => {
    setLocale("en", { persist: false });
    handlers["POST /api/projects/p1/database/reset"] = () => new ApiRequestError(409, "database_busy", "Já há uma ação");
    renderSection();
    await screen.findByTestId("database-overview");
    expect(screen.getByText("Tables")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /reset the database/i }));
    const dialog = await screen.findByTestId("database-action-dialog");
    type(within(dialog).getByLabelText(/panel password/i), "x");
    type(within(dialog).getByLabelText(/app code/i), "123456");
    type(within(dialog).getByLabelText(/project name/i), "Loja");
    fireEvent.click(within(dialog).getByRole("button", { name: /confirm and run/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Another action on this project's database is already running");
  });
});
