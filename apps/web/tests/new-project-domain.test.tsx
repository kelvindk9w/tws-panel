/**
 * new-project-domain.test.tsx — assistente de novo projeto, passo 3, endereço automático.
 *
 * O endereço de sslip.io tem o IP da VPS no nome. O passo 3:
 *  - avisa em âmbar (não é erro) quando o endereço escolhido é sslip.io, com
 *    atalho para "Meu domínio ou subdomínio" e para o Domínio de aplicações;
 *  - com um domínio de aplicações verificado, o endereço automático é o dele
 *    (sem aviso) e o sslip.io vira a alternativa "Endereço de teste", com o aviso;
 *  - se o domínio de aplicações for configurado em outra aba enquanto o
 *    assistente está aberto, ao voltar o endereço automático passa a ser o novo.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { setLocale } from "@/i18n/core";
import { NewProjectPage } from "@/pages/NewProjectPage";

const SSLIP = "loja.203-0-113-10.sslip.io";
const APPS = "loja-k3x9q.apps.example.com";
const WARNING = "Este endereço contém o IP da VPS. Use para testar; para publicar, use o seu domínio ou subdomínio.";

type Suggestion = Record<string, unknown>;
let suggestion: Suggestion;
let project: { id: string; domain: string; name: string };

const SSLIP_ONLY: Suggestion = { auto: SSLIP, publicIp: "203.0.113.10" };
const WITH_APPS: Suggestion = { auto: APPS, publicIp: "203.0.113.10", kind: "apps", appsBase: "apps.example.com", testAddress: SSLIP };

beforeEach(() => {
  suggestion = SSLIP_ONLY;
  project = { id: "p1", domain: SSLIP, name: "loja" };
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/api/projects" && method === "POST") {
      project = { ...project, domain: JSON.parse(String(init!.body)).domain };
      return { project };
    }
    if (path === "/api/projects/p1" && method === "PATCH") return { project };
    if (path.startsWith("/api/domains/suggest")) return suggestion;
    if (path === "/api/projects/p1/detect") {
      return { detection: { type: "dockerfile", composeFile: null, outputDir: null, packageManager: null, buildCommand: null, proxyService: null, proxyPort: 80, warnings: [], details: [] } };
    }
    if (path.startsWith("/api/integrations/github")) throw new Error("sem github");
    throw new Error(`chamada inesperada: ${method} ${path}`);
  });
});
afterEach(cleanup);

async function ateOPasso3() {
  render(
    <MemoryRouter>
      <NewProjectPage />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByPlaceholderText("minha-app"), { target: { value: "loja" } });
  fireEvent.click(screen.getByRole("button", { name: /Repositório Git/ }));
  fireEvent.change(screen.getByPlaceholderText("https://github.com/usuario/repo.git"), { target: { value: "https://github.com/usuario/loja" } });
  fireEvent.click(screen.getByRole("button", { name: /Criar e detectar/ }));
  await screen.findByText(/Tipo detectado/);
  fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
  await screen.findByTestId("auto-domain");
}

function patchBody(): Record<string, unknown> {
  const call = apiFetchMock.mock.calls.filter(([p, i]) => p === "/api/projects/p1" && (i as RequestInit | undefined)?.method === "PATCH").at(-1);
  return JSON.parse(String((call![1] as RequestInit).body));
}

describe("passo 3 — aviso do endereço com o IP da VPS", () => {
  it("endereço automático sslip.io: aviso âmbar com a frase exata, ícone e título (role note, não só cor)", async () => {
    await ateOPasso3();
    const aviso = screen.getByTestId("ip-warning");
    expect(aviso).toHaveAttribute("role", "note");
    expect(aviso).toHaveTextContent(WARNING);
    expect(within(aviso).getByText("O IP da VPS aparece neste endereço")).toBeInTheDocument();
    expect(aviso.querySelector("svg")).not.toBeNull();
    expect(aviso.className).toMatch(/amber/);
    expect(aviso.className).not.toMatch(/red|destructive/);
  });

  it("o aviso tem atalho para 'Meu domínio ou subdomínio' e link (em outra aba) para configurar o Domínio de aplicações", async () => {
    await ateOPasso3();
    const aviso = screen.getByTestId("ip-warning");
    const link = within(aviso).getByRole("link", { name: /Configurar o domínio de aplicações/ });
    expect(link).toHaveAttribute("href", "/settings/apps-domain");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    fireEvent.click(within(aviso).getByRole("button", { name: /Usar meu domínio ou subdomínio/ }));
    expect(screen.getByRole("radio", { name: /Meu domínio ou subdomínio/ })).toBeChecked();
    expect(screen.queryByTestId("ip-warning")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Seu domínio/)).toBeInTheDocument();
  });

  it("domínio próprio escolhido: sem aviso; voltar ao automático: o aviso volta", async () => {
    await ateOPasso3();
    fireEvent.click(screen.getByRole("radio", { name: /Meu domínio ou subdomínio/ }));
    expect(screen.queryByTestId("ip-warning")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Endereço automático/ }));
    expect(screen.getByTestId("ip-warning")).toBeInTheDocument();
  });

  it("endereço .localhost (desenvolvimento): sem aviso, porque não tem IP", async () => {
    suggestion = { auto: "loja.localhost", publicIp: null };
    project = { ...project, domain: "loja.localhost" };
    await ateOPasso3();
    expect(screen.queryByTestId("ip-warning")).not.toBeInTheDocument();
  });

  it("em inglês: a frase equivalente e os rótulos do glossário", async () => {
    setLocale("en", { persist: false });
    render(
      <MemoryRouter>
        <NewProjectPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByPlaceholderText("my-app"), { target: { value: "loja" } });
    fireEvent.click(screen.getByRole("button", { name: /Git repository/ }));
    fireEvent.change(screen.getByPlaceholderText("https://github.com/user/repo.git"), { target: { value: "https://github.com/user/loja" } });
    fireEvent.click(screen.getByRole("button", { name: /Create and detect/ }));
    await screen.findByText(/Detected type/);
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    const aviso = await screen.findByTestId("ip-warning");
    expect(aviso).toHaveTextContent("This address contains the VPS IP. Use it to test; to publish, use your own domain or subdomain.");
    expect(within(aviso).getByRole("link", { name: /Set up the apps domain/ })).toHaveAttribute("href", "/settings/apps-domain");
    expect(within(aviso).getByRole("button", { name: /Use my domain or subdomain/ })).toBeInTheDocument();
  });
});

describe("passo 3 — com domínio de aplicações verificado", () => {
  beforeEach(() => {
    suggestion = WITH_APPS;
    project = { ...project, domain: APPS };
  });

  it("o projeto nasce com o endereço sob a base, sem IP nem aviso; o sslip.io não é o padrão", async () => {
    await ateOPasso3();
    const create = apiFetchMock.mock.calls.find(([p, i]) => p === "/api/projects" && (i as RequestInit).method === "POST");
    expect(JSON.parse(String((create![1] as RequestInit).body)).domain).toBe(APPS);
    expect(screen.getByRole("radio", { name: /Endereço automático/ })).toBeChecked();
    expect(screen.getByTestId("auto-domain")).toHaveTextContent(`https://${APPS}`);
    expect(screen.getByTestId("auto-domain").textContent).not.toContain("sslip");
    expect(screen.queryByTestId("ip-warning")).not.toBeInTheDocument();
    expect(screen.getByText(/domínio de aplicações \(apps\.example\.com\)/)).toBeInTheDocument();
  });

  it("o sslip.io continua disponível como 'Endereço de teste', com o aviso; ao criar, o projeto usa o endereço escolhido", async () => {
    await ateOPasso3();
    fireEvent.click(screen.getByRole("radio", { name: /Endereço de teste/ }));
    expect(screen.getByTestId("auto-domain")).toHaveTextContent(`https://${SSLIP}`);
    expect(screen.getByTestId("ip-warning")).toHaveTextContent(WARNING);
    fireEvent.click(screen.getByRole("button", { name: /Criar projeto/ }));
    await waitFor(() => expect(patchBody()).toMatchObject({ domain: SSLIP }));
  });

  it("criar com o endereço automático envia o endereço sob a base", async () => {
    await ateOPasso3();
    fireEvent.click(screen.getByRole("button", { name: /Criar projeto/ }));
    await waitFor(() => expect(patchBody()).toMatchObject({ domain: APPS }));
  });

  it("sem endereço de teste (sem IP público) a opção não aparece", async () => {
    suggestion = { ...WITH_APPS, testAddress: null };
    await ateOPasso3();
    expect(screen.queryByRole("radio", { name: /Endereço de teste/ })).not.toBeInTheDocument();
  });
});

describe("passo 3 — domínio de aplicações configurado enquanto o assistente está aberto", () => {
  it("ao voltar para a aba, o endereço automático passa a ser o novo e o aviso some; o projeto é salvo com ele", async () => {
    await ateOPasso3();
    expect(screen.getByTestId("ip-warning")).toBeInTheDocument();
    suggestion = WITH_APPS;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(screen.getByTestId("auto-domain")).toHaveTextContent(`https://${APPS}`));
    expect(screen.queryByTestId("ip-warning")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Criar projeto/ }));
    await waitFor(() => expect(patchBody()).toMatchObject({ domain: APPS }));
  });

  it("sem mudança no servidor, voltar para a aba não troca o endereço", async () => {
    await ateOPasso3();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByTestId("auto-domain")).toHaveTextContent(`https://${SSLIP}`);
    expect(screen.getByTestId("ip-warning")).toBeInTheDocument();
  });

  it("com domínio próprio escolhido, voltar para a aba não mexe na escolha", async () => {
    await ateOPasso3();
    fireEvent.click(screen.getByRole("radio", { name: /Meu domínio ou subdomínio/ }));
    fireEvent.change(screen.getByLabelText(/Seu domínio/), { target: { value: "site.meusite.com.br" } });
    suggestion = WITH_APPS;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByRole("radio", { name: /Meu domínio ou subdomínio/ })).toBeChecked();
    expect((screen.getByLabelText(/Seu domínio/) as HTMLInputElement).value).toBe("site.meusite.com.br");
  });

  it("falha ao consultar na volta da aba é ignorada", async () => {
    await ateOPasso3();
    apiFetchMock.mockImplementationOnce(async () => {
      throw new Error("sem rede");
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByTestId("auto-domain")).toHaveTextContent(`https://${SSLIP}`);
  });
});
