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
let putExtra: Record<string, unknown>;
let composeVars: Array<{ name: string; required: boolean }> | null;

function serve() {
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "PUT") return { ...JSON.parse(String(init.body)), ...putExtra };
    if (path.endsWith("/email")) return { email: null };
    return {
      vars: saved,
      compose: composeVars ? { variables: composeVars } : null,
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
  composeVars = null;
  putExtra = {};
});
afterEach(cleanup);

describe("Apagar todas", () => {
  it("pede confirmação e grava a lista vazia", async () => {
    serve();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Apagar todas/ }));
    expect(screen.getByTestId("env-clear-confirm")).toHaveTextContent(/Apagar as 3 variáveis da lista\? Nada é gravado agora: as 3 variáveis salvas do servidor só saem quando você clicar em Salvar variáveis/);
    fireEvent.click(screen.getByRole("button", { name: /Sim, apagar todas/ }));
    await screen.findByText(/Lista esvaziada/);
    // apagar só limpa o rascunho: nenhuma gravação (nem auditoria) até Salvar
    expect(puts()).toEqual([]);
    expect(screen.queryByDisplayValue("1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await screen.findByText(/valem a partir do próximo deploy/);
    expect(puts()).toEqual([[]]);
  });

  it("remover a última variável uma a uma e salvar manda lista vazia", async () => {
    saved = [{ key: "UNICA", value: "x" }];
    serve();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Remover UNICA" }));
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await screen.findByText(/valem a partir do próximo deploy/);
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
    // a confirmação conta o que está na tela, não o que está salvo (0)
    expect(screen.getByTestId("env-clear-confirm")).toHaveTextContent(/Apagar as 2 variáveis da lista\? Nada é gravado até você clicar em Salvar variáveis/);
    expect(screen.getByTestId("env-clear-confirm")).not.toHaveTextContent(/0 variáveis/);
    fireEvent.click(screen.getByRole("button", { name: /Sim, apagar todas/ }));
    await screen.findByText(/Lista esvaziada/);
    expect(screen.queryByDisplayValue("2")).not.toBeInTheDocument();
    expect(puts()).toEqual([]);
  });

  it("variáveis fornecidas pelo painel: a confirmação avisa que continuam", async () => {
    provided = ["SMTP_HOST"];
    serve();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Apagar todas/ }));
    expect(screen.getByTestId("env-clear-confirm")).toHaveTextContent(/fornecidas pelo painel.*não são apagadas/);
  });

  it("só campos sugeridos vazios (.env.example): habilitado, e o clique tira as sugestões da tela de verdade", async () => {
    saved = [];
    example = ["SO_NOME"];
    serve();
    await ready();
    expect(screen.getByDisplayValue("SO_NOME")).toBeInTheDocument();
    const apagar = screen.getByRole("button", { name: /Apagar todas/ });
    expect(apagar).toBeEnabled();
    fireEvent.click(apagar);
    const confirm = screen.getByTestId("env-clear-confirm");
    expect(confirm).toHaveTextContent(/Apagar a variável da lista\? Nada é gravado até você clicar em Salvar variáveis\./);
    expect(confirm).toHaveTextContent(/campos sugeridos.*saem da tela e voltam ao salvar, ao importar ou ao recarregar/);
    expect(confirm).not.toHaveTextContent(/continuam na tela|as 1 /);
    fireEvent.click(screen.getByRole("button", { name: /Sim, apagar todas/ }));
    await screen.findByText(/Lista esvaziada/);
    expect(screen.queryByDisplayValue("SO_NOME")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Apagar todas/ })).toBeDisabled();
    expect(puts()).toEqual([]);
  });

  it("as sugestões voltam ao importar na lista vazia (mesclar) e ao salvar", async () => {
    saved = [];
    example = ["SO_NOME"];
    composeVars = [{ name: "DB_PASS", required: true }];
    serve();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Apagar todas/ }));
    fireEvent.click(screen.getByRole("button", { name: /Sim, apagar todas/ }));
    await screen.findByText(/Lista esvaziada/);
    expect(screen.queryByDisplayValue("DB_PASS")).not.toBeInTheDocument();
    importText("X=1\n");
    await screen.findByDisplayValue("1");
    expect(screen.getByDisplayValue("DB_PASS")).toBeInTheDocument();
    expect(screen.getByDisplayValue("SO_NOME")).toBeInTheDocument();
  });

  it("só sugestões do compose sem valor: habilitado", async () => {
    saved = [];
    composeVars = [{ name: "DB_PASS", required: true }];
    serve();
    await ready();
    expect(screen.getByRole("button", { name: /Apagar todas/ })).toBeEnabled();
  });

  it("só variáveis do painel: desabilitado (nada removível); com uma removível, habilitado", async () => {
    saved = [];
    provided = ["SMTP_HOST"];
    serve();
    await ready();
    const bloqueado = screen.getByRole("button", { name: /Apagar todas/ });
    expect(bloqueado).toBeDisabled();
    expect(bloqueado).toHaveAttribute("title", "As variáveis fornecidas pelo painel não podem ser apagadas aqui.");
    expect(bloqueado.getAttribute("aria-describedby")).toBe("env-clear-panel-only");
    expect(document.getElementById("env-clear-panel-only")).toHaveTextContent(/não podem ser apagadas aqui/);
    cleanup();
    saved = [{ key: "A", value: "1" }];
    serve();
    await ready();
    expect(screen.getByRole("button", { name: /Apagar todas/ })).toBeEnabled();
  });

  it("só rascunho: variável digitada sem valor habilita e a confirmação conta a linha", async () => {
    saved = [];
    serve();
    await ready();
    expect(screen.getByRole("button", { name: /Apagar todas/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Adicionar variável/ }));
    expect(screen.getByRole("button", { name: /Apagar todas/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Apagar todas/ }));
    expect(screen.getByTestId("env-clear-confirm")).toHaveTextContent(/^Apagar a variável da lista\?/);
    expect(screen.getByTestId("env-clear-confirm")).not.toHaveTextContent(/as 1 /);
  });

  it("só importadas (nada salvo) e sem valor (NOME=): habilitado", async () => {
    saved = [];
    serve();
    await ready();
    importText("X=\nY=\n");
    await screen.findByDisplayValue("X");
    expect(screen.getByRole("button", { name: /Apagar todas/ })).toBeEnabled();
  });

  it("com pesquisa que esconde tudo: continua habilitado e a confirmação avisa das escondidas", async () => {
    serve();
    await ready();
    fireEvent.change(screen.getByLabelText(/Pesquisar/i), { target: { value: "zzz" } });
    const apagar = screen.getByRole("button", { name: /Apagar todas/ });
    expect(apagar).toBeEnabled();
    fireEvent.click(apagar);
    expect(screen.getByTestId("env-clear-confirm")).toHaveTextContent(/Apagar as 3 variáveis da lista — inclusive 3 que a pesquisa está escondendo/);
    fireEvent.click(screen.getByRole("button", { name: /Sim, apagar todas/ }));
    await screen.findByText(/Lista esvaziada/);
    fireEvent.change(screen.getByLabelText(/Pesquisar/i), { target: { value: "" } });
    expect(screen.queryByDisplayValue("1")).not.toBeInTheDocument();
  });

  it("a contagem das escondidas pela pesquisa inclui sugerida (sugeridas) junto das salvas", async () => {
    composeVars = [{ name: "DB_PASS", required: true, defaultValue: null }, { name: "DB_USER", required: false, defaultValue: null }] as typeof composeVars;
    serve();
    await ready();
    fireEvent.change(screen.getByLabelText(/Pesquisar/i), { target: { value: "zzz" } });
    fireEvent.click(screen.getByRole("button", { name: /Apagar todas/ }));
    expect(screen.getByTestId("env-clear-confirm")).toHaveTextContent(/Apagar as 5 variáveis da lista — inclusive 5 que a pesquisa está escondendo/);
  });

  it("uma salva só: singular na confirmação e no aviso do servidor", async () => {
    saved = [{ key: "UNICA", value: "x" }];
    serve();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Apagar todas/ }));
    expect(screen.getByTestId("env-clear-confirm")).toHaveTextContent(
      /^Apagar a variável da lista\? Nada é gravado agora: a variável salva do servidor só sai quando você clicar em Salvar variáveis\./,
    );
  });

  it("durante o salvamento fica desabilitado e volta depois", async () => {
    let release!: () => void;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        await new Promise<void>((r) => (release = r));
        return JSON.parse(String(init.body));
      }
      if (path.endsWith("/email")) return { email: null };
      return { vars: saved, compose: null, provided: [], providedValues: {}, links: {}, example: null };
    });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Apagar todas/ })).toBeDisabled());
    release();
    await waitFor(() => expect(screen.getByRole("button", { name: /Apagar todas/ })).toBeEnabled());
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
    await screen.findByText(/valem a partir do próximo deploy/);
    // a marca "de build" de B continua
    expect(puts()).toEqual([[{ key: "B", value: "dois", build: true }, { key: "D", value: "4" }]]);
  });
});

