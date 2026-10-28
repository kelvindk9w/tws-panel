/**
 * Variáveis — apagar todas (inclusive a última e o que ainda não foi salvo), salvar a lista vazia e importar o
 * .env mesclando ou substituindo (resultado igual ao arquivo).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";
import { MemoryRouter } from "react-router";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ProjectEnvCard } from "@/components/ProjectEnvCard";
import { setLocale } from "../src/i18n";

const PROJECT = { id: "p1", name: "loja", slug: "loja", detection: { type: "dockerfile" } } as unknown as Project;

let saved: Array<{ key: string; value: string; build?: boolean }>;
let provided: string[];
let example: string[];

function serve() {
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "PUT") return JSON.parse(String(init.body));
    if (path.endsWith("/email")) return { email: null };
    return {
      vars: saved,
      compose: null,
      provided,
      providedValues: {},
      links: {},
      example: example.length ? { files: [".env.example"], variables: example.map((name) => ({ name, file: ".env.example" })) } : null,
    };
  });
}
const puts = () =>
  apiFetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT").map(([, init]) => JSON.parse(String((init as RequestInit).body)).vars);

async function ready() {
  render(
    <MemoryRouter>
      <ProjectEnvCard project={PROJECT} />
    </MemoryRouter>,
  );
  await screen.findByTestId("env-footer");
  await waitFor(() => expect(screen.queryByText(/Carregando/i)).not.toBeInTheDocument());
}
function importText(text: string) {
  const file = new File([text], ".env");
  Object.defineProperty(file, "text", { value: async () => text });
  fireEvent.change(screen.getByTestId("env-file-input"), { target: { files: [file] } });
}

beforeEach(() => {
  apiFetchMock.mockReset();
  window.localStorage.clear();
  setLocale("pt-BR", { persist: false });
  saved = [
    { key: "A", value: "1" },
    { key: "B", value: "2", build: true },
    { key: "C", value: "3" },
  ];
  provided = [];
  example = [];
});
afterEach(cleanup);

describe("Apagar todas", () => {
  it("pede confirmação e grava a lista vazia", async () => {
    serve();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Apagar todas/ }));
    expect(screen.getByTestId("env-clear-confirm")).toHaveTextContent(/Apagar as 3 variáveis/);
    expect(puts()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /Sim, apagar todas/ }));
    await screen.findByText(/Variáveis apagadas/);
    expect(puts()).toEqual([[]]);
    expect(screen.queryByDisplayValue("1")).not.toBeInTheDocument();
  });

  it("remover a última variável uma a uma e salvar manda lista vazia", async () => {
    saved = [{ key: "UNICA", value: "x" }];
    serve();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Remover UNICA" }));
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await screen.findByText(/Valem a partir do próximo deploy/);
    expect(puts()).toEqual([[]]);
  });

  it("vale também para o que foi importado e ainda não salvo (nada salvo antes)", async () => {
    saved = [];
    serve();
    await ready();
    const apagar = screen.getByRole("button", { name: /Apagar todas/ });
    expect(apagar).toBeDisabled();
    importText("X=1\nY=2\n");
    await screen.findByDisplayValue("2");
    expect(apagar).toBeEnabled();
    fireEvent.click(apagar);
    fireEvent.click(screen.getByRole("button", { name: /Sim, apagar todas/ }));
    await waitFor(() => expect(puts()).toEqual([[]]));
  });

  it("variáveis fornecidas pelo painel: a confirmação avisa que continuam", async () => {
    provided = ["SMTP_HOST"];
    serve();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Apagar todas/ }));
    expect(screen.getByTestId("env-clear-confirm")).toHaveTextContent(/fornecidas pelo painel.*não são apagadas/);
  });

  it("linhas sugeridas vazias do .env.example não habilitam o botão", async () => {
    saved = [];
    example = ["SO_NOME"];
    serve();
    await ready();
    expect(screen.getByRole("button", { name: /Apagar todas/ })).toBeDisabled();
  });
});

describe("Importar .env: mesclar ou substituir", () => {
  it("mesclar (padrão) mantém as atuais e acrescenta/atualiza", async () => {
    serve();
    await ready();
    expect((screen.getByLabelText(/Mesclar com as atuais/) as HTMLInputElement).checked).toBe(true);
    importText("A=novo\nD=4\n");
    await screen.findByDisplayValue("4");
    expect(screen.getByDisplayValue("novo")).toBeInTheDocument();
    expect(screen.getByDisplayValue("3")).toBeInTheDocument();
    expect(screen.getByTestId("env-import-result")).toHaveTextContent(/1 atualizada, 1 nova/);
    expect(screen.getByTestId("env-import-result")).not.toHaveTextContent(/removida/);
  });

  it("substituir deixa só o que está no arquivo, conta as removidas e salva exatamente isso", async () => {
    serve();
    await ready();
    fireEvent.click(screen.getByLabelText(/Substituir todas/));
    importText("B=dois\nD=4\n");
    await screen.findByDisplayValue("4");
    expect(screen.queryByDisplayValue("1")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("3")).not.toBeInTheDocument();
    expect(screen.getByTestId("env-import-result")).toHaveTextContent(/1 atualizada, 1 nova.*2 removidas/);
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await screen.findByText(/Valem a partir do próximo deploy/);
    // a marca "de build" de B continua
    expect(puts()).toEqual([[{ key: "B", value: "dois", build: true }, { key: "D", value: "4" }]]);
  });
});
