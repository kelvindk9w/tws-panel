/**
 * database-settings.test.tsx — Configurações → Banco de dados: duração da liberação e renovar com o uso. Deixar mais
 * frouxo pede senha + código; deixar mais rígido só a sessão.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATABASE_UNLOCK_DURATIONS, type DatabaseSettingsResponse } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { setLocale } from "@/i18n/core";
import { DatabaseSettings } from "@/pages/settings/DatabaseSettings";

const response = (over: Partial<DatabaseSettingsResponse["settings"]> = {}): DatabaseSettingsResponse => ({
  settings: { unlockDuration: "30m", renewOnUse: true, ...over },
  defaults: { unlockDuration: "30m", renewOnUse: true },
  durations: DATABASE_UNLOCK_DURATIONS,
});

let current: DatabaseSettingsResponse;
let puts: Array<Record<string, unknown>>;
let putResult: (() => unknown) | null;

beforeEach(() => {
  current = response();
  puts = [];
  putResult = null;
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    if (url === "/api/auth/email-code") return { enabled: false };
    if (url !== "/api/settings/database") throw new Error(`sem dublê para ${url}`);
    if (init?.method === "PUT") {
      const body = JSON.parse(init.body!) as Record<string, unknown>;
      puts.push(body);
      if (putResult) {
        const out = putResult();
        if (out instanceof Error) throw out;
      }
      current = response({ unlockDuration: body.unlockDuration as never, renewOnUse: body.renewOnUse as boolean });
      return current;
    }
    if (current instanceof Error) throw current;
    return current;
  });
});

afterEach(() => {
  cleanup();
  setLocale("pt-BR", { persist: false });
});

const duration = () => screen.getByLabelText("Duração da liberação") as HTMLSelectElement;
const save = () => screen.getByRole("button", { name: "Salvar" });

describe("Configurações → Banco de dados", () => {
  it("carrega os valores, lista as seis opções de duração e começa sem nada para salvar", async () => {
    render(<DatabaseSettings />);
    expect(screen.getByText("Carregando…")).toBeInTheDocument();
    await screen.findByTestId("database-settings");
    expect(duration()).toHaveValue("30m");
    expect(within(duration()).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "15 minutos",
      "30 minutos",
      "1 hora",
      "2 horas",
      "4 horas",
      "Até eu sair (encerrar a sessão)",
    ]);
    expect(screen.getByLabelText("Renovar com o uso")).toBeChecked();
    expect(save()).toBeDisabled();
    expect(screen.queryByTestId("database-settings-reauth")).not.toBeInTheDocument();
  });

  it("deixar mais rígido (duração menor, sem renovar) só pede a sessão", async () => {
    render(<DatabaseSettings />);
    await screen.findByTestId("database-settings");
    fireEvent.change(duration(), { target: { value: "15m" } });
    fireEvent.click(screen.getByLabelText("Renovar com o uso"));
    expect(screen.queryByTestId("database-settings-reauth")).not.toBeInTheDocument();
    expect(save()).toBeEnabled();
    fireEvent.click(save());
    expect(await screen.findByText("Configurações salvas.")).toBeInTheDocument();
    expect(puts[0]).toEqual({ unlockDuration: "15m", renewOnUse: false });
    expect(duration()).toHaveValue("15m");
    expect(save()).toBeDisabled();
  });

  it("deixar mais frouxo (duração maior) pede senha + código e os envia", async () => {
    render(<DatabaseSettings />);
    await screen.findByTestId("database-settings");
    fireEvent.change(duration(), { target: { value: "session" } });
    const box = screen.getByTestId("database-settings-reauth");
    expect(box).toHaveTextContent("mais frouxa");
    expect(save()).toBeDisabled();
    fireEvent.change(within(box).getByLabelText(/senha do painel/i), { target: { value: "Senha123" } });
    expect(save()).toBeDisabled();
    fireEvent.change(within(box).getByLabelText(/código do app/i), { target: { value: "123456" } });
    expect(save()).toBeEnabled();
    fireEvent.click(save());
    await screen.findByText("Configurações salvas.");
    expect(puts[0]).toEqual({ unlockDuration: "session", renewOnUse: true, currentPassword: "Senha123", code: "123456" });
    expect(screen.queryByTestId("database-settings-reauth")).not.toBeInTheDocument();
  });

  it("ligar 'renovar com o uso' também pede senha + código", async () => {
    current = response({ renewOnUse: false });
    render(<DatabaseSettings />);
    await screen.findByTestId("database-settings");
    fireEvent.click(screen.getByLabelText("Renovar com o uso"));
    expect(screen.getByTestId("database-settings-reauth")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Renovar com o uso"));
    expect(screen.queryByTestId("database-settings-reauth")).not.toBeInTheDocument();
  });

  it("erro ao salvar: mostra o aviso e mantém o formulário", async () => {
    putResult = () => new ApiRequestError(401, "invalid_current_password", "A senha atual está incorreta.");
    render(<DatabaseSettings />);
    await screen.findByTestId("database-settings");
    fireEvent.change(duration(), { target: { value: "4h" } });
    const box = screen.getByTestId("database-settings-reauth");
    fireEvent.change(within(box).getByLabelText(/senha do painel/i), { target: { value: "x" } });
    fireEvent.change(within(box).getByLabelText(/código do app/i), { target: { value: "1" } });
    fireEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent("senha atual está incorreta");
    expect(duration()).toHaveValue("4h");
  });

  it("erro ao carregar", async () => {
    apiFetchMock.mockImplementation(async () => {
      throw new ApiRequestError(500, "internal_error", "Falhou");
    });
    render(<DatabaseSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Falhou");
  });

  it("em inglês", async () => {
    setLocale("en", { persist: false });
    render(<DatabaseSettings />);
    await screen.findByTestId("database-settings");
    await waitFor(() => expect(screen.getByLabelText("Unlock duration")).toBeInTheDocument());
    expect(screen.getByLabelText("Renew on use")).toBeChecked();
  });
});
