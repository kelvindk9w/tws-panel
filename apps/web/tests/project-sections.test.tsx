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
import { MemoryRouter } from "react-router";

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

  it("resumo dos certificados dos domínios, com o link 'Ver em Certificados' (mesmo endpoint da página)", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/certificates?project=p1") {
        return {
          checkedAt: "x",
          proxyRunning: true,
          items: [
            {
              host: "devlink.tws.tec.br",
              owner: { kind: "project", projectId: "p1", projectName: "devLink" },
              mode: "automatic",
              coveredBy: null,
              state: "issuing",
              issuer: null,
              validTo: null,
              renewsAround: null,
              lastError: null,
              manual: null,
              canRetry: true,
            },
          ],
        };
      }
      throw new Error(path);
    });
    render(<ProjectDomainsCard project={PROJECT} publicIp="203.0.113.10" onChanged={vi.fn()} />);
    const resumo = await screen.findByTestId("certificate-summary");
    expect(await within(resumo).findByText("Emitindo")).toBeInTheDocument();
    expect(within(resumo).getByRole("link", { name: /Ver em Certificados/ })).toHaveAttribute("href", "/certificates");
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

/**
 * Pedidos do dono do produto (01/10/2026) para a seção Variáveis: mostrar
 * todos os valores de uma vez, copiar um valor visível, apagar tudo para
 * importar de novo; e reconhecer o que o painel já fornece (e-mail) e
 * variável que só é exigida se outra estiver vazia.
 */
describe("ProjectEnvCard — mostrar, copiar e apagar tudo", () => {
  const SAVED = { vars: [{ key: "API_KEY", value: "abc" }, { key: "DB_URL", value: "postgres://x" }] };

  it("\"Mostrar valores\" revela todos; \"Ocultar valores\" esconde de novo", async () => {
    apiFetchMock.mockImplementation(async () => SAVED);
    render(<ProjectEnvCard project={PROJECT} />);
    const v1 = (await screen.findByDisplayValue("abc")) as HTMLInputElement;
    const v2 = screen.getByDisplayValue("postgres://x") as HTMLInputElement;
    expect(v1.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: /Mostrar valores/ }));
    expect(v1.type).toBe("text");
    expect(v2.type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: /Ocultar valores/ }));
    expect(v1.type).toBe("password");
  });

  it("o olho de uma linha continua valendo sozinho; valor visível ganha o botão de copiar", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    apiFetchMock.mockImplementation(async () => SAVED);
    render(<ProjectEnvCard project={PROJECT} />);
    await screen.findByDisplayValue("abc");
    expect(screen.queryByRole("button", { name: /Copiar valor de API_KEY/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /Mostrar valor/ })[0]!);
    expect((screen.getByDisplayValue("abc") as HTMLInputElement).type).toBe("text");
    expect((screen.getByDisplayValue("postgres://x") as HTMLInputElement).type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: /Copiar valor de API_KEY/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("abc"));
    expect(await screen.findByText(/copiado/i)).toBeInTheDocument();
  });

  it("\"Apagar todas\" pede confirmação, apaga no servidor e volta à lista do compose", async () => {
    apiFetchMock.mockImplementation(async (_p: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? { vars: [] }
        : { ...SAVED, compose: { usesEnvFile: true, variables: [{ name: "KYC_MODO", required: true, defaultValue: null }] } },
    );
    render(<ProjectEnvCard project={PROJECT} />);
    await screen.findByDisplayValue("abc");
    fireEvent.click(screen.getByRole("button", { name: /Apagar todas/ }));
    expect(apiFetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === "PUT")).toBe(false);
    expect(screen.getByTestId("env-clear-confirm")).toHaveTextContent(/2 variáveis salvas/);
    fireEvent.click(screen.getByRole("button", { name: /Sim, apagar todas/ }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/projects/p1/env",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ vars: [] }) }),
      ),
    );
    expect(screen.queryByDisplayValue("abc")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("KYC_MODO")).toBeInTheDocument();
  });
});

