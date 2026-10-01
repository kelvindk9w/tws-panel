/**
 * project-sections.test.tsx — seções Domínios e Variáveis do projeto.
 *
 * Domínios (validação real): para testar devlink.tws.tec.br era preciso
 * editar o domínio atual; agora o projeto tem vários domínios, com "Conectar
 * novo domínio" (registro de DNS exato + verificação), tornar principal e
 * remover. Variáveis: nome/valor, valores escondidos por padrão.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ProjectDomainsCard } from "@/components/ProjectDomainsCard";
import { ProjectEnvCard } from "@/components/ProjectEnvCard";

const PROJECT = {
  id: "p1",
  name: "devLink",
  slug: "devlink",
  domain: "devlink.203-0-113-10.sslip.io",
  aliases: ["devlink.tws.tec.br"],
  lastDeployStatus: "success",
  detection: { type: "dockerfile" },
} as unknown as Project;

beforeEach(() => {
  apiFetchMock.mockReset();
});
afterEach(cleanup);

describe("ProjectDomainsCard", () => {
  it("lista o principal e os adicionais, cada um com link", () => {
    render(<ProjectDomainsCard project={PROJECT} publicIp="203.0.113.10" onChanged={vi.fn()} />);
    const principal = screen.getByTestId("domain-devlink.203-0-113-10.sslip.io");
    expect(principal).toHaveTextContent(/principal/i);
    expect(within(principal).getByRole("link")).toHaveAttribute("href", "https://devlink.203-0-113-10.sslip.io");
    expect(screen.getByTestId("domain-devlink.tws.tec.br")).toBeInTheDocument();
  });

  it("conectar novo domínio: mostra o registro A com o IP da VPS e conecta", async () => {
    const onChanged = vi.fn();
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/domains/check")) return { ok: true, message: "O domínio aponta para esta máquina." };
      if (path === "/api/projects/p1/domains") return { project: PROJECT };
      throw new Error(path);
    });
    render(<ProjectDomainsCard project={PROJECT} publicIp="203.0.113.10" onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: /Conectar novo domínio/ }));
    fireEvent.change(screen.getByLabelText(/Novo domínio/), { target: { value: "www.devlink.com.br" } });
    const guia = screen.getByTestId("dns-guide");
    expect(guia).toHaveTextContent("www.devlink.com.br");
    expect(guia).toHaveTextContent("203.0.113.10");
    // Cloudflare: nuvem cinza (validação real — dúvida do dono do produto)
    expect(within(guia).getByTestId("dns-guide-cloudflare")).toHaveTextContent(/nuvem .*cinza/i);
    fireEvent.click(screen.getByRole("button", { name: /Verificar DNS/ }));
    expect(await screen.findByText(/aponta para esta máquina/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Conectar$/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/p1/domains", expect.objectContaining({ method: "POST", body: JSON.stringify({ domain: "www.devlink.com.br" }) }));
  });

  it("tornar principal e remover um adicional", async () => {
    const onChanged = vi.fn();
    apiFetchMock.mockResolvedValue({ project: PROJECT });
    render(<ProjectDomainsCard project={PROJECT} publicIp="203.0.113.10" onChanged={onChanged} />);
    const extra = screen.getByTestId("domain-devlink.tws.tec.br");
    fireEvent.click(within(extra).getByRole("button", { name: /Tornar principal/ }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/p1/domains/devlink.tws.tec.br/primary", expect.objectContaining({ method: "POST" })));
    fireEvent.click(within(extra).getByRole("button", { name: /Remover/ }));
    fireEvent.click(within(extra).getByRole("button", { name: /Confirmar/ }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/p1/domains/devlink.tws.tec.br", expect.objectContaining({ method: "DELETE" })));
    // o principal não tem "Remover"
    expect(within(screen.getByTestId("domain-devlink.203-0-113-10.sslip.io")).queryByRole("button", { name: /Remover/ })).not.toBeInTheDocument();
  });
});

describe("ProjectEnvCard", () => {
  it("carrega, esconde os valores, adiciona e salva a lista", async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/projects/p1/env" && (!init || !init.method)) return { vars: [{ key: "NODE_ENV", value: "production" }] };
      if (path === "/api/projects/p1/env" && init?.method === "PUT") return JSON.parse(String(init.body));
      throw new Error(path);
    });
    render(<ProjectEnvCard project={PROJECT} />);
    const valor = (await screen.findByDisplayValue("production")) as HTMLInputElement;
    expect(valor.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: /Adicionar variável/ }));
    const nomes = screen.getAllByPlaceholderText("NOME_DA_VARIAVEL");
    fireEvent.change(nomes[1]!, { target: { value: "DATABASE_URL" } });
    fireEvent.change(screen.getAllByPlaceholderText("valor")[1]!, { target: { value: "postgres://x" } });
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/projects/p1/env",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ vars: [{ key: "NODE_ENV", value: "production" }, { key: "DATABASE_URL", value: "postgres://x" }] }),
        }),
      ),
    );
    expect(await screen.findByText(/próximo deploy/i)).toBeInTheDocument();
  });

  it("site estático: avisa que não há servidor para ler as variáveis", async () => {
    apiFetchMock.mockResolvedValue({ vars: [] });
    render(<ProjectEnvCard project={{ ...PROJECT, detection: { type: "static" } } as unknown as Project} />);
    expect(await screen.findByTestId("env-static-note")).toBeInTheDocument();
  });
});

/**
 * Validação real (cassino): o compose exige dezenas de variáveis; sem a lista,
 * o operador descobriria uma de cada vez, a cada deploy que falha.
 */
