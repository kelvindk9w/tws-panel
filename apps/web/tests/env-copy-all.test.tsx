/**
 * Variáveis — "Copiar todas as variáveis": copia em .env o que a lista mostra
 * (pesquisa/filtro valem), com valores reais, rascunho incluído, e reimportável.
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
const copyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", () => ({
  copyText: copyMock,
  copyTextLater: async (p: Promise<string>) => {
    try {
      return await copyMock(await p);
    } catch {
      return false;
    }
  },
}));

import { ProjectEnvCard } from "@/components/ProjectEnvCard";
import { parseDotenv, quoteDotenvValue, serializeDotenv } from "../src/lib/dotenv";
import { setLocale } from "../src/i18n";

const PROJECT = { id: "p1", name: "loja", slug: "loja", detection: { type: "compose" } } as unknown as Project;
const SENHA = "senha da caixa #1";
const DATA = {
  vars: [
    { key: "API_KEY", value: "abc" },
    { key: "FRASE", value: "olá mundo # nao comentario" },
    { key: "MULTI", value: "linha1\nlinha2" },
  ],
  compose: { variables: [{ name: "FALTA", required: true, hasDefault: false }] },
  provided: ["SMTP_HOST", "SMTP_PASS"],
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
async function ready() {
  render(
    <MemoryRouter>
      <ProjectEnvCard project={PROJECT} />
    </MemoryRouter>,
  );
  await screen.findByDisplayValue("abc");
}
const btn = () => screen.getByRole("button", { name: "Copiar todas as variáveis" }) as HTMLButtonElement;
const copied = () => copyMock.mock.calls.at(-1)![0] as string;

beforeEach(() => {
  apiFetchMock.mockReset();
  copyMock.mockReset();
  copyMock.mockResolvedValue(true);
  window.localStorage.clear();
  setLocale("pt-BR", { persist: false });
});
afterEach(cleanup);

describe("Copiar todas as variáveis", () => {
  it("copia valores reais (não a máscara), inclusive a senha buscada, e reimporta igual", async () => {
    serve();
    await ready();
    fireEvent.click(btn());
    await screen.findByText(/variáveis copiadas/);
    const text = copied();
    expect(text).not.toMatch(/•|\*\*\*/);
    const back = Object.fromEntries(parseDotenv(text).vars.map((v) => [v.key, v.value]));
    expect(back).toMatchObject({
      API_KEY: "abc",
      FRASE: "olá mundo # nao comentario",
      MULTI: "linha1\nlinha2",
      SMTP_HOST: "mail.exemplo.com",
      SMTP_PASS: SENHA,
      FALTA: "",
    });
    expect(screen.queryByText(/não salvas/)).toBeNull();
    expect(apiFetchMock.mock.calls.filter(([p]) => String(p).endsWith("/env/provided/SMTP_PASS"))).toHaveLength(1);
  });

  it("respeita o filtro Faltando e a pesquisa", async () => {
    serve();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /^Faltando/ }));
    fireEvent.click(btn());
    await screen.findByText("1 variável copiada");
    expect(copied()).toBe("FALTA=");
    expect(apiFetchMock.mock.calls.some(([p]) => String(p).includes("/env/provided/"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /^Todas/ }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Pesquisar variáveis" }), { target: { value: "api" } });
    fireEvent.click(btn());
    await waitFor(() => expect(copied()).toBe("API_KEY=abc"));
  });

  it("inclui rascunho e avisa", async () => {
    serve();
    await ready();
    fireEvent.change(screen.getByDisplayValue("abc"), { target: { value: "novo valor" } });
    fireEvent.click(btn());
    await screen.findByText(/inclui alterações não salvas/);
    expect(copied()).toContain("API_KEY='novo valor'");
  });

  it("desabilitado com lista vazia", async () => {
    serve();
    await ready();
    fireEvent.change(screen.getByRole("searchbox", { name: "Pesquisar variáveis" }), { target: { value: "zzzz" } });
    expect(btn().disabled).toBe(true);
  });

  it("falha do clipboard mostra mensagem clara", async () => {
    serve();
    copyMock.mockResolvedValue(false);
    await ready();
    fireEvent.click(btn());
    await screen.findByText(/Não foi possível copiar para a área de transferência/);
  });

  it("nome inválido fica de fora, é avisado e não entra na contagem", async () => {
    serve();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Adicionar variável/ }));
    const names = screen.getAllByPlaceholderText("NOME_DA_VARIAVEL");
    fireEvent.change(names[names.length - 1]!, { target: { value: "MEU-NOME" } });
    fireEvent.click(btn());
    await screen.findByText(/Ficaram de fora por nome inválido: MEU-NOME/);
    expect(screen.getByText(/^6 variáveis copiadas/)).toBeTruthy();
    expect(copied()).not.toContain("MEU-NOME");
  });

  it("linha apagada sem salvar conta como alteração não salva", async () => {
    serve();
    await ready();
    fireEvent.click(screen.getAllByRole("button", { name: /^Remover/ })[0]!);
    fireEvent.click(btn());
    await screen.findByText(/inclui alterações não salvas/);
  });

  it("linha do painel sem valor (servidor antigo) fica de fora e é avisada", async () => {
    apiFetchMock.mockImplementation(async () => ({ ...DATA, providedValues: undefined, provided: ["SMTP_HOST"] }));
    await ready();
    fireEvent.click(btn());
    await screen.findByText(/o servidor não enviou o valor\): SMTP_HOST/);
    expect(copied()).not.toContain("SMTP_HOST");
  });

  it("só linhas sem valor: não escreve nada e explica", async () => {
    apiFetchMock.mockImplementation(async () => ({ vars: [{ key: "MEU-NOME", value: "x" }], compose: null, provided: ["SMTP_HOST"], links: {} }));
    render(
      <MemoryRouter>
        <ProjectEnvCard project={PROJECT} />
      </MemoryRouter>,
    );
    await screen.findByDisplayValue("MEU-NOME");
    fireEvent.click(btn());
    await screen.findByText(/Não havia nada para copiar/);
    expect(copyMock).not.toHaveBeenCalled();
  });

  it("limite de pedidos: a mensagem manda aguardar um minuto", async () => {
    serve(async () => {
      throw new Error("429");
    });
    await ready();
    fireEvent.click(btn());
    await screen.findByText(/aguarde um minuto/);
  });

  it("se a senha não puder ser obtida, nada é copiado", async () => {
    serve(async () => {
      throw new Error("x");
    });
    await ready();
    fireEvent.click(btn());
    await screen.findByText(/Nada foi copiado: .*SMTP_PASS/);
    expect(copyMock).not.toHaveBeenCalled();
  });
});