describe("Substituir com sugestões, linha em branco e limites", () => {
  it("Substituir mantém as sugestões do compose e do .env.example que o arquivo não traz", async () => {
    saved = [{ key: "A", value: "1" }];
    composeVars = [{ name: "DB_PASS", required: true }];
    example = ["SO_NOME"];
    serve();
    await ready();
    fireEvent.click(screen.getByLabelText(/Substituir todas/));
    importText("D=4\n");
    await screen.findByDisplayValue("4");
    expect(screen.queryByDisplayValue("1")).not.toBeInTheDocument();
    expect(screen.getByTestId("env-row-DB_PASS")).toBeInTheDocument();
    expect(screen.getByTestId("env-row-SO_NOME")).toBeInTheDocument();
    expect(screen.getByTestId("env-import-result")).toHaveTextContent(/1 removida/);
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await screen.findByText(/valem a partir do próximo deploy/);
    expect(puts()).toEqual([[{ key: "D", value: "4" }]]);
  });

  it("NOME= vazio de nome sugerido não é gravado, igual em Mesclar e em Substituir", async () => {
    for (const mode of [/Mesclar/, /Substituir todas/]) {
      cleanup();
      apiFetchMock.mockReset();
      saved = [];
      example = ["SO_NOME"];
      serve();
      await ready();
      fireEvent.click(screen.getByLabelText(mode));
      importText("SO_NOME=\nD=4\n");
      await screen.findByDisplayValue("4");
      fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
      await screen.findByText(/valem a partir do próximo deploy/);
      expect(puts()).toEqual([[{ key: "D", value: "4" }]]);
    }
  });

  it("linha nova em branco não conta como removida", async () => {
    saved = [{ key: "A", value: "1" }];
    serve();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Adicionar variável/ }));
    fireEvent.click(screen.getByLabelText(/Substituir todas/));
    importText("A=1\n");
    await screen.findByTestId("env-import-result");
    expect(screen.getByTestId("env-import-result")).toHaveTextContent(/0 removidas/);
  });

  it("o modo volta a Mesclar depois de cada importação", async () => {
    serve();
    await ready();
    fireEvent.click(screen.getByLabelText(/Substituir todas/));
    importText("A=1\n");
    await screen.findByTestId("env-import-result");
    expect((screen.getByLabelText(/Mesclar com as atuais/) as HTMLInputElement).checked).toBe(true);
  });

  it("mais de 1000 variáveis: mensagem clara, sem pedido ao servidor", async () => {
    saved = [];
    serve();
    await ready();
    importText(Array.from({ length: 1001 }, (_, i) => `V${i}=x`).join("\n"));
    await screen.findByTestId("env-import-result", undefined, { timeout: 15000 });
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/No máximo 1000 variáveis \(a lista tem 1001\)/);
    expect(puts()).toEqual([]);
  }, 40000);

  it("corpo grande demais (acima de 1 MB, ou 413 do servidor): mensagem com o limite", async () => {
    saved = [];
    serve();
    await ready();
    for (let i = 0; i < 40; i++) {
      fireEvent.click(screen.getByRole("button", { name: /Adicionar variável/ }));
      const names = screen.getAllByPlaceholderText("NOME_DA_VARIAVEL");
      fireEvent.change(names[names.length - 1]!, { target: { value: `K${i}` } });
      const values = screen.getAllByLabelText(/^Valor da variável/);
      fireEvent.change(values[values.length - 1]!, { target: { value: "x".repeat(30000) } });
    }
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/limite de 1 MB/);
    expect(puts()).toEqual([]);
  }, 40000);

  it("413 vindo do servidor também mostra a mensagem do limite", async () => {
    saved = [{ key: "A", value: "1" }];
    serve();
    const base = apiFetchMock.getMockImplementation()!;
    const { ApiRequestError } = await import("../src/lib/api");
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PUT") throw new ApiRequestError(413, "FST_ERR_CTP_BODY_TOO_LARGE", "Request body is too large");
      return base(path, init);
    });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/limite de 1 MB/);
  });
});

