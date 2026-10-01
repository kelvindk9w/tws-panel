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
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
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
    if (path.startsWith("/api/domains/suggest")) return { auto: "cassino.203-0-113-10.sslip.io", publicIp: "203.0.113.10" };
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
  return apiFetchMock.mock.calls
    .map(([p, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${p}`)
    // consultas de apoio (conta do GitHub, endereço automático) não entram na conta
    .filter((c) => !c.includes("/api/integrations/github") && !c.includes("/api/domains/suggest"));
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

/**
 * Passo 3 — domínio. Validação real: o assistente sugeria "nome.localhost",
 * que só funciona no computador de desenvolvimento. Agora: endereço automático
 * (<projeto>.<ip>.sslip.io, HTTPS na hora) ou domínio próprio com o registro
 * de DNS exato para criar.
 */
describe("NewProjectPage — domínio do projeto", () => {
  async function ateOPasso3() {
    preencherGit();
    fireEvent.click(screen.getByRole("button", { name: /Criar e detectar/ }));
    await screen.findByText(/Tipo detectado/);
    fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
  }

  it("o projeto nasce com o endereço automático (não .localhost) e ele vem marcado", async () => {
    await ateOPasso3();
    const create = apiFetchMock.mock.calls.find(([p, i]) => p === "/api/projects" && (i as RequestInit).method === "POST");
    expect(JSON.parse(String((create![1] as RequestInit).body)).domain).toBe("cassino.203-0-113-10.sslip.io");
    expect(screen.getByRole("radio", { name: /Endereço automático/ })).toBeChecked();
    expect(screen.getByTestId("auto-domain")).toHaveTextContent("https://cassino.203-0-113-10.sslip.io");
  });

  it("domínio próprio: mostra o registro de DNS exato a criar, com o IP da VPS", async () => {
    await ateOPasso3();
    fireEvent.click(screen.getByRole("radio", { name: /Meu domínio ou subdomínio/ }));
    fireEvent.change(screen.getByLabelText(/Seu domínio/), { target: { value: "site.meusite.com.br" } });
    const guia = screen.getByTestId("dns-guide");
    expect(within(guia).getByRole("columnheader", { name: "Tipo" })).toBeInTheDocument();
    expect(within(guia).getByRole("cell", { name: "A" })).toBeInTheDocument();
    expect(guia).toHaveTextContent("site.meusite.com.br");
    expect(guia).toHaveTextContent("203.0.113.10");
  });
});

/**
 * Validação real (30/09/2026): ao chegar na página do projeto nada acontecia —
 * o operador precisava achar o botão Deploy. Agora o primeiro deploy começa
 * sozinho; se o compose exige variáveis ainda sem valor, o assistente leva à
 * seção Variáveis em vez de disparar um deploy que falharia.
 */
describe("NewProjectPage — depois de \"Criar projeto\"", () => {
  function Onde() {
    const loc = useLocation();
    return <p data-testid="onde">{loc.pathname + loc.search}</p>;
  }

  async function criar(detection: Record<string, unknown>, env?: unknown) {
    const base = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/projects/p1/detect") return { detection };
      if (path === "/api/projects/p1/env") return env;
      return base(path, init);
    });
    render(
      <MemoryRouter initialEntries={["/new"]}>
        <Routes>
          <Route path="/new" element={<NewProjectPage />} />
          <Route path="*" element={<Onde />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByPlaceholderText("minha-app"), { target: { value: "cassino" } });
    fireEvent.click(screen.getByRole("button", { name: /Repositório Git/ }));
    fireEvent.change(screen.getByPlaceholderText("https://github.com/usuario/repo.git"), {
      target: { value: "https://github.com/usuario/cassino" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Criar e detectar/ }));
    await screen.findByText(/Tipo detectado/);
    fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Criar projeto/ }));
    return screen.findByTestId("onde");
  }

  it("vai para o projeto já pedindo o primeiro deploy", async () => {
    expect(await criar(DETECTION)).toHaveTextContent("/projects/p1?deploy=1");
  });

  it("compose com variáveis obrigatórias sem valor: vai para Variáveis, sem deploy", async () => {
    const compose = { ...DETECTION, type: "compose", composeFile: "compose.paas.yaml", proxyService: "web" };
    const env = {
      vars: [{ key: "SITE_HOST", value: "x" }],
      compose: {
        variables: [
          { name: "SITE_HOST", required: true, defaultValue: null },
          { name: "POSTGRES_PASSWORD", required: true, defaultValue: null },
          { name: "LOG_LEVEL", required: false, defaultValue: "info" },
        ],
      },
    };
    expect(await criar(compose, env)).toHaveTextContent("/projects/p1/env?deploy=pending");
  });

  it("compose com tudo preenchido: deploy direto", async () => {
    const compose = { ...DETECTION, type: "compose", composeFile: "compose.yml", proxyService: "web" };
    const env = { vars: [], compose: { variables: [{ name: "LOG_LEVEL", required: false, defaultValue: "info" }] } };
    expect(await criar(compose, env)).toHaveTextContent("/projects/p1?deploy=1");
  });
});