describe("serializeDotenv", () => {
  const nasty = [
    "", "simples", " espaço nas pontas ", "a # b", "#x", "com 'simples'", 'com "duplas"', "um\ndois", "a\r\nb", "tab\tx",
    "$HOME ${X}", "back\\slash", "\\n literal", "'", '"', "mix ' \" \n \\ $ #", "=igual", "a=b c",
  ];
  it.each(nasty)("ida e volta: %j", (value) => {
    const out = parseDotenv(serializeDotenv([{ key: "K", value }]));
    expect(out.skipped).toEqual([]);
    expect(out.vars).toEqual([{ key: "K", value }]);
  });
  it("propriedade: ida e volta exata para milhares de valores aleatórios", () => {
    const alphabet = [" ", "\t", "\n", "\r", "'", '"', "#", "$", "\\", "=", "a", "Z", "9", "é", "\u00a0", "\u2028", "\ufeff", "`", "{", "}"];
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let n = 0; n < 5000; n++) {
      const len = Math.floor(rnd() * 9);
      let value = "";
      for (let i = 0; i < len; i++) value += alphabet[Math.floor(rnd() * alphabet.length)];
      const vars = [
        { key: "A", value: "antes" },
        { key: "K", value },
        { key: "Z", value: "depois" },
      ];
      const out = parseDotenv(serializeDotenv(vars));
      expect(out.skipped).toEqual([]);
      expect(out.vars).toEqual(vars);
    }
  });
  it.each(["a \nb", "a\t\nb", " \n ", "x\u00a0\ny", "\ufeff\nz"])("multilinha com espaço antes da quebra: %j", (value) => {
    expect(parseDotenv(serializeDotenv([{ key: "K", value }])).vars).toEqual([{ key: "K", value }]);
  });
  it("várias linhas e nome inválido ignorado", () => {
    expect(serializeDotenv([{ key: "A", value: "1" }, { key: "1x", value: "2" }, { key: "B", value: "a b" }])).toBe("A=1\nB='a b'");
    expect(quoteDotenvValue("x")).toBe("x");
  });
});
