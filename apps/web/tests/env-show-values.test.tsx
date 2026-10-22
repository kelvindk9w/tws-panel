/**
 * Variáveis — "Mostrar/Ocultar valores" é o PADRÃO de todas as linhas (pedido do
 * dono): vale para as novas, as importadas e as que voltam com a pesquisa; o olho
 * individual sobrepõe só a própria linha; o botão global descarta os olhos e
 * aplica o novo estado a todas, inclusive às que a pesquisa esconde.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const PROJECT = { id: "p1", name: "loja", slug: "loja", detection: { type: "compose" } } as unknown as Project;
const SENHA = "senha-de-exemplo-da-caixa";
const DATA = {
  vars: [
    { key: "API_KEY", value: "abc" },
    { key: "DB_URL", value: "postgres://x" },
    { key: "NODE_ENV", value: "production" },
  ],
  compose: null,
  provided: ["SMTP_PASS"],
  providedValues: { SMTP_HOST: "mail.exemplo.com" },
  links: {},
};

function serve(reveal: (name: string) => Promise<unknown> = async (name) => ({ name, value: SENHA })) {
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "PUT") return JSON.parse(String(init.body));
    const m = /\/env\/provided\/([A-Za-z0-9_]+)$/.exec(path);
    if (m) return reveal(m[1]!);
    return DATA;
  });
}
const revealCalls = () =>
  apiFetchMock.mock.calls.map(([p]) => String(p)).filter((p) => p.includes("/env/provided/"));

function renderCard() {
  return render(
    <MemoryRouter>
      <ProjectEnvCard project={PROJECT} />
    </MemoryRouter>,
  );
}
const search = () => screen.getByRole("searchbox", { name: "Pesquisar variáveis" });
const typeOf = (value: string) => (screen.getByDisplayValue(value) as HTMLInputElement).type;
const globalBtn = (name: RegExp) => screen.getByRole("button", { name });

async function ready() {
  renderCard();
  await screen.findByDisplayValue("abc");
}
function addVariable(key: string, value: string) {
  fireEvent.click(screen.getByRole("button", { name: /Adicionar variável/ }));
  const names = screen.getAllByPlaceholderText("NOME_DA_VARIAVEL");
  fireEvent.change(names[names.length - 1]!, { target: { value: key } });
  const values = screen.getAllByLabelText(/^Valor da variável/);
  fireEvent.change(values[values.length - 1]!, { target: { value } });
}

beforeEach(() => {
  apiFetchMock.mockReset();
  window.localStorage.clear();
  setLocale("pt-BR", { persist: false });
});
afterEach(cleanup);

describe("Mostrar valores como padrão de todas as linhas", () => {
  it("global mostrar: variável adicionada depois nasce visível", async () => {
    serve();
    await ready();
    fireEvent.click(globalBtn(/Mostrar valores/));
    addVariable("NOVA", "valor-novo");
    expect(typeOf("valor-novo")).toBe("text");
  });

  it("global ocultar: variável adicionada nasce oculta", async () => {
    serve();
    await ready();
    addVariable("NOVA", "valor-novo");
    expect(typeOf("valor-novo")).toBe("password");
    expect(typeOf("abc")).toBe("password");
  });

  it("global mostrar: pesquisar e limpar mantém todas visíveis, sem novo clique", async () => {
    serve();
    await ready();
    fireEvent.click(globalBtn(/Mostrar valores/));
    fireEvent.change(search(), { target: { value: "api" } });
    expect(screen.queryByTestId("env-row-DB_URL")).not.toBeInTheDocument();
    expect(typeOf("abc")).toBe("text");
    fireEvent.change(search(), { target: { value: "" } });
    expect(typeOf("postgres://x")).toBe("text");
    expect(typeOf("production")).toBe("text");
  });

  it("global ocultar: pesquisar e limpar mantém todas ocultas", async () => {
    serve();
    await ready();
    fireEvent.change(search(), { target: { value: "api" } });
    expect(typeOf("abc")).toBe("password");
    fireEvent.change(search(), { target: { value: "" } });
    expect(typeOf("postgres://x")).toBe("password");
  });

  it("clicar em Mostrar valores com a pesquisa ativa mostra também as que ela esconde", async () => {
    serve();
    await ready();
    fireEvent.change(search(), { target: { value: "api" } });
    fireEvent.click(globalBtn(/Mostrar valores/));
    fireEvent.change(search(), { target: { value: "" } });
    expect(typeOf("postgres://x")).toBe("text");
  });

  it("pesquisa sem resultado: o global ainda alterna e o estado vale ao limpar", async () => {
    serve();
    await ready();
    fireEvent.change(search(), { target: { value: "zzzz" } });
    expect(screen.getByText(/Nenhuma variável corresponde/)).toBeInTheDocument();
    fireEvent.click(globalBtn(/Mostrar valores/));
    fireEvent.click(screen.getByRole("button", { name: "Limpar pesquisa" }));
    expect(typeOf("abc")).toBe("text");
  });

  it("o olho individual sobrepõe só a linha e o global descarta o override", async () => {
    serve();
    await ready();
    fireEvent.click(globalBtn(/Mostrar valores/));
    const row = screen.getByTestId("env-row-DB_URL");
    fireEvent.click(within(row).getByRole("button", { name: "Ocultar valor" }));
    expect(typeOf("postgres://x")).toBe("password");
    expect(typeOf("abc")).toBe("text");
    // o override resiste à pesquisa
    fireEvent.change(search(), { target: { value: "db" } });
    fireEvent.change(search(), { target: { value: "" } });
    expect(typeOf("postgres://x")).toBe("password");
    // ocultar e mostrar de novo: o override foi descartado
    fireEvent.click(globalBtn(/Ocultar valores/));
    fireEvent.click(globalBtn(/Mostrar valores/));
    expect(typeOf("postgres://x")).toBe("text");
    expect(typeOf("abc")).toBe("text");
  });

  it("olho individual com o global oculto mostra só aquela, e uma nova continua oculta", async () => {
    serve();
    await ready();
    fireEvent.click(within(screen.getByTestId("env-row-API_KEY")).getByRole("button", { name: "Mostrar valor" }));
    addVariable("NOVA", "valor-novo");
    expect(typeOf("abc")).toBe("text");
    expect(typeOf("valor-novo")).toBe("password");
  });

  it("rótulos acessíveis refletem o estado real", async () => {
    serve();
    await ready();
    expect(globalBtn(/Mostrar valores/)).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(globalBtn(/Mostrar valores/));
    expect(globalBtn(/Ocultar valores/)).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByTestId("env-row-API_KEY")).getByRole("button", { name: "Ocultar valor" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("variável apagada enquanto revelada some sem afetar as demais", async () => {
    serve();
    await ready();
    fireEvent.click(globalBtn(/Mostrar valores/));
    fireEvent.click(screen.getByRole("button", { name: "Remover API_KEY" }));
    expect(screen.queryByTestId("env-row-API_KEY")).not.toBeInTheDocument();
    expect(typeOf("postgres://x")).toBe("text");
  });

  it("o estado global não persiste (nem localStorage, nem URL) e o oculto fica em campo de senha", async () => {
    serve();
    await ready();
    fireEvent.click(globalBtn(/Mostrar valores/));
    expect(window.localStorage.length).toBe(0);
    expect(window.location.search).toBe("");
    fireEvent.click(globalBtn(/Ocultar valores/));
    expect(typeOf("abc")).toBe("password");
    expect(screen.getByTestId("env-list")).not.toHaveTextContent("abc");
  });

  it("importar .env com o global em mostrar: linhas novas nascem visíveis", async () => {
    serve();
    await ready();
    fireEvent.click(globalBtn(/Mostrar valores/));
    const file = new File(["IMPORTADA=valor-importado\n"], ".env");
    Object.defineProperty(file, "text", { value: async () => "IMPORTADA=valor-importado\n" });
    fireEvent.change(screen.getByTestId("env-file-input"), { target: { files: [file] } });
    await screen.findByDisplayValue("valor-importado");
    expect(typeOf("valor-importado")).toBe("text");
  });

  it("a dica da pesquisa não diz mais que o global vale só para as mostradas", async () => {
    serve();
    await ready();
    fireEvent.change(search(), { target: { value: "api" } });
    const note = screen.getByTestId("env-filter-note");
    expect(note).toHaveTextContent(/“Mostrar valores”.*valem para todas/);
    expect(note).not.toHaveTextContent(/vale só/);
  });
});

describe("Mostrar valores com valores sob demanda (senha da caixa)", () => {
  const panel = () =>
    within(screen.getByTestId("env-panel-SMTP_PASS")).getByLabelText("Valor de SMTP_PASS") as HTMLInputElement;

  it("nada é buscado sem clique; o global busca também as fora do filtro", async () => {
    serve();
    await ready();
    fireEvent.change(search(), { target: { value: "api" } });
    expect(screen.queryByTestId("env-panel-SMTP_PASS")).not.toBeInTheDocument();
    expect(revealCalls()).toEqual([]);
    fireEvent.click(globalBtn(/Mostrar valores/));
    await waitFor(() => expect(revealCalls()).toEqual(["/api/projects/p1/env/provided/SMTP_PASS"]));
    fireEvent.change(search(), { target: { value: "" } });
    await waitFor(() => expect(panel()).toHaveValue(SENHA));
    expect(panel().type).toBe("text");
    // ocultar e mostrar outra vez não busca de novo
    fireEvent.click(globalBtn(/Ocultar valores/));
    expect(panel().type).toBe("password");
    fireEvent.click(globalBtn(/Mostrar valores/));
    expect(panel().type).toBe("text");
    expect(revealCalls()).toHaveLength(1);
  });

  it("falha ao revelar: avisa, a linha segue oculta e as demais ficam visíveis", async () => {
    serve(async () => {
      throw new Error("rede");
    });
    await ready();
    fireEvent.click(globalBtn(/Mostrar valores/));
    expect(await screen.findByText("Não foi possível mostrar o valor de SMTP_PASS.")).toBeInTheDocument();
    expect(panel().type).toBe("password");
    expect(panel()).toHaveValue("");
    expect(typeOf("abc")).toBe("text");
  });

  it("olho individual do painel sobrepõe e o global descarta", async () => {
    serve();
    await ready();
    fireEvent.click(globalBtn(/Mostrar valores/));
    await waitFor(() => expect(panel().type).toBe("text"));
    fireEvent.click(within(screen.getByTestId("env-panel-SMTP_PASS")).getByRole("button", { name: "Ocultar valor" }));
    expect(panel().type).toBe("password");
    fireEvent.click(globalBtn(/Ocultar valores/));
    fireEvent.click(globalBtn(/Mostrar valores/));
    expect(panel().type).toBe("text");
  });
});

describe("Mostrar valores — en", () => {
  it("rótulos e dica em inglês", async () => {
    setLocale("en", { persist: false });
    serve();
    renderCard();
    await screen.findByDisplayValue("abc");
    fireEvent.click(screen.getByRole("button", { name: /Show values/ }));
    expect(screen.getByRole("button", { name: /Hide values/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "api" } });
    expect(screen.getByTestId("env-filter-note")).toHaveTextContent(/apply to all of them/);
    expect((screen.getByDisplayValue("abc") as HTMLInputElement).type).toBe("text");
  });
});
