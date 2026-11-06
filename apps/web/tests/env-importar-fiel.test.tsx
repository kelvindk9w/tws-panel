/**
 * Variáveis — importar = exatamente o arquivo; sugestões do repositório só antes do primeiro deploy;
 * filtros Preenchidas/Vazias com o Copiar respeitando o que está à mostra; dica de variáveis vazias na falha do deploy.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeployJob, Project } from "@paas/core";
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
import { EmptyEnvHint } from "@/components/project/DeployLog";
import { parseDotenv } from "../src/lib/dotenv";
import { setLocale } from "../src/i18n";

const PROJECT = { id: "p1", name: "loja", slug: "loja", detection: { type: "compose" } } as unknown as Project;

let saved: Array<{ key: string; value: string }>;
let exampleSeen: string[] | null;

function serve() {
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "PUT") return JSON.parse(String(init.body));
    if (path.endsWith("/email")) return { email: null };
    return {
      vars: saved,
      compose: { variables: [{ name: "DB_PASS", required: true, defaultValue: null }, { name: "TZ_X", required: false, defaultValue: null }] },
      provided: [],
      providedValues: {},
      links: {},
      example: { files: [".env.example"], variables: [{ name: "SO_NOME", file: ".env.example" }] },
      exampleSeen,
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

const FILE = [
  "# comentário solto",
  "#COMENTADA=1",
  "",
  "NODE_ENV=production",
  "export API_KEY=abc",
  "minuscula=valor",
  "VAZIA=",
  'ASPAS="com espaço"',
  "VAZIA_ASPAS=''",
  "linha sem igual",
  "  # outra comentada=2",
].join("\n");

beforeEach(() => {
  apiFetchMock.mockReset();
  copyMock.mockReset();
  copyMock.mockResolvedValue(true);
  window.localStorage.clear();
  setLocale("pt-BR", { persist: false });
  saved = [{ key: "VELHA", value: "x" }];
  exampleSeen = null;
});
afterEach(cleanup);

describe("leitor do .env: conta exatamente as variáveis do arquivo", () => {
  it("vazias, minúsculas, export, aspas e brancos entram; comentários e linhas sem = não", () => {
    const { vars, skipped } = parseDotenv(FILE);
    expect(vars.map((v) => v.key)).toEqual(["NODE_ENV", "API_KEY", "minuscula", "VAZIA", "ASPAS", "VAZIA_ASPAS"]);
    expect(vars.find((v) => v.key === "VAZIA")!.value).toBe("");
    expect(vars.find((v) => v.key === "VAZIA_ASPAS")!.value).toBe("");
    expect(vars.find((v) => v.key === "ASPAS")!.value).toBe("com espaço");
    expect(skipped).toEqual([10]);
  });
});

describe("importar = exatamente o arquivo", () => {
  it("Mesclar: entram as 6 do arquivo (vazias gravadas vazias), as salvas ficam e nenhuma sugerida entra", async () => {
    exampleSeen = [];
    serve();
    await ready();
    importText(FILE);
    await screen.findByTestId("env-import-result");
    expect(screen.getByTestId("env-import-result")).toHaveTextContent(/6 variáveis importadas/);
    expect(screen.queryByTestId("env-row-DB_PASS")).not.toBeInTheDocument();
    expect(screen.queryByTestId("env-row-SO_NOME")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await screen.findByText(/valem a partir do próximo deploy/);
    expect(puts()).toEqual([
      [
        { key: "VELHA", value: "x" },
        { key: "NODE_ENV", value: "production" },
        { key: "API_KEY", value: "abc" },
        { key: "minuscula", value: "valor" },
        { key: "VAZIA", value: "" },
        { key: "ASPAS", value: "com espaço" },
        { key: "VAZIA_ASPAS", value: "" },
      ],
    ]);
  });

  it("Mesclar: variável vazia no arquivo sobrescreve a salva com vazio", async () => {
    saved = [{ key: "VAZIA", value: "cheia" }];
    serve();
    await ready();
    importText("VAZIA=\n");
    await screen.findByTestId("env-import-result");
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await screen.findByText(/valem a partir do próximo deploy/);
    expect(puts()).toEqual([[{ key: "VAZIA", value: "" }]]);
  });

  it("Mesclar em projeto novo: a importação não acrescenta nenhuma sugerida às que já estavam na tela", async () => {
    saved = [];
    serve();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Apagar todas/ }));
    fireEvent.click(screen.getByRole("button", { name: /Sim, apagar todas/ }));
    await screen.findByText(/Lista esvaziada/);
    importText("A=1\n");
    await screen.findByTestId("env-import-result");
    expect(screen.queryByTestId("env-row-DB_PASS")).not.toBeInTheDocument();
    expect(screen.queryByTestId("env-row-SO_NOME")).not.toBeInTheDocument();
    expect(screen.getByTestId("env-import-result")).toHaveTextContent(/1 variável importada/);
  });

  it("Substituir: o resultado é idêntico ao arquivo, vazias inclusive, sem sugeridas", async () => {
    serve();
    await ready();
    fireEvent.click(screen.getByLabelText(/Substituir todas/));
    importText(FILE);
    await screen.findByTestId("env-import-result");
    expect(screen.getByTestId("env-import-result")).toHaveTextContent(/6 variáveis importadas/);
    expect(screen.queryByTestId("env-row-DB_PASS")).not.toBeInTheDocument();
    expect(screen.queryByTestId("env-row-SO_NOME")).not.toBeInTheDocument();
    expect(screen.queryByTestId("env-row-VELHA")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await screen.findByText(/valem a partir do próximo deploy/);
    expect(puts()).toEqual([
      [
        { key: "NODE_ENV", value: "production" },
        { key: "API_KEY", value: "abc" },
        { key: "minuscula", value: "valor" },
        { key: "VAZIA", value: "" },
        { key: "ASPAS", value: "com espaço" },
        { key: "VAZIA_ASPAS", value: "" },
      ],
    ]);
  });

  it("depois de salvar num projeto já publicado, nada volta de bagagem (nem apagando tudo e importando de novo)", async () => {
    exampleSeen = ["SO_NOME"];
    saved = [];
    serve();
    await ready();
    importText("A=1\n");
    await screen.findByTestId("env-import-result");
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await screen.findByText(/valem a partir do próximo deploy/);
    expect(puts().at(-1)).toEqual([{ key: "A", value: "1" }]);
    expect(screen.queryByTestId("env-row-DB_PASS")).not.toBeInTheDocument();
  });
});

describe("sugestões do repositório", () => {
  it("projeto novo mostra as do compose e do .env.example", async () => {
    serve();
    await ready();
    expect(screen.getByTestId("env-row-DB_PASS")).toBeInTheDocument();
    expect(screen.getByTestId("env-row-SO_NOME")).toBeInTheDocument();
  });

  it("projeto com deploy não mostra sugestões, nem as do compose", async () => {
    exampleSeen = ["SO_NOME"];
    serve();
    await ready();
    expect(screen.getByTestId("env-row-VELHA")).toBeInTheDocument();
    expect(screen.queryByTestId("env-row-DB_PASS")).not.toBeInTheDocument();
    expect(screen.queryByTestId("env-row-TZ_X")).not.toBeInTheDocument();
    expect(screen.queryByTestId("env-row-SO_NOME")).not.toBeInTheDocument();
  });
});

describe("filtros Preenchidas e Vazias e o Copiar", () => {
  beforeEach(() => {
    exampleSeen = [];
    saved = [
      { key: "CHEIA", value: "1" },
      { key: "VAZIA", value: "" },
      { key: "OUTRA", value: "2" },
    ];
  });

  it("Vazias mostra só as vazias e o Copiar copia só elas", async () => {
    serve();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /^Vazias \(1\)/ }));
    fireEvent.click(screen.getByRole("button", { name: "Copiar todas as variáveis" }));
    await screen.findByText("1 variável copiada");
    expect(copyMock.mock.calls.at(-1)![0]).toBe("VAZIA=");
  });

  it("Preenchidas mostra só as preenchidas e o Copiar copia só elas", async () => {
    serve();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /^Preenchidas \(2\)/ }));
    fireEvent.click(screen.getByRole("button", { name: "Copiar todas as variáveis" }));
    await screen.findByText("2 variáveis copiadas");
    expect(copyMock.mock.calls.at(-1)![0]).toBe("CHEIA=1\nOUTRA=2");
  });
});

describe("dica de variáveis vazias na falha do deploy", () => {
  const job = (patch: Partial<DeployJob>) => ({ id: "j1", projectId: "p1", status: "failed", steps: [], log: "", error: "boom", ...patch }) as unknown as DeployJob;

  it("mostra os nomes quando o deploy falhou", () => {
    render(<EmptyEnvHint job={job({ emptyEnvVars: ["X", "Y"] })} />);
    expect(screen.getByTestId("deploy-empty-env-hint")).toHaveTextContent(
      "Variáveis vazias neste projeto: X, Y — confira se alguma delas causou o erro.",
    );
  });

  it("não mostra sem vazias nem em deploy que deu certo", () => {
    const { container, rerender } = render(<EmptyEnvHint job={job({})} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<EmptyEnvHint job={job({ status: "success", emptyEnvVars: ["X"] })} />);
    expect(container).toBeEmptyDOMElement();
  });
});
