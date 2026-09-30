/**
 * new-project-page.test.tsx — assistente de novo projeto, passo 1 (fonte).
 *
 * Defeitos da validação real (29/09/2026):
 *  - repositório privado: não havia onde informar o token no assistente (só na
 *    página do projeto, depois de criado);
 *  - erro no passo 1 e nova tentativa criavam um SEGUNDO projeto;
 *  - a mensagem de erro do servidor (várias linhas, com a orientação do git)
 *    aparecia espremida numa linha só.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { NewProjectPage } from "@/pages/NewProjectPage";

const PROJECT = { id: "p1", domain: "cassino.localhost", name: "cassino" };
const DETECTION = {
  type: "dockerfile",
  composeFile: null,
  outputDir: null,
  packageManager: null,
  buildCommand: null,
  proxyService: null,
  proxyPort: 80,
  warnings: [],
  details: [],
};

let detectFailures = 0;

beforeEach(() => {
  detectFailures = 0;
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/api/projects" && method === "POST") return { project: PROJECT };
    if (path === "/api/projects/p1" && method === "PATCH") return { project: PROJECT };
    if (path === "/api/projects/p1/credential" && method === "PUT") return { credential: { configured: true } };
    if (path === "/api/projects/p1/detect") {
      if (detectFailures > 0) {
        detectFailures -= 1;
        const { ApiRequestError } = await import("@/lib/api");
        throw new ApiRequestError(
          422,
          "Unprocessable",
          "Não foi possível baixar o código do repositório.\n\ngit clone falhou: Authentication failed",
        );
      }
      return { detection: DETECTION };
    }
    throw new Error(`chamada inesperada: ${method} ${path}`);
  });
});

afterEach(cleanup);

function preencherGit() {
  render(
    <MemoryRouter>
      <NewProjectPage />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByPlaceholderText("minha-app"), { target: { value: "cassino" } });
  fireEvent.click(screen.getByRole("button", { name: /Repositório Git/ }));
  fireEvent.change(screen.getByPlaceholderText("https://github.com/usuario/repo.git"), {
    target: { value: "https://github.com/usuario/cassino" },
  });
}

function chamadas(): string[] {
  return apiFetchMock.mock.calls.map(([p, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${p}`);
}

describe("NewProjectPage — repositório git", () => {
  it("público: cria e detecta, sem pedir credencial", async () => {
    preencherGit();
    expect(screen.queryByLabelText(/Token de leitura/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Criar e detectar/ }));
    await screen.findByText(/Tipo detectado/);
    expect(chamadas()).toEqual(["POST /api/projects", "POST /api/projects/p1/detect"]);
  });

  it("privado: o token vai para a credencial ANTES de baixar o código, e não fica na tela", async () => {
    preencherGit();
    fireEvent.click(screen.getByRole("checkbox", { name: /Repositório privado/ }));
    expect(screen.getByText(/somente leitura/i)).toBeInTheDocument();
    const token = screen.getByLabelText(/Token de leitura/) as HTMLInputElement;
    expect(token).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Mostrar token" })).toBeInTheDocument();
    fireEvent.change(token, { target: { value: "tok-fake-de-teste-123" } });

    fireEvent.click(screen.getByRole("button", { name: /Criar e detectar/ }));
    await waitFor(() => expect(chamadas()).toContain("POST /api/projects/p1/detect"));
    expect(chamadas()).toEqual([
      "POST /api/projects",
      "PUT /api/projects/p1/credential",
      "POST /api/projects/p1/detect",
    ]);
    const put = apiFetchMock.mock.calls.find(([p]) => p === "/api/projects/p1/credential");
    expect(JSON.parse(String((put?.[1] as RequestInit).body))).toEqual({ token: "tok-fake-de-teste-123" });
    expect(document.body.textContent).not.toContain("tok-fake-de-teste-123");
  });

  it("erro ao baixar: mensagem completa (várias linhas) e nova tentativa NÃO cria outro projeto", async () => {
    detectFailures = 1;
    preencherGit();
    fireEvent.click(screen.getByRole("button", { name: /Criar e detectar/ }));
    const erro = await screen.findByTestId("new-project-error");
    expect(erro).toHaveTextContent(/Não foi possível baixar o código/);
    expect(erro).toHaveTextContent(/Authentication failed/);
    expect(erro.className).toContain("whitespace-pre-line");

    // corrige a URL e tenta de novo
    fireEvent.change(screen.getByPlaceholderText("https://github.com/usuario/repo.git"), {
      target: { value: "https://github.com/usuario/cassino.git" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Tentar de novo/ }));
    await waitFor(() => expect(chamadas().filter((c) => c.endsWith("/detect"))).toHaveLength(2));
    expect(chamadas().filter((c) => c === "POST /api/projects")).toHaveLength(1);
    const patch = apiFetchMock.mock.calls.find(([p, i]) => p === "/api/projects/p1" && (i as RequestInit).method === "PATCH");
    expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toMatchObject({
      name: "cassino",
      source: "https://github.com/usuario/cassino.git",
      branch: "main",
    });
  });
});

/**
 * "Como gerar o token": passo a passo com o link certo do provedor, a partir
 * da URL colada. No GitHub (caminho validado), o guia completo — só leitura.
 */
