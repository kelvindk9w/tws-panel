/**
 * Seção Variáveis — pesquisa, filtros rápidos, densidade e o que o e-mail do
 * projeto entrega. Validação real (03/10/2026): com ~70 variáveis o dono
 * pediu uma barra de pesquisa no topo e poder alternar a exibição; e não
 * entendeu o aviso "Fornecidas pelo e-mail do projeto no deploy: …".
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";
import { MemoryRouter } from "react-router";
import { COMPOSE_NAMES, ENV_EXAMPLE_NAMES } from "./fixtures/cassino-env-names";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ProjectEnvCard } from "@/components/ProjectEnvCard";

const PROJECT = { id: "p1", name: "cassino", slug: "cassino", detection: { type: "compose" } } as unknown as Project;
const DELIVERED = ["MAIL_FROM", "MAIL_FROM_NAME", "SMTP_HOST", "SMTP_PASS", "SMTP_PORT", "SMTP_USER"];

/** Projeto parecido com o real: compose com dezenas de variáveis, algumas preenchidas. */
function cassino(extra: Record<string, unknown> = {}) {
  return {
    vars: [
      { key: "AMBIENTE", value: "producao" },
      { key: "KYC_MODO", value: "demonstracao" },
      { key: "PIX_CHAVE", value: "chave-pix-exemplo" },
      { key: "SITE_HOST", value: "site.exemplo.com" },
    ],
    compose: {
      usesEnvFile: true,
      variables: COMPOSE_NAMES.map((name) => ({ name, required: name.startsWith("CASA_") || name === "POSTGRES_PASSWORD", defaultValue: null })),
    },
    provided: [...DELIVERED, "SMTP_SENHA"].sort(),
    links: { SMTP_SENHA: "SMTP_PASS" },
    ...extra,
  };
}

function serve(data: Record<string, unknown>) {
  apiFetchMock.mockImplementation(async (_path: string, init?: RequestInit) =>
    init?.method === "PUT" ? JSON.parse(String(init.body)) : data,
  );
}

function renderCard() {
  return render(
    <MemoryRouter>
      <ProjectEnvCard project={PROJECT} />
    </MemoryRouter>,
  );
}

const search = () => screen.getByRole("searchbox", { name: "Pesquisar variáveis" });
const rowNames = () =>
  screen
    .getAllByRole("listitem")
    .map((li) => li.getAttribute("data-testid"))
    .filter((id): id is string => !!id?.startsWith("env-row-") || !!id?.startsWith("env-panel-"))
    .map((id) => id.replace(/^env-(row|panel)-/, ""));

beforeEach(() => {
  apiFetchMock.mockReset();
  window.localStorage.clear();
});
afterEach(cleanup);

describe("Variáveis — o que o e-mail do projeto entrega", () => {
  it("aviso claro com os nomes, o que fazer se o app usa outros nomes e o link para o E-mail", async () => {
    serve(cassino());
    renderCard();
    const box = await screen.findByTestId("env-provided");
    expect(box).toHaveTextContent(
      "O e-mail do projeto entrega estas variáveis no deploy: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, MAIL_FROM_NAME.",
    );
    expect(box).toHaveTextContent(/Se o seu app usa outros nomes \(ex\.: SMTP_SENHA\), ligue em E-mail → Ligar às variáveis do projeto/);
    expect(box).toHaveTextContent("SMTP_SENHA ← SMTP_PASS");
    expect(within(box).getByRole("link", { name: /E-mail → Ligar às variáveis do projeto/ })).toHaveAttribute(
      "href",
      "/projects/p1/email",
    );
  });

  it("as entregues e as ligadas aparecem na lista como linhas do painel", async () => {
    // servidor antigo (sem providedValues): só diz que o painel fornece
    serve(cassino());
    renderCard();
    const senha = await screen.findByTestId("env-panel-SMTP_SENHA");
    expect(senha).toHaveTextContent("SMTP_SENHA ← SMTP_PASS");
    expect(senha).toHaveTextContent("fornecida pelo e-mail do projeto no deploy");
    expect(senha).not.toHaveTextContent(/senha da caixa — não é exibida/);
    expect(screen.getByTestId("env-panel-MAIL_FROM_NAME")).toHaveTextContent(/vem do E-mail do projeto/);
    // SMTP_HOST é do compose e o e-mail entrega: linha do painel, não um campo vazio
    expect(screen.getByTestId("env-panel-SMTP_HOST")).toBeInTheDocument();
    expect(screen.queryByTestId("env-row-SMTP_HOST")).not.toBeInTheDocument();
  });

  it("ligada ao e-mail e também salva nas Variáveis: a linha salva avisa que é ignorada no deploy", async () => {
    serve(cassino({ vars: [{ key: "SMTP_SENHA", value: "" }] }));
    renderCard();
    expect(await screen.findByTestId("env-row-SMTP_SENHA")).toHaveTextContent(
      /ignorada no deploy: SMTP_SENHA está ligada ao E-mail do projeto \(← SMTP_PASS\)/,
    );
    expect(screen.getByTestId("env-panel-SMTP_SENHA")).toBeInTheDocument();
  });
});

