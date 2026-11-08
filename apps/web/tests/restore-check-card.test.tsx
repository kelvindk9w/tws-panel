/**
 * restore-check-card.test.tsx — "Testar a restauração do backup numa cópia
 * descartável" na aba Backups do projeto: ligado por padrão, o que é testado e
 * com que limites, ligar/desligar e frequência sem confirmação (nada do projeto
 * é tocado), "Testar restauração", resultado honesto (ok, falhou, não
 * executado, em andamento), pt-BR e en.
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
    settings: { enabled: true, frequency: "daily" },
    isDefault: true,
    last: null,
    unavailableReason: null,
    unavailableCode: null,
    engine: "postgres",
    limits: { memoryMb: 1024, cpus: 1, restoreMinutes: 30 },
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
    backupFileName: "2026-10-14_09-00.7z",
    engine: "postgres",
    image: "postgres:16",
    reasonCode: null,
    reason: null,
    checked: { tables: 3, rows: 120, files: 2 },
    recordId: "r1",
    ...partial,
  };
}

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

describe("ligado por padrão", () => {
  it("mostra Ligado (padrão do painel), o banco testado e os limites da cópia descartável", () => {
    renderCard(view());
    expect(screen.getByTestId("restore-check-badge")).toHaveTextContent("Ligado (padrão do painel)");
    const scope = screen.getByTestId("restore-check-scope");
    expect(scope).toHaveTextContent("Banco testado: PostgreSQL.");
    expect(scope).toHaveTextContent("1024 MB de memória, 1 CPU e até 30 min");
    expect(screen.getByText(/container descartável com a mesma imagem do banco/)).toBeInTheDocument();
    expect(screen.getByText("Ainda não houve teste.")).toBeInTheDocument();
    // nada do projeto é tocado: não há confirmação digitada
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("sem banco no backup: diz que só os arquivos são conferidos", () => {
    renderCard(view({ engine: null, isDefault: false }));
    expect(screen.getByTestId("restore-check-badge")).toHaveTextContent(/^Ligado$/);
    expect(screen.getByTestId("restore-check-scope")).toHaveTextContent("o teste confere só os arquivos de volumes, pastas e código");
  });

  it("desligar e trocar a frequência mandam só o que mudou", async () => {
    renderCard(view());
    const save = screen.getByRole("button", { name: "Salvar a frequência" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Quando testar"), { target: { value: "weekly" } });
    fireEvent.click(save);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ key: "PUT /api/backups/projects/p1/restore-check", body: { enabled: true, frequency: "weekly" } });
    expect(await screen.findByText("Frequência salva.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Desligar o teste automático" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.body).toEqual({ enabled: false });
    expect(await screen.findByText(/Teste automático desligado/)).toBeInTheDocument();
    expect(changed).toBe(2);
  });

  it("desligado: liga de novo com a frequência guardada; a frequência some enquanto desligado", async () => {
    renderCard(view({ settings: { enabled: false, frequency: "each" }, isDefault: false }));
    expect(screen.getByTestId("restore-check-badge")).toHaveTextContent("Desligado");
    expect(screen.queryByLabelText("Quando testar")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ligar o teste automático" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ enabled: true, frequency: "each" });
    expect(await screen.findByText(/Teste automático ligado/)).toBeInTheDocument();
  });

  it("Testar restauração: um clique, sem confirmação; vale também com a opção desligada", async () => {
    renderCard(view({ settings: { enabled: false, frequency: "daily" }, isDefault: false }));
    fireEvent.click(screen.getByRole("button", { name: "Testar restauração" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ key: "POST /api/backups/projects/p1/restore-check/run", body: {} });
    expect(await screen.findByText(/Teste na fila/)).toBeInTheDocument();
  });

  it("erro do servidor aparece", async () => {
    failWith = new ApiRequestError(409, "no_backup", "Ainda não há backup deste projeto para testar.");
    renderCard(view());
    fireEvent.click(screen.getByRole("button", { name: "Testar restauração" }));
    expect(await screen.findByText(/Ainda não há backup/)).toBeInTheDocument();
    expect(changed).toBe(0);
  });

  it("projeto ainda não detectado: só o motivo, sem botões", () => {
    renderCard(view({ unavailableCode: "undetected", unavailableReason: "x", engine: null }));
    expect(screen.getByTestId("restore-check-unavailable")).toHaveTextContent("ainda não foi detectado");
    expect(screen.queryByRole("button", { name: "Testar restauração" })).not.toBeInTheDocument();
  });
});

describe("resultado", () => {
  it("ok: data, duração, tabelas, linhas, arquivos e imagem", () => {
    renderCard(view({ last: result() }));
    const last = screen.getByTestId("restore-check-last");
    expect(last).toHaveAttribute("data-status", "ok");
    expect(last).toHaveTextContent("ok em");
    expect(last).toHaveTextContent("levou 42 s");
    expect(last).toHaveTextContent("conferido: tabelas 3, linhas 120");
    expect(last).toHaveTextContent("arquivos de volumes, pastas e código lidos: 2");
    expect(last).toHaveTextContent("imagem postgres:16");
  });

  it("ok sem contagem de linhas (MySQL) e só arquivos (sem banco); duração longa", () => {
    const { unmount } = renderCard(view({ last: result({ engine: "mysql", checked: { tables: 4, rows: null, files: 0 }, durationMs: 125_000 }) }));
    expect(screen.getByTestId("restore-check-last")).toHaveTextContent("conferido: tabelas 4");
    expect(screen.getByTestId("restore-check-last")).toHaveTextContent("levou 2 min 5 s");
    expect(screen.getByTestId("restore-check-last")).not.toHaveTextContent("arquivos de volumes");
    unmount();
    renderCard(view({ last: result({ engine: null, image: null, checked: { tables: 0, rows: null, files: 1 }, durationMs: null }) }));
    expect(screen.getByTestId("restore-check-last")).not.toHaveTextContent("conferido: tabelas");
    expect(screen.getByTestId("restore-check-last")).toHaveTextContent("lidos: 1");
  });

  it("falhou: o motivo traduzido pelo código; resultado antigo sem código mostra o texto guardado", () => {
    const { unmount } = renderCard(view({ last: result({ status: "failed", reasonCode: "restore_failed", reason: "x", checked: null }) }));
    const last = screen.getByTestId("restore-check-last");
    expect(last).toHaveAttribute("data-status", "failed");
    expect(last).toHaveTextContent("falhou em");
    expect(last).toHaveTextContent("A restauração do banco na cópia descartável falhou");
    unmount();
    renderCard(view({ last: result({ status: "failed", reasonCode: null, reason: "texto de uma versão antiga", checked: null }) }));
    expect(screen.getByTestId("restore-check-last")).toHaveTextContent("texto de uma versão antiga");
  });

  it("não executado e em andamento (o botão espera)", () => {
    const { unmount } = renderCard(view({ last: result({ status: "not_run", reasonCode: "image_unavailable", checked: null }) }));
    expect(screen.getByTestId("restore-check-last")).toHaveTextContent("não executado em");
    expect(screen.getByTestId("restore-check-last")).toHaveTextContent("O painel não baixa imagens");
    unmount();
    renderCard(view({ last: result({ status: "running", finishedAt: null, durationMs: null, checked: null }) }));
    expect(screen.getByTestId("restore-check-last")).toHaveTextContent("em andamento");
    expect(screen.getByRole("button", { name: "Testar restauração" })).toBeDisabled();
  });

  it("em inglês", () => {
    setLocale("en");
    renderCard(view({ last: result({ status: "failed", reasonCode: "volume_check_failed", checked: null }) }));
    expect(screen.getByTestId("restore-check-badge")).toHaveTextContent("On (panel default)");
    expect(screen.getByTestId("restore-check-last")).toHaveTextContent("A volume, folder or code file in the backup could not be read");
    setLocale("pt-BR");
  });
});