describe("NewProjectPage — como gerar o token", () => {
  function abrirGuia(url: string) {
    render(
      <MemoryRouter>
        <NewProjectPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Repositório Git/ }));
    fireEvent.change(screen.getByPlaceholderText("https://github.com/usuario/repo.git"), { target: { value: url } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Repositório privado/ }));
    expect(screen.queryByTestId("token-guide")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Como gerar o token/ }));
    return screen.getByTestId("token-guide");
  }

  it("GitHub: link direto para criar o token e o passo a passo só-leitura", () => {
    const guia = abrirGuia("https://github.com/kelvin/meu-site");
    const link = screen.getByRole("link", { name: /Abrir a página do GitHub/ });
    expect(link).toHaveAttribute("href", "https://github.com/settings/personal-access-tokens/new");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(guia).toHaveTextContent(/Only select repositories/);
    expect(guia).toHaveTextContent(/kelvin\/meu-site/); // o repositório certo, tirado da URL
    expect(guia).toHaveTextContent(/Contents/);
    expect(guia).toHaveTextContent(/Read-only/);
    expect(guia).toHaveTextContent(/só aparece uma vez/i);
  });

  it("outro provedor: orientação geral, sem prometer um caminho que o painel não validou", () => {
    const guia = abrirGuia("https://gitlab.com/kelvin/meu-site.git");
    expect(guia).toHaveTextContent(/GitLab/);
    expect(guia).toHaveTextContent(/read_repository/);
    expect(guia).toHaveTextContent(/somente leitura/i);
  });
});

describe("NewProjectPage — tipo que o painel não sabe publicar", () => {
  it("explica o que o painel publica, em vez de só travar o botão", async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (path === "/api/projects" && method === "POST") return { project: PROJECT };
      if (path === "/api/projects/p1/detect") {
        return { detection: { ...DETECTION, type: "unknown", proxyPort: null, details: ["Nenhum compose, package.json ou Dockerfile encontrado — configuração manual necessária."] } };
      }
      throw new Error(`chamada inesperada: ${method} ${path}`);
    });
    preencherGit();
    fireEvent.click(screen.getByRole("button", { name: /Criar e detectar/ }));
    const ajuda = await screen.findByTestId("unsupported-help");
    expect(ajuda).toHaveTextContent(/index\.html/);
    expect(ajuda).toHaveTextContent(/Dockerfile/);
    expect(ajuda).toHaveTextContent(/compose/);
    expect(ajuda).toHaveTextContent(/npm run build/);
    expect(screen.getByRole("button", { name: /Continuar/ })).toBeDisabled();
  });

  it("site em HTML puro aparece como site estático", async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (path === "/api/projects" && method === "POST") return { project: PROJECT };
      if (path === "/api/projects/p1/detect") return { detection: { ...DETECTION, type: "static", proxyPort: null } };
      throw new Error(`chamada inesperada: ${method} ${path}`);
    });
    preencherGit();
    fireEvent.click(screen.getByRole("button", { name: /Criar e detectar/ }));
    expect(await screen.findByText(/site estático \(HTML\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continuar/ })).toBeEnabled();
  });
});

/**
 * Código do computador de quem usa o painel. O modo antigo pedia um caminho
 * de DENTRO do servidor (inútil online). Agora: janela de pasta do navegador,
 * que envia os arquivos — sem node_modules e .git.
 */