describe("Variáveis — pesquisa", () => {
  it("filtra por qualquer parte do nome, sem diferenciar maiúsculas, e mostra N de M", async () => {
    serve(cassino());
    renderCard();
    await screen.findByTestId("env-row-AMBIENTE");
    const total = rowNames().length;
    expect(screen.getByTestId("env-count")).toHaveTextContent(`${total} variáveis`);
    fireEvent.change(search(), { target: { value: "smtp" } });
    expect(rowNames().sort()).toEqual(["SMTP_HOST", "SMTP_PASS", "SMTP_PORT", "SMTP_PORTA", "SMTP_SENHA", "SMTP_USER"]);
    expect(screen.getByTestId("env-count")).toHaveTextContent(`6 de ${total} variáveis`);
    fireEvent.change(search(), { target: { value: "Host" } });
    expect(rowNames().sort()).toEqual(["CARTEIRA_HOST", "SITE_HOST", "SMTP_HOST"]);
  });

  it("procura no valor só quando ele está à mostra e o nome não parece segredo", async () => {
    serve({ vars: [{ key: "NODE_ENV", value: "production" }, { key: "API_KEY", value: "production-key" }], compose: null });
    renderCard();
    await screen.findByDisplayValue("production");
    fireEvent.change(search(), { target: { value: "production" } });
    // valores ocultos: nada
    expect(screen.getByText(/Nenhuma variável corresponde/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Limpar pesquisa" }));
    expect(search()).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: /Mostrar valores/ }));
    fireEvent.change(search(), { target: { value: "PRODUCTION" } });
    // NODE_ENV acha pelo valor; API_KEY tem nome de segredo — o valor não é pesquisado
    expect(rowNames()).toEqual(["NODE_ENV"]);
  });

  it("a seta do e-mail também acha: 'pass' encontra SMTP_SENHA ← SMTP_PASS", async () => {
    serve(cassino());
    renderCard();
    await screen.findByTestId("env-row-AMBIENTE");
    fireEvent.change(search(), { target: { value: "pass" } });
    expect(rowNames().sort()).toEqual(["POSTGRES_PASSWORD", "SMTP_PASS", "SMTP_SENHA"]);
  });

  it("linha nova e linha editada continuam à vista com a pesquisa ativa", async () => {
    serve({ vars: [{ key: "NODE_ENV", value: "production" }, { key: "PORT", value: "3000" }], compose: null });
    renderCard();
    await screen.findByDisplayValue("production");
    fireEvent.change(search(), { target: { value: "node" } });
    expect(rowNames()).toEqual(["NODE_ENV"]);
    // renomear a linha não a faz sumir no meio da digitação
    fireEvent.change(screen.getByDisplayValue("NODE_ENV"), { target: { value: "AMBIENTE" } });
    expect(screen.getByDisplayValue("AMBIENTE")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Adicionar variável/ }));
    expect(screen.getAllByPlaceholderText("NOME_DA_VARIAVEL")).toHaveLength(2);
    // salvar vale para todas, inclusive a que a pesquisa esconde
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/projects/p1/env",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ vars: [{ key: "AMBIENTE", value: "production" }, { key: "PORT", value: "3000" }] }),
        }),
      ),
    );
  });
});