describe("ProjectEnvCard — o que o painel fornece e variável alternativa", () => {
  it("SMTP_HOST do e-mail do projeto e MAIL_FROM coberta por EMAIL_DE não contam como faltando", async () => {
    apiFetchMock.mockImplementation(async () => ({
      vars: [{ key: "EMAIL_DE", value: "contato@x.com" }],
      provided: ["MAIL_FROM", "SMTP_HOST"],
      compose: {
        usesEnvFile: false,
        variables: [
          { name: "EMAIL_DE", required: false, defaultValue: "${MAIL_FROM:?x}" },
          { name: "KYC_MODO", required: true, defaultValue: null },
          { name: "MAIL_FROM", required: true, defaultValue: null, alternatives: ["EMAIL_DE"] },
          { name: "SMTP_HOST", required: true, defaultValue: null },
        ],
      },
    }));
    render(
      <MemoryRouter>
        <ProjectEnvCard project={PROJECT} />
      </MemoryRouter>,
    );
    await screen.findByDisplayValue("SMTP_HOST");
    expect(screen.getByTestId("env-row-SMTP_HOST")).toHaveTextContent(/fornecida pelo E-mail do projeto/);
    expect(screen.getByTestId("env-row-MAIL_FROM")).toHaveTextContent(/fornecida pelo E-mail do projeto/);
    expect(screen.getByTestId("env-row-EMAIL_DE")).toHaveTextContent(/se vazia, usa MAIL_FROM/);
    expect(screen.getByTestId("compose-vars")).toHaveTextContent(/1 obrigatória\(s\) ainda sem valor/);
  });

  /**
   * Variáveis ligadas ao e-mail do projeto (02/10/2026): o painel entrega no
   * deploy; aparecem na seção como fornecidas, sem valor (a senha nunca).
   */
  it("fornecidas que não estão na lista aparecem nela só com o nome; o aviso leva ao e-mail do projeto", async () => {
    apiFetchMock.mockImplementation(async () => ({
      vars: [{ key: "SMTP_HOST", value: "" }],
      provided: ["MAIL_FROM", "SMTP_HOST", "SMTP_PASS", "SMTP_SENHA"],
      compose: null,
    }));
    render(
      <MemoryRouter>
        <ProjectEnvCard project={PROJECT} />
      </MemoryRouter>,
    );
    const box = await screen.findByTestId("env-provided");
    expect(box).toHaveTextContent(/O e-mail do projeto entrega estas variáveis no deploy: SMTP_HOST, SMTP_PASS, MAIL_FROM\./);
    expect(box.querySelector("a")).toHaveAttribute("href", "/projects/p1/email");
    // as que não são linhas da lista aparecem nela só com o nome
    for (const name of ["MAIL_FROM", "SMTP_PASS", "SMTP_SENHA"]) {
      expect(screen.getByTestId(`env-panel-${name}`)).toHaveTextContent(/fornecida pelo e-mail do projeto/);
    }
    // SMTP_HOST já é uma linha da lista: não repete
    expect(screen.queryByTestId("env-panel-SMTP_HOST")).not.toBeInTheDocument();
  });

  it("sem o e-mail: MAIL_FROM só é exigida se EMAIL_DE estiver vazia", async () => {
    apiFetchMock.mockImplementation(async () => ({
      vars: [],
      compose: {
        usesEnvFile: false,
        variables: [{ name: "MAIL_FROM", required: true, defaultValue: null, alternatives: ["EMAIL_DE"] }],
      },
    }));
    render(<ProjectEnvCard project={PROJECT} />);
    await screen.findByDisplayValue("MAIL_FROM");
    expect(screen.getByTestId("env-row-MAIL_FROM")).toHaveTextContent(/obrigatória se EMAIL_DE estiver vazia/);
  });
});

/**
 * Pedido do dono do produto (01/10/2026): conectar o domínio antes do primeiro
 * deploy e já conseguir conferir. O cartão diz o que aparece no endereço.
 */
describe("ProjectDomainsCard — antes do primeiro deploy", () => {
  it("explica que o domínio já responde com a página 'Site em manutenção'", () => {
    render(
      <ProjectDomainsCard
        project={{ ...PROJECT, lastDeployStatus: null } as unknown as Project}
        publicIp={null}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText(/Site em manutenção/)).toBeInTheDocument();
    expect(screen.queryByText(/a partir do primeiro deploy/)).not.toBeInTheDocument();
  });
});