describe("NewProjectPage — enviar a pasta do meu computador", () => {
  function arquivo(caminho: string, conteudo = "x"): File {
    const f = new File([conteudo], caminho.split("/").pop()!, { type: "text/plain" });
    Object.defineProperty(f, "webkitRelativePath", { value: caminho });
    return f;
  }

  it("escolhe a pasta, mostra o resumo, envia cada arquivo e cria o projeto a partir do envio", async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (path === "/api/uploads" && method === "POST") return { id: "0123456789abcdef", dir: "/opt/tws-projects/_uploads/0123456789abcdef" };
      if (path.startsWith("/api/uploads/0123456789abcdef/file") && method === "PUT") return undefined;
      if (path === "/api/projects" && method === "POST") return { project: PROJECT };
      if (path === "/api/projects/p1/detect") return { detection: { ...DETECTION, type: "static" } };
      throw new Error(`chamada inesperada: ${method} ${path}`);
    });
    render(
      <MemoryRouter>
        <NewProjectPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByPlaceholderText("minha-app"), { target: { value: "devlinks" } });
    fireEvent.click(screen.getByRole("button", { name: /Enviar do meu computador/ }));
    const input = screen.getByTestId("folder-input") as HTMLInputElement;
    expect(input).toHaveAttribute("webkitdirectory");
    fireEvent.change(input, {
      target: {
        files: [
          arquivo("devlinks/index.html", "<h1>oi</h1>"),
          arquivo("devlinks/assets/logo.svg"),
          arquivo("devlinks/node_modules/pkg/index.js"),
          arquivo("devlinks/.git/config"),
        ],
      },
    });
    expect(screen.getByTestId("folder-summary")).toHaveTextContent(/devlinks/);
    expect(screen.getByTestId("folder-summary")).toHaveTextContent(/2 arquivos/);

    fireEvent.click(screen.getByRole("button", { name: /Criar e detectar/ }));
    await screen.findByText(/Tipo detectado/);
    const puts = apiFetchMock.mock.calls
      .filter(([, i]) => (i as RequestInit | undefined)?.method === "PUT")
      .map(([p]) => decodeURIComponent(String(p).split("path=")[1]!));
    expect(puts.sort()).toEqual(["assets/logo.svg", "index.html"]);
    const create = apiFetchMock.mock.calls.find(([p, i]) => p === "/api/projects" && (i as RequestInit).method === "POST");
    expect(JSON.parse(String((create![1] as RequestInit).body))).toMatchObject({
      ingestMode: "upload",
      source: "/opt/tws-projects/_uploads/0123456789abcdef",
    });
  });
});

describe("NewProjectPage — pasta que já está no servidor", () => {
  it("\"Procurar…\" navega só dentro da pasta de projetos e preenche o caminho", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/fs/dirs") {
        return { root: "/opt/tws-projects", path: "/opt/tws-projects", parent: null, dirs: [{ name: "meu-site", path: "/opt/tws-projects/meu-site", hasIndexHtml: true }] };
      }
      if (path.startsWith("/api/fs/dirs?path=")) {
        return { root: "/opt/tws-projects", path: "/opt/tws-projects/meu-site", parent: "/opt/tws-projects", dirs: [] };
      }
      throw new Error(`chamada inesperada: ${path}`);
    });
    render(
      <MemoryRouter>
        <NewProjectPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Pasta que já está no servidor/ }));
    fireEvent.click(screen.getByRole("button", { name: /Procurar/ }));
    const janela = await screen.findByRole("dialog");
    expect(janela).toHaveTextContent("/opt/tws-projects");
    fireEvent.click(await screen.findByRole("button", { name: /meu-site/ }));
    await waitFor(() => expect(screen.getByTestId("folder-browser-path")).toHaveTextContent("/opt/tws-projects/meu-site"));
    fireEvent.click(screen.getByRole("button", { name: /Usar esta pasta/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Caminho da pasta no servidor/)).toHaveValue("/opt/tws-projects/meu-site");
  });
});

it("trocar a origem não leva a URL do git para o campo da pasta", () => {
  render(
    <MemoryRouter>
      <NewProjectPage />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByPlaceholderText("https://github.com/usuario/repo.git"), {
    target: { value: "https://github.com/usuario/site" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Pasta que já está no servidor/ }));
  expect(screen.getByLabelText(/Caminho da pasta no servidor/)).toHaveValue("");
});