describe("Salvar com o que falta: grava e avisa", () => {
  it("obrigatórias faltando: salva, mostra o aviso claro e não mostra erro", async () => {
    saved = [{ key: "A", value: "1" }];
    composeVars = [{ name: "DB_PASS", required: true }, { name: "KYC_MODO", required: true }];
    putExtra = { missing: ["DB_PASS", "KYC_MODO"] };
    serve();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await screen.findByText(/valem a partir do próximo deploy/);
    expect(puts()).toEqual([[{ key: "A", value: "1" }]]);
    expect(screen.getByTestId("env-save-warning")).toHaveTextContent(
      "Faltam 2 variáveis obrigatórias: DB_PASS, KYC_MODO — o deploy será recusado até preenchê-las.",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // mexer na lista tira o aviso antigo
    fireEvent.click(screen.getByRole("button", { name: /Adicionar variável/ }));
    expect(screen.queryByTestId("env-save-warning")).not.toBeInTheDocument();
  });

  it("uma só faltando (singular) e mais de 5 (resumo)", async () => {
    saved = [{ key: "A", value: "1" }];
    putExtra = { missing: ["X1"] };
    serve();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await screen.findByTestId("env-save-warning");
    expect(screen.getByTestId("env-save-warning")).toHaveTextContent("Falta 1 variável obrigatória: X1 — o deploy será recusado até preenchê-la.");
    putExtra = { missing: ["V1", "V2", "V3", "V4", "V5", "V6", "V7"] };
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await waitFor(() => expect(screen.getByTestId("env-save-warning")).toHaveTextContent(/Faltam 7 variáveis obrigatórias: V1, V2, V3, V4, V5 e mais 2 —/));
  });

  it("marca de build que o build não recebe: salva e avisa com o motivo", async () => {
    saved = [{ key: "PATH", value: "/x", build: true }];
    putExtra = { buildIssues: [{ name: "PATH", reason: "nome reservado" }] };
    serve();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await screen.findByTestId("env-save-warning");
    expect(screen.getByTestId("env-save-warning")).toHaveTextContent(/PATH \(nome reservado\)/);
    expect(puts()).toEqual([[{ key: "PATH", value: "/x", build: true }]]);
  });

  it("nome inválido: o servidor recusa e a tela mostra o erro, sem aviso de salvo", async () => {
    saved = [{ key: "A", value: "1" }];
    serve();
    const base = apiFetchMock.getMockImplementation()!;
    const { ApiRequestError } = await import("../src/lib/api");
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PUT") throw new ApiRequestError(400, "invalid_env_key", "Nome inválido: \"1RUIM\".");
      return base(path, init);
    });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Nome inválido/);
    expect(screen.queryByTestId("env-save-warning")).not.toBeInTheDocument();
  });
});

describe("Aviso persistente de variável fora do build (vale ao recarregar)", () => {
  it("marcada de build com nome reservado ou quebra de linha mostra o motivo na própria linha", async () => {
    saved = [
      { key: "PATH", value: "/x", build: true },
      { key: "VITE_A", value: "a\nb", build: true },
      { key: "VITE_OK", value: "ok", build: true },
      { key: "SEM_MARCA", value: "/y" },
    ];
    serve();
    await ready();
    expect(screen.getByTestId("env-build-out-PATH")).toHaveTextContent("Fora do build: nome reservado.");
    expect(screen.getByTestId("env-build-out-VITE_A")).toHaveTextContent("Fora do build: valor com quebra de linha.");
    expect(screen.queryByTestId("env-build-out-VITE_OK")).not.toBeInTheDocument();
    expect(screen.queryByTestId("env-build-out-SEM_MARCA")).not.toBeInTheDocument();
  });
});
