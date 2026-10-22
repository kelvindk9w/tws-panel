/**
 * restore-check-card.test.tsx — "Validar o backup do banco restaurando em
 * outro projeto" na aba Backups do projeto: desligado por padrão, aviso de
 * que o banco do destino é substituído (e de LGPD), lista só dos elegíveis,
 * confirmação digitando o nome do destino, resultado honesto (ok, falhou,
 * não executado, em andamento), "Testar agora" com a mesma confirmação,
 * pt-BR e en.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RestoreCheckResult, RestoreCheckView } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { setLocale } from "@/i18n/core";
import { RestoreCheckCard } from "@/components/project/RestoreCheckCard";

let calls: Array<{ key: string; body: Record<string, unknown> | undefined }>;
let failWith: Error | null;
let changed: number;

function view(partial: Partial<RestoreCheckView> = {}): RestoreCheckView {
  return {
    settings: null,
    last: null,
    unavailableReason: null,
    unavailableCode: null,
    engine: "postgres",
    candidates: [
      { id: "p2", name: "Fazenda Sandbox", engine: "postgres" },
      { id: "p3", name: "Fazenda Homologação", engine: "postgres" },
    ],
    notice: null,
    ...partial,
  };
}

function result(partial: Partial<RestoreCheckResult> = {}): RestoreCheckResult {
  return {
    status: "ok",
    trigger: "auto",
    startedAt: "2026-10-14T12:00:00Z",
    finishedAt: "2026-10-14T12:00:42Z",
    durationMs: 42_000,
    destinationId: "p2",
    destinationName: "Fazenda Sandbox",
    backupFileName: "2026-10-14_09-00.7z",
    reasonCode: null,
    reason: null,
    checked: null,
    recordId: "r1",
    ...partial,
  };
}

const ON = { enabled: true, destinationId: "p2", destinationName: "Fazenda Sandbox", frequency: "each" as const };

function renderCard(v: RestoreCheckView) {
  return render(<RestoreCheckCard projectId="p1" view={v} onChanged={() => void changed++} />);
}

beforeEach(() => {
  setLocale("pt-BR");
  calls = [];
  failWith = null;
  changed = 0;
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    calls.push({ key: `${init?.method ?? "GET"} ${path}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (failWith) throw failWith;
    return {};
  });
});
afterEach(cleanup);

describe("desligado (o padrão)", () => {
  it("mostra Desligado, o aviso do banco temporário (o do destino não é alterado) e o de dados pessoais", () => {
    renderCard(view());
    expect(screen.getByTestId("restore-check-badge")).toHaveTextContent("Desligado");
    const warning = screen.getByTestId("restore-check-warning");
    expect(warning).toHaveTextContent("cria um banco temporário");
    expect(warning).toHaveTextContent("não são alterados");
    expect(warning).toHaveTextContent("dados reais de produção");
    expect(warning).toHaveTextContent("LGPD");
    expect(warning).toHaveTextContent("Não ligue se o destino for compartilhado com terceiros");
    expect(warning).toHaveTextContent("Só o banco é restaurado");
    expect(warning).toHaveTextContent("apaga o banco temporário");
    expect(warning).not.toHaveTextContent("apaga e recria");
    expect(screen.getByText("Ainda não houve teste.")).toBeInTheDocument();
  });

  it("a lista traz só os elegíveis que o servidor mandou", () => {
    renderCard(view());
    const select = screen.getByLabelText("Projeto de destino") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Escolha o projeto", "Fazenda Sandbox (PostgreSQL)", "Fazenda Homologação (PostgreSQL)"]);
  });

  it("Ligar só habilita depois de escolher o destino e digitar o nome dele (maiúsculas tanto faz)", async () => {
    renderCard(view());
    const on = screen.getByRole("button", { name: "Ligar a validação" });
    expect(on).toBeDisabled();
    expect(screen.queryByLabelText(/Digite/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Projeto de destino"), { target: { value: "p2" } });
    expect(on).toBeDisabled();
    const word = screen.getByPlaceholderText("Fazenda Sandbox");
    fireEvent.change(word, { target: { value: "Fazenda" } });
    expect(on).toBeDisabled();
    fireEvent.change(word, { target: { value: "  fazenda sandbox " } });
    expect(on).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Quando testar"), { target: { value: "weekly" } });
    fireEvent.click(on);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      key: "PUT /api/backups/projects/p1/restore-check",
      body: { enabled: true, destinationId: "p2", frequency: "weekly", confirm: "  fazenda sandbox " },
    });
    expect(await screen.findByText(/Validação ligada/)).toBeInTheDocument();
    expect(changed).toBe(1);
  });

  it("trocar o destino zera o que foi digitado", () => {
    renderCard(view());
    fireEvent.change(screen.getByLabelText("Projeto de destino"), { target: { value: "p2" } });
    fireEvent.change(screen.getByPlaceholderText("Fazenda Sandbox"), { target: { value: "Fazenda Sandbox" } });
    fireEvent.change(screen.getByLabelText("Projeto de destino"), { target: { value: "p3" } });
    expect(screen.getByPlaceholderText("Fazenda Homologação")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Ligar a validação" })).toBeDisabled();
  });

  it("erro do servidor aparece e não liga", async () => {
    failWith = new ApiRequestError(400, "invalid_destination", "Este projeto não pode ser o destino.");
    renderCard(view());
    fireEvent.change(screen.getByLabelText("Projeto de destino"), { target: { value: "p2" } });
    fireEvent.change(screen.getByPlaceholderText("Fazenda Sandbox"), { target: { value: "Fazenda Sandbox" } });
    fireEvent.click(screen.getByRole("button", { name: "Ligar a validação" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Este projeto não pode ser o destino.");
    expect(changed).toBe(0);
  });

  it("sem destino elegível: explica o que falta, sem formulário", () => {
    renderCard(view({ candidates: [] }));
    expect(screen.getByTestId("restore-check-no-candidates")).toHaveTextContent("banco PostgreSQL já detectado");
    expect(screen.queryByRole("button", { name: "Ligar a validação" })).not.toBeInTheDocument();
  });

  it.each([
    ["undetected", "ainda não foi detectado"],
    ["no_database", "não tem banco PostgreSQL, MySQL, MariaDB ou MongoDB"],
    ["not_selected", "não está marcado no backup"],
    ["is_destination", "destino do teste de restauração de outro projeto"],
  ] as const)("opção indisponível (%s): explica e não mostra formulário nem aviso", (code, text) => {
    renderCard(view({ unavailableCode: code, unavailableReason: "texto do servidor", candidates: [] }));
    expect(screen.getByTestId("restore-check-unavailable")).toHaveTextContent(text);
    expect(screen.queryByTestId("restore-check-warning")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ligar a validação" })).not.toBeInTheDocument();
  });

  it("indisponível sem código conhecido: mostra o texto do servidor", () => {
    renderCard(view({ unavailableReason: "texto do servidor", candidates: [] }));
    expect(screen.getByTestId("restore-check-unavailable")).toHaveTextContent("texto do servidor");
  });

  it("a opção foi desligada pelo painel (destino apagado ou renomeado): mostra o aviso", () => {
    renderCard(view({ settings: { ...ON, enabled: false }, notice: { code: "destination_missing", text: "x", at: "2026-10-14T12:00:00Z" } }));
    expect(screen.getByTestId("restore-check-notice")).toHaveTextContent("foi apagado, então a validação foi desligada");
    cleanup();
    renderCard(view({ notice: { code: "destination_renamed", text: "x", at: "2026-10-14T12:00:00Z" } }));
    expect(screen.getByTestId("restore-check-notice")).toHaveTextContent("foi renomeado");
  });
});

describe("ligado", () => {
  it("mostra o destino, a frequência e o último teste: 'ok em <data>, no projeto <destino>'", () => {
    renderCard(view({ settings: ON, last: result({ checked: { tables: 12, rows: 3400 } }) }));
    expect(screen.getByTestId("restore-check-badge")).toHaveTextContent("Ligado");
    expect(screen.getByTestId("restore-check-current")).toHaveTextContent("Destino: Fazenda Sandbox");
    const last = screen.getByTestId("restore-check-last");
    expect(last).toHaveAttribute("data-status", "ok");
    expect(last).toHaveTextContent(/ok em .+, no projeto Fazenda Sandbox/);
    expect(last).toHaveTextContent("levou 42 s");
    expect(last).toHaveTextContent("conferido: tabelas 12, linhas 3400");
    expect(screen.queryByLabelText("Projeto de destino")).not.toBeInTheDocument();
  });

  it("duração acima de 1 minuto, e sem a conferência quando não há números", () => {
    renderCard(view({ settings: ON, last: result({ checked: { tables: 1, rows: 0 }, durationMs: 125_000 }) }));
    expect(screen.getByTestId("restore-check-last")).toHaveTextContent("levou 2 min 5 s · conferido: tabelas 1, linhas 0");
    cleanup();
    renderCard(view({ settings: ON, last: result({ durationMs: null }) }));
    expect(screen.getByTestId("restore-check-last")).not.toHaveTextContent("conferido");
  });

  it("falhou: mostra o motivo curto e que o banco temporário foi apagado", () => {
    renderCard(view({ settings: ON, last: result({ status: "failed", reasonCode: "restore_failed", reason: "x", durationMs: null }) }));
    const last = screen.getByTestId("restore-check-last");
    expect(last).toHaveAttribute("data-status", "failed");
    expect(last).toHaveTextContent(/falhou em .+, no projeto Fazenda Sandbox: A restauração do backup num banco temporário do destino falhou.+O banco temporário foi apagado\./);
  });

  it("não executado: mostra o motivo; em andamento: mostra o destino", () => {
    renderCard(view({ settings: ON, last: result({ status: "not_run", reasonCode: "destination_not_running", reason: "x" }) }));
    expect(screen.getByTestId("restore-check-last")).toHaveTextContent(/não executado em .+: O banco do projeto de destino não está em execução/);
    cleanup();
    renderCard(view({ settings: ON, last: result({ status: "running", finishedAt: null, durationMs: null }) }));
    expect(screen.getByTestId("restore-check-last")).toHaveTextContent("em andamento, no projeto Fazenda Sandbox");
    expect(screen.getByRole("button", { name: "Testar agora" })).toBeDisabled();
  });

  it("motivo sem código conhecido: usa o texto do servidor", () => {
    renderCard(view({ settings: ON, last: result({ status: "failed", reasonCode: null, reason: "motivo do servidor" }) }));
    expect(screen.getByTestId("restore-check-last")).toHaveTextContent("motivo do servidor");
    cleanup();
    renderCard(view({ settings: ON, last: result({ status: "failed", reasonCode: null, reason: null }) }));
    expect(screen.getByTestId("restore-check-last")).toHaveTextContent(/falhou em .+:$/);
  });

  it("origem indisponível com a opção ainda ligada: mostra o motivo e deixa DESLIGAR", async () => {
    renderCard(view({ settings: ON, unavailableCode: "not_selected", unavailableReason: "x", candidates: [] }));
    expect(screen.getByTestId("restore-check-badge")).toHaveTextContent("Ligado");
    expect(screen.getByTestId("restore-check-unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Desligar" }));
    await waitFor(() => expect(calls).toEqual([{ key: "PUT /api/backups/projects/p1/restore-check", body: { enabled: false } }]));
  });

  it("depois de agir, o foco vai para a região de resultado (que é uma região de status) em vez de se perder", async () => {
    failWith = new ApiRequestError(409, "no_backup", "Ainda não há backup deste projeto para testar.");
    renderCard(view({ settings: ON }));
    fireEvent.click(screen.getByRole("button", { name: "Desligar" }));
    const alert = await screen.findByRole("alert");
    const region = alert.closest('[role="status"]') as HTMLElement;
    expect(region).not.toBeNull();
    await waitFor(() => expect(region).toHaveFocus());
  });

  it("os seletores não estouram a largura de uma tela estreita (nome de projeto comprido)", () => {
    const long = "Fazenda Sandbox de homologação do cliente 123";
    renderCard(view({ candidates: [{ id: "p2", name: long, engine: "postgres" }] }));
    for (const label of ["Projeto de destino", "Quando testar"]) {
      const select = screen.getByLabelText(label);
      expect(select.className).toMatch(/\bw-full\b/);
      expect(select.className).toMatch(/\bmax-w-full\b/);
      expect(select.parentElement!.className).toMatch(/\bmin-w-0\b/);
    }
  });

  it("motivos novos: não começou (reinício), destino trocado e banco temporário que sobrou", () => {
    for (const [code, text] of [
      ["restart_before_start", "reiniciou antes de o teste começar"],
      ["settings_changed", "destino do teste foi trocado"],
      ["cleanup_failed", "não foi possível apagar o banco temporário"],
    ] as const) {
      renderCard(view({ settings: ON, last: result({ status: code === "cleanup_failed" ? "failed" : "not_run", reasonCode: code, reason: "x" }) }));
      expect(screen.getByTestId("restore-check-last")).toHaveTextContent(text);
      cleanup();
    }
  });

  it("desligar não pede confirmação", async () => {
    renderCard(view({ settings: ON }));
    fireEvent.click(screen.getByRole("button", { name: "Desligar" }));
    await waitFor(() => expect(calls).toEqual([{ key: "PUT /api/backups/projects/p1/restore-check", body: { enabled: false } }]));
    expect(await screen.findByText("Validação desligada.")).toBeInTheDocument();
  });

  it("trocar só a frequência não pede o nome do destino", async () => {
    renderCard(view({ settings: ON }));
    const save = screen.getByRole("button", { name: "Salvar a frequência" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Quando testar"), { target: { value: "daily" } });
    fireEvent.click(save);
    await waitFor(() => expect(calls[0]).toEqual({ key: "PUT /api/backups/projects/p1/restore-check", body: { enabled: true, frequency: "daily" } }));
    expect(await screen.findByText("Frequência salva.")).toBeInTheDocument();
  });

  it("Testar agora pede o nome do destino (a mesma confirmação) e enfileira", async () => {
    renderCard(view({ settings: ON, last: result() }));
    fireEvent.click(screen.getByRole("button", { name: "Testar agora" }));
    const box = screen.getByTestId("restore-check-test-now");
    const run = within(box).getByRole("button", { name: "Executar o teste" });
    expect(run).toBeDisabled();
    const word = within(box).getByPlaceholderText("Fazenda Sandbox");
    fireEvent.change(word, { target: { value: "outro nome" } });
    expect(run).toBeDisabled();
    fireEvent.change(word, { target: { value: "FAZENDA SANDBOX" } });
    expect(run).toBeEnabled();
    fireEvent.click(run);
    await waitFor(() => expect(calls).toEqual([{ key: "POST /api/backups/projects/p1/restore-check/run", body: { confirm: "FAZENDA SANDBOX" } }]));
    expect(await screen.findByText(/Teste na fila/)).toBeInTheDocument();
    expect(screen.queryByTestId("restore-check-test-now")).not.toBeInTheDocument();
    expect(changed).toBe(1);
  });

  it("Testar agora: o botão alterna a área e o erro do servidor aparece", async () => {
    failWith = new ApiRequestError(409, "no_backup", "Ainda não há backup deste projeto para testar.");
    renderCard(view({ settings: ON }));
    fireEvent.click(screen.getByRole("button", { name: "Testar agora" }));
    fireEvent.click(screen.getByRole("button", { name: "Testar agora" }));
    expect(screen.queryByTestId("restore-check-test-now")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Testar agora" }));
    fireEvent.change(screen.getByPlaceholderText("Fazenda Sandbox"), { target: { value: "Fazenda Sandbox" } });
    fireEvent.click(screen.getByRole("button", { name: "Executar o teste" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Ainda não há backup deste projeto para testar.");
    expect(screen.getByTestId("restore-check-test-now")).toBeInTheDocument();
  });
});

describe("em inglês", () => {
  beforeEach(() => setLocale("en"));
  afterEach(() => setLocale("pt-BR"));

  it("aviso, formulário e resultado", () => {
    renderCard(view());
    expect(screen.getByTestId("restore-check-badge")).toHaveTextContent("Off");
    const warning = screen.getByTestId("restore-check-warning");
    expect(warning).toHaveTextContent("creates a temporary database");
    expect(warning).toHaveTextContent("are not changed");
    expect(warning).toHaveTextContent("LGPD/GDPR");
    expect(screen.getByRole("button", { name: "Turn on validation" })).toBeDisabled();
    cleanup();
    renderCard(view({ settings: ON, last: result({ status: "failed", reasonCode: "timeout", reason: "pt" }) }));
    expect(screen.getByTestId("restore-check-last")).toHaveTextContent(/failed on .+, in project Fazenda Sandbox: The restore ran past its time limit/);
    expect(screen.getByRole("button", { name: "Test now" })).toBeInTheDocument();
  });

  it("indisponível, aviso do painel e sem elegíveis", () => {
    renderCard(view({ unavailableCode: "no_database", unavailableReason: "pt", candidates: [] }));
    expect(screen.getByTestId("restore-check-unavailable")).toHaveTextContent("no PostgreSQL, MySQL, MariaDB or MongoDB database");
    cleanup();
    renderCard(view({ candidates: [], notice: { code: "destination_missing", text: "pt", at: "2026-10-14T12:00:00Z" } }));
    expect(screen.getByTestId("restore-check-no-candidates")).toHaveTextContent("PostgreSQL database already detected");
    expect(screen.getByTestId("restore-check-notice")).toHaveTextContent("The destination project was deleted");
  });
});