describe("Variáveis — filtros rápidos", () => {
  it("Faltando, Preenchidas e Do painel, com a contagem; Todas volta", async () => {
    serve(cassino());
    renderCard();
    await screen.findByTestId("env-row-AMBIENTE");
    const missing = COMPOSE_NAMES.filter((n) => n.startsWith("CASA_") || n === "POSTGRES_PASSWORD");
    fireEvent.click(screen.getByRole("button", { name: `Faltando (${missing.length})` }));
    expect(screen.getByRole("button", { name: `Faltando (${missing.length})` })).toHaveAttribute("aria-pressed", "true");
    expect(rowNames().sort()).toEqual([...missing].sort());
    // preenchidas: as salvas com valor e as que o painel fornece
    fireEvent.click(screen.getByRole("button", { name: "Preenchidas (11)" }));
    expect(rowNames().sort()).toEqual(["AMBIENTE", "KYC_MODO", "PIX_CHAVE", "SITE_HOST", ...DELIVERED, "SMTP_SENHA"].sort());
    fireEvent.click(screen.getByRole("button", { name: /^Do painel/ }));
    expect(rowNames().sort()).toEqual([...DELIVERED, "SMTP_SENHA"].sort());
    // filtro e pesquisa juntos
    fireEvent.change(search(), { target: { value: "mail" } });
    expect(rowNames().sort()).toEqual(["MAIL_FROM", "MAIL_FROM_NAME"]);
    fireEvent.click(screen.getByRole("button", { name: /^Todas/ }));
    expect(rowNames()).toContain("ALARME_EMAIL");
  });

  it("muitas obrigatórias faltando: o aviso do topo não lista dezenas de nomes, leva ao filtro Faltando", async () => {
    serve(cassino());
    renderCard();
    const aviso = await screen.findByTestId("compose-vars");
    expect(aviso).not.toHaveTextContent("CASA_CNPJ");
    fireEvent.click(within(aviso).getByRole("button", { name: /Ver as 29 em Faltando/ }));
    expect(screen.getByRole("button", { name: "Faltando (29)" })).toHaveAttribute("aria-pressed", "true");
    expect(rowNames()).toHaveLength(29);
  });
});