describe("ProjectEnvCard — o que o compose espera", () => {
  const COMPOSE_ENV = {
    vars: [{ key: "POSTGRES_USER", value: "casa" }],
    compose: {
      usesEnvFile: true,
      variables: [
        { name: "LOG_LEVEL", required: false, defaultValue: null },
        { name: "POSTGRES_PASSWORD", required: true, defaultValue: null },
        { name: "POSTGRES_USER", required: true, defaultValue: null },
        { name: "SMTP_HOST", required: false, defaultValue: "mailpit" },
      ],
    },
  };

  function mockEnv() {
    apiFetchMock.mockImplementation(async (_path: string, init?: RequestInit) =>
      init?.method === "PUT" ? JSON.parse(String(init.body)) : COMPOSE_ENV,
    );
  }

  it("ao abrir, cada variável do compose já é uma linha para preencher (obrigatórias primeiro)", async () => {
    mockEnv();
    render(<ProjectEnvCard project={PROJECT} />);
    await screen.findByDisplayValue("POSTGRES_PASSWORD");
    const nomes = screen.getAllByPlaceholderText("NOME_DA_VARIAVEL").map((i) => (i as HTMLInputElement).value);
    expect(nomes).toEqual(["POSTGRES_USER", "POSTGRES_PASSWORD", "LOG_LEVEL", "SMTP_HOST"]);
    expect(screen.getByTestId("env-row-POSTGRES_PASSWORD")).toHaveTextContent(/obrigatória/);
    expect(screen.getByTestId("env-row-SMTP_HOST")).toHaveTextContent(/padrão: mailpit/);
    expect(screen.getByTestId("compose-vars")).toHaveTextContent(/1 obrigatória\(s\) ainda sem valor/);
  });

  it("salva o que foi preenchido; sugerida que ficou vazia não é salva (vale o padrão do compose)", async () => {
    mockEnv();
    render(<ProjectEnvCard project={PROJECT} />);
    await screen.findByDisplayValue("POSTGRES_PASSWORD");
    fireEvent.change(screen.getByLabelText("Valor da variável 2"), { target: { value: "s3nh@" } });
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/projects/p1/env",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            vars: [
              { key: "POSTGRES_USER", value: "casa" },
              { key: "POSTGRES_PASSWORD", value: "s3nh@" },
            ],
          }),
        }),
      ),
    );
  });
});

/**
 * Pedido do dono do produto (30/09/2026): subir o .env que já existe em vez de
 * digitar dezenas de variáveis. O arquivo é lido no navegador; nada é gravado
 * antes de "Salvar variáveis".
 */
describe("ProjectEnvCard — importar arquivo .env", () => {
  function importar(conteudo: string, nome = ".env") {
    const input = screen.getByTestId("env-file-input");
    fireEvent.change(input, { target: { files: [new File([conteudo], nome, { type: "text/plain" })] } });
  }

  it("preenche a lista com nomes e valores (atualiza as que já existem), sem salvar sozinho", async () => {
    apiFetchMock.mockImplementation(async () => ({ vars: [{ key: "NODE_ENV", value: "development" }] }));
    render(<ProjectEnvCard project={PROJECT} />);
    await screen.findByDisplayValue("NODE_ENV");
    importar("# local\nNODE_ENV=production\nDATABASE_URL='postgres://u:p@db/x'\nlinha ruim\n");
    expect(await screen.findByDisplayValue("DATABASE_URL")).toBeInTheDocument();
    expect(screen.getByDisplayValue("production")).toBeInTheDocument();
    expect(screen.getByDisplayValue("postgres://u:p@db/x")).toBeInTheDocument();
    const aviso = screen.getByTestId("env-import-result");
    expect(aviso).toHaveTextContent(/2 variáveis lidas/);
    expect(aviso).toHaveTextContent(/1 atualizada/);
    expect(aviso).toHaveTextContent(/1 nova/);
    expect(aviso).toHaveTextContent(/linha 4 ignorada/i);
    expect(aviso).toHaveTextContent(/Salvar variáveis/);
    expect(apiFetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === "PUT")).toBe(false);
  });

  it("recusa arquivo grande demais (não é um .env)", async () => {
    apiFetchMock.mockImplementation(async () => ({ vars: [] }));
    render(<ProjectEnvCard project={PROJECT} />);
    await screen.findByText(/Nenhuma variável ainda/);
    importar("A=".padEnd(300 * 1024, "x"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/grande demais/);
  });
});

describe("ProjectDomainsCard — porta por domínio (compose/Dockerfile)", () => {
  it("define a porta de um domínio; o padrão é a do projeto", async () => {
    apiFetchMock.mockResolvedValue({ project: PROJECT });
    const onChanged = vi.fn();
    const p = { ...PROJECT, proxyPort: 3200, detection: { type: "compose", proxyPort: 3200 } } as unknown as Project;
    render(<ProjectDomainsCard project={p} publicIp="203.0.113.10" onChanged={onChanged} />);
    const extra = screen.getByTestId("domain-devlink.tws.tec.br");
    const porta = within(extra).getByLabelText(/Porta/);
    expect(porta).toHaveAttribute("placeholder", "3200");
    fireEvent.change(porta, { target: { value: "8009" } });
    fireEvent.click(within(extra).getByRole("button", { name: /Salvar porta/ }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/projects/p1/domains/devlink.tws.tec.br/port",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ port: 8009 }) }),
      ),
    );
  });

  it("site estático: sem campo de porta", () => {
    render(<ProjectDomainsCard project={{ ...PROJECT, detection: { type: "static" } } as unknown as Project} publicIp={null} onChanged={vi.fn()} />);
    expect(screen.queryByLabelText(/Porta/)).not.toBeInTheDocument();
  });
});