describe("Variáveis — botões do rodapé com a pesquisa ativa", () => {
  const DATA = { vars: [{ key: "API_KEY", value: "abc" }, { key: "DB_URL", value: "postgres://x" }], compose: null };

  it("'Mostrar valores' vale só para as mostradas, e a tela avisa", async () => {
    serve(DATA);
    renderCard();
    await screen.findByDisplayValue("abc");
    fireEvent.change(search(), { target: { value: "api" } });
    expect(screen.getByTestId("env-filter-note")).toHaveTextContent(/“Mostrar valores” vale só para as mostradas \(1 de 2\)/);
    fireEvent.click(screen.getByRole("button", { name: /Mostrar valores/ }));
    fireEvent.change(search(), { target: { value: "" } });
    expect((screen.getByDisplayValue("abc") as HTMLInputElement).type).toBe("text");
    expect((screen.getByDisplayValue("postgres://x") as HTMLInputElement).type).toBe("password");
    expect(screen.queryByTestId("env-filter-note")).not.toBeInTheDocument();
  });

  it("'Apagar todas' apaga TODAS e a confirmação diz que inclui as escondidas pela pesquisa", async () => {
    serve(DATA);
    renderCard();
    await screen.findByDisplayValue("abc");
    fireEvent.change(search(), { target: { value: "api" } });
    fireEvent.click(screen.getByRole("button", { name: /Apagar todas/ }));
    expect(screen.getByTestId("env-clear-confirm")).toHaveTextContent(/inclusive 1 que a pesquisa está escondendo/);
    fireEvent.click(screen.getByRole("button", { name: /Sim, apagar todas/ }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/p1/env", expect.objectContaining({ method: "PUT", body: JSON.stringify({ vars: [] }) })),
    );
  });
});

describe("Variáveis — densidade", () => {
  it("Lista / Compacta; a escolha fica guardada no navegador", async () => {
    serve(cassino({ vars: [{ key: "AMBIENTE", value: "producao" }] }));
    const { unmount } = renderCard();
    await screen.findByTestId("env-row-AMBIENTE");
    expect(screen.getByRole("button", { name: "Lista" })).toHaveAttribute("aria-pressed", "true");
    // lista: o rótulo de cada linha aparece
    expect(screen.getByTestId("env-row-ALARME_EMAIL")).toHaveTextContent(/opcional/);
    fireEvent.click(screen.getByRole("button", { name: "Compacta" }));
    expect(screen.getByTestId("env-list")).toHaveAttribute("data-density", "compact");
    // compacta: rótulo vira dica (title); obrigatória sem valor continua avisando
    expect(screen.getByTestId("env-row-ALARME_EMAIL")).not.toHaveTextContent(/opcional/);
    expect(screen.getByTestId("env-row-ALARME_EMAIL")).toHaveAttribute("title", expect.stringMatching(/opcional/));
    expect(screen.getByTestId("env-row-CASA_CNPJ")).toHaveTextContent(/obrigatória/);
    unmount();
    renderCard();
    await screen.findByTestId("env-row-AMBIENTE");
    expect(screen.getByRole("button", { name: "Compacta" })).toHaveAttribute("aria-pressed", "true");
  });

  it("navegador sem armazenamento (modo privado): funciona do mesmo jeito", async () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    try {
      serve({ vars: [{ key: "A", value: "1" }], compose: null });
      renderCard();
      await screen.findByDisplayValue("1");
      fireEvent.click(screen.getByRole("button", { name: "Compacta" }));
      expect(screen.getByRole("button", { name: "Compacta" })).toHaveAttribute("aria-pressed", "true");
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});

/**
 * Validação real (03/10/2026): as fornecidas pelo e-mail do projeto e as
 * ligadas apareciam só como "fornecida pelo painel", sem valor — o dono
 * precisava VER que estavam preenchidas. Agora: campo mascarado com o olho,
 * como as outras, mas não editável (o valor vem do E-mail). Até
 * 04/10/2026 a senha da caixa nunca aparecia; desde então ela também tem o
 * olho, com o valor buscado a pedido (testes abaixo).
 */
describe("Variáveis — valores do que o e-mail do projeto fornece", () => {
  const VALUES = {
    SMTP_HOST: "mail.envio.exemplo.com.br",
    SMTP_PORT: "587",
    SMTP_USER: "contato@envio.exemplo.com.br",
    MAIL_FROM: "contato@envio.exemplo.com.br",
    MAIL_FROM_NAME: "Contato",
    EMAIL_DE: "contato@envio.exemplo.com.br",
  };
  const withValues = (extra: Record<string, unknown> = {}) =>
    cassino({
      provided: [...DELIVERED, "SMTP_SENHA", "EMAIL_DE"].sort(),
      links: { SMTP_SENHA: "SMTP_PASS", EMAIL_DE: "MAIL_FROM" },
      providedValues: VALUES,
      ...extra,
    });

  it("campo mascarado com o olho, não editável, e o link para a seção E-mail", async () => {
    serve(withValues());
    renderCard();
    const line = await screen.findByTestId("env-panel-EMAIL_DE");
    expect(line).toHaveTextContent("EMAIL_DE ← MAIL_FROM");
    const input = within(line).getByLabelText("Valor de EMAIL_DE") as HTMLInputElement;
    expect(input).toHaveValue("contato@envio.exemplo.com.br");
    expect(input.type).toBe("password");
    expect(input).toHaveAttribute("readonly");
    fireEvent.click(within(line).getByRole("button", { name: "Mostrar valor" }));
    expect(input.type).toBe("text");
    expect(within(line).getByRole("button", { name: "Copiar valor de EMAIL_DE" })).toBeInTheDocument();
    expect(within(line).getByRole("link", { name: "E-mail do projeto" })).toHaveAttribute("href", "/projects/p1/email");
  });

  /**
   * Mudança de decisão do dono do produto (04/10/2026, validação na VPS):
   * "Eu preciso conseguir visualizar o valor de qualquer variável que eu
   * desejar." Até aqui a senha da caixa (SMTP_PASS e as ligadas a ela)
   * mostrava só "preenchida (senha da caixa — não é exibida…)", sem campo.
   * Agora ela tem o campo mascarado com o olho e o copiar, como as outras;
   * a listagem continua sem a senha e o valor é buscado na rota própria
   * (GET /env/provided/:name, que registra na Auditoria) só quando a pessoa
   * clica no olho ou em "Mostrar valores".
   */
  const SENHA = "senha-de-exemplo-da-caixa";
  function serveWithReveal(
    data: Record<string, unknown>,
    reveal: (name: string) => Promise<unknown> = async (name) => ({ name, value: SENHA }),
  ) {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PUT") return JSON.parse(String(init.body));
      const m = /\/env\/provided\/([A-Za-z0-9_]+)$/.exec(path);
      if (m) return reveal(m[1]!);
      return data;
    });
  }
  const revealCalls = () =>
    apiFetchMock.mock.calls.map(([path]) => String(path)).filter((p) => p.includes("/env/provided/"));

  it("a senha: campo mascarado com o olho; o valor só é buscado ao clicar, e dá para copiar", async () => {
    serveWithReveal(withValues());
    renderCard();
    for (const name of ["SMTP_PASS", "SMTP_SENHA"]) {
      const line = await screen.findByTestId(`env-panel-${name}`);
      expect(line).not.toHaveTextContent(/senha da caixa — não é exibida/);
      const input = within(line).getByLabelText(`Valor de ${name}`) as HTMLInputElement;
      expect(input.type).toBe("password");
      expect(input).toHaveAttribute("readonly");
      // a listagem não traz a senha: nada no campo antes do clique
      expect(input).toHaveValue("");
      expect(revealCalls()).not.toContain(`/api/projects/p1/env/provided/${name}`);
      fireEvent.click(within(line).getByRole("button", { name: "Mostrar valor" }));
      await waitFor(() => expect(input).toHaveValue(SENHA));
      expect(input.type).toBe("text");
      expect(revealCalls()).toContain(`/api/projects/p1/env/provided/${name}`);
      expect(within(line).getByRole("button", { name: `Copiar valor de ${name}` })).toBeInTheDocument();
    }
  });

  it("ocultar e mostrar de novo não busca outra vez", async () => {
    serveWithReveal(withValues());
    renderCard();
    const line = await screen.findByTestId("env-panel-SMTP_PASS");
    const input = within(line).getByLabelText("Valor de SMTP_PASS") as HTMLInputElement;
    fireEvent.click(within(line).getByRole("button", { name: "Mostrar valor" }));
    await waitFor(() => expect(input).toHaveValue(SENHA));
    fireEvent.click(within(line).getByRole("button", { name: "Ocultar valor" }));
    expect(input.type).toBe("password");
    fireEvent.click(within(line).getByRole("button", { name: "Mostrar valor" }));
    expect(input.type).toBe("text");
    expect(revealCalls()).toEqual(["/api/projects/p1/env/provided/SMTP_PASS"]);
  });

  it("falha ao buscar (ex.: limite de frequência): avisa e o campo continua oculto", async () => {
    const { ApiRequestError } = await import("../src/lib/api");
    serveWithReveal(withValues(), async () => {
      throw new ApiRequestError(429, "reveal_rate_limited", "Muitos valores exibidos em pouco tempo. Espere um minuto e tente de novo.");
    });
    renderCard();
    const line = await screen.findByTestId("env-panel-SMTP_PASS");
    const input = within(line).getByLabelText("Valor de SMTP_PASS") as HTMLInputElement;
    fireEvent.click(within(line).getByRole("button", { name: "Mostrar valor" }));
    expect(await screen.findByText(/Muitos valores exibidos em pouco tempo/)).toBeInTheDocument();
    expect(input.type).toBe("password");
    expect(input).toHaveValue("");
    expect(within(line).queryByRole("button", { name: "Copiar valor de SMTP_PASS" })).toBeNull();
  });

  it("falha sem mensagem do servidor: frase genérica", async () => {
    serveWithReveal(withValues(), async () => {
      throw new Error("rede");
    });
    renderCard();
    const line = await screen.findByTestId("env-panel-SMTP_PASS");
    fireEvent.click(within(line).getByRole("button", { name: "Mostrar valor" }));
    expect(await screen.findByText("Não foi possível mostrar o valor de SMTP_PASS.")).toBeInTheDocument();
  });

  it("a senha à mostra nunca entra na pesquisa, mesmo com nome que não parece segredo", async () => {
    serveWithReveal(
      withValues({ provided: [...DELIVERED, "APP_X"].sort(), links: { APP_X: "SMTP_PASS" } }),
    );
    renderCard();
    const line = await screen.findByTestId("env-panel-APP_X");
    fireEvent.click(within(line).getByRole("button", { name: "Mostrar valor" }));
    await waitFor(() => expect(within(line).getByLabelText("Valor de APP_X")).toHaveValue(SENHA));
    fireEvent.change(search(), { target: { value: "senha-de-exemplo" } });
    expect(screen.queryByTestId("env-panel-APP_X")).not.toBeInTheDocument();
  });

  it("'Mostrar valores' revela também as do e-mail, a senha inclusive (buscada na rota própria)", async () => {
    serveWithReveal(withValues());
    renderCard();
    await screen.findByTestId("env-panel-MAIL_FROM");
    fireEvent.click(screen.getByRole("button", { name: /Mostrar valores/ }));
    const input = within(screen.getByTestId("env-panel-MAIL_FROM")).getByLabelText("Valor de MAIL_FROM") as HTMLInputElement;
    expect(input.type).toBe("text");
    const senha = within(screen.getByTestId("env-panel-SMTP_SENHA")).getByLabelText("Valor de SMTP_SENHA") as HTMLInputElement;
    await waitFor(() => expect(senha).toHaveValue(SENHA));
    expect(senha.type).toBe("text");
    expect(revealCalls().sort()).toEqual(["/api/projects/p1/env/provided/SMTP_PASS", "/api/projects/p1/env/provided/SMTP_SENHA"]);
    // e "Ocultar valores" esconde tudo de novo
    fireEvent.click(screen.getByRole("button", { name: /Ocultar valores/ }));
    expect(senha.type).toBe("password");
  });

  it("variável ligada e salva nas Variáveis: a salva é ignorada no deploy", async () => {
    serve(withValues({ vars: [{ key: "EMAIL_DE", value: "remetente@example.com" }] }));
    renderCard();
    expect(await screen.findByTestId("env-row-EMAIL_DE")).toHaveTextContent(/ignorada no deploy/);
    expect(within(screen.getByTestId("env-panel-EMAIL_DE")).getByLabelText("Valor de EMAIL_DE")).toHaveValue(
      "contato@envio.exemplo.com.br",
    );
  });

  it("nome padrão com valor nas Variáveis: a linha salva substitui (sem linha do painel repetida)", async () => {
    serve(withValues({ vars: [{ key: "SMTP_HOST", value: "smtp.outro.com" }] }));
    renderCard();
    expect(await screen.findByTestId("env-row-SMTP_HOST")).toHaveTextContent(/preencher aqui substitui/);
    expect(screen.queryByTestId("env-panel-SMTP_HOST")).not.toBeInTheDocument();
  });
});

/**
 * Validação real (cassino, 03/10/2026): o serviço `wallet` lê `env_file: .env`
 * e precisa de NICEAPI_*, IDENTIDADE_CHAVE etc., que não aparecem como ${...}
 * no compose. O filtro Faltando passa a incluir os nomes do .env.example sem
 * valor (aviso; não bloqueia o deploy).
 */
describe("Variáveis — o que falta do .env.example", () => {
  const SAVED = ["AMBIENTE", "KYC_MODO", "PIX_CHAVE", "SITE_HOST"];
  const PROVIDED = [...DELIVERED, "SMTP_SENHA"];
  const exampleMissing = [...new Set(ENV_EXAMPLE_NAMES)].filter(
    (n) => !COMPOSE_NAMES.includes(n) && !PROVIDED.includes(n) && !SAVED.includes(n),
  );
  const requiredMissing = COMPOSE_NAMES.filter((n) => n.startsWith("CASA_") || n === "POSTGRES_PASSWORD");
  const withExample = (extra: Record<string, unknown> = {}) =>
    cassino({
      example: { files: [".env.example"], variables: ENV_EXAMPLE_NAMES.map((name) => ({ name, file: ".env.example" })) },
      ...extra,
    });

  it("Faltando inclui os do .env.example sem valor, marcados; o deploy continua dependendo só das obrigatórias", async () => {
    serve(withExample());
    renderCard();
    await screen.findByTestId("env-row-AMBIENTE");
    const total = requiredMissing.length + exampleMissing.length;
    fireEvent.click(screen.getByRole("button", { name: `Faltando (${total})` }));
    expect(rowNames().sort()).toEqual([...requiredMissing, ...exampleMissing].sort());
    expect(screen.getByTestId("env-row-NICEAPI_API_TOKEN")).toHaveTextContent("do .env.example (o app pode ler por env_file)");
    expect(screen.getByTestId("env-row-IDENTIDADE_CHAVE")).toHaveTextContent("do .env.example (o app pode ler por env_file)");
    fireEvent.click(screen.getByRole("button", { name: /^Todas/ }));
    // nome do .env.example que o compose também usa segue a regra do compose
    expect(screen.getByTestId("env-row-SMTP_PORTA")).not.toHaveTextContent(/env_file/);
    // o aviso das obrigatórias não muda: as do .env.example não bloqueiam
    expect(screen.getByTestId("compose-vars")).toHaveTextContent(`${requiredMissing.length} obrigatória(s) ainda sem valor`);
  });

  it("aviso no topo com o número, 'Ver em Faltando' e a sugestão de importar o .env", async () => {
    serve(withExample());
    renderCard();
    const aviso = await screen.findByTestId("env-example-missing");
    expect(aviso).toHaveTextContent(`${exampleMissing.length} variáveis do .env.example estão sem valor`);
    expect(aviso).toHaveTextContent(/não bloqueiam o deploy/);
    expect(aviso).toHaveTextContent(/Importar arquivo \.env/);
    fireEvent.click(within(aviso).getByRole("button", { name: "Ver em Faltando" }));
    expect(screen.getByRole("button", { name: /^Faltando/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("preenchida: sai da contagem do aviso; a vazia não é salva", async () => {
    serve(withExample());
    renderCard();
    const row = await screen.findByTestId("env-row-NICEAPI_API_TOKEN");
    expect(screen.getByTestId("env-example-missing")).toHaveTextContent(`${exampleMissing.length} variáveis`);
    fireEvent.change(within(row).getByLabelText(/Valor da variável/), { target: { value: "token" } });
    expect(screen.getByTestId("env-example-missing")).toHaveTextContent(`${exampleMissing.length - 1} variáveis`);
    fireEvent.click(screen.getByRole("button", { name: /Salvar variáveis/ }));
    const put = () => apiFetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
    await waitFor(() => expect(put()).toBeDefined());
    const sent = JSON.parse(String((put()![1] as RequestInit).body)) as { vars: { key: string; value: string }[] };
    // as sugeridas do .env.example deixadas vazias não vão para o servidor
    expect(sent.vars.map((v) => v.key)).toEqual([...SAVED, "NICEAPI_API_TOKEN"]);
    expect(sent.vars.at(-1)).toEqual({ key: "NICEAPI_API_TOKEN", value: "token" });
  });

  it("um só faltando: frase no singular", async () => {
    serve(cassino({ example: { files: [".env.example"], variables: [{ name: "IDENTIDADE_CHAVE", file: ".env.example" }] } }));
    renderCard();
    expect(await screen.findByTestId("env-example-missing")).toHaveTextContent("1 variável do .env.example está sem valor");
  });

  it("sem nada faltando do .env.example: sem aviso", async () => {
    serve(cassino({ example: { files: [".env.example"], variables: [{ name: "AMBIENTE", file: ".env.example" }] } }));
    renderCard();
    await screen.findByTestId("env-row-AMBIENTE");
    expect(screen.queryByTestId("env-example-missing")).not.toBeInTheDocument();
  });
});
