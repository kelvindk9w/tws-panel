/**
 * Nome de exibição das caixas (pedido do dono, 22/10/2026): o campo existe em todo lugar que cria uma caixa
 * (página do domínio e aba Caixas do projeto), aparece nas listas e pode ser alterado depois, sem mexer em
 * senha, 2FA, senhas de app, apelidos nem mensagens.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mailbox } from "@paas/core";
import { MailboxesPanel } from "@/components/mail/MailboxesPanel";
import { setLocale } from "@/i18n/core";

const USER_BOX: Mailbox = {
  id: "vendas@exemplo.com.br",
  localPart: "vendas",
  domain: "exemplo.com.br",
  kind: "user",
  createdAt: "2026-10-01T12:00:00.000Z",
  displayName: "Loja Exemplo - Vendas",
};
const NO_NAME_BOX: Mailbox = { ...USER_BOX, id: "contato@exemplo.com.br", localPart: "contato" };
delete (NO_NAME_BOX as { displayName?: string }).displayName;
const PROJECT_BOX: Mailbox = {
  id: "loja@exemplo.com.br",
  localPart: "loja",
  domain: "exemplo.com.br",
  kind: "project",
  createdAt: "2026-10-01T12:00:00.000Z",
  projectId: "p1",
};

type Call = { url: string; method: string; body: Record<string, unknown> | null };

interface ApiOpts {
  mailboxes: Mailbox[];
  putStatus?: number;
  /** resposta do PUT (padrão: a caixa com o nome novo) */
  putExtra?: Record<string, unknown>;
  holdPut?: Promise<void>;
}

function mockApi(opts: ApiOpts): Call[] {
  const calls: Call[] = [];
  let boxes = [...opts.mailboxes];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url, method, body });
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/display-name") && method === "PUT") {
        await opts.holdPut;
        if (opts.putStatus && opts.putStatus >= 400) return json({ error: "mailbox_not_in_project", message: "A caixa não é deste projeto." }, opts.putStatus);
        const id = decodeURIComponent(url.split("/mailboxes/")[1]!.split("/")[0]!);
        const name = String(body!.displayName);
        boxes = boxes.map((b) => {
          if (b.id !== id) return b;
          const next = { ...b };
          if (name) next.displayName = name;
          else delete next.displayName;
          return next;
        });
        return json({ mailbox: boxes.find((b) => b.id === id), ...(opts.putExtra ?? {}) });
      }
      if (url.split("?")[0]!.endsWith("/mailboxes") && method === "GET") return json({ mailboxes: boxes });
      if (url.endsWith("/mailboxes") && method === "POST") {
        const created: Mailbox = {
          ...NO_NAME_BOX,
          id: `${body!.localPart}@exemplo.com.br`,
          localPart: String(body!.localPart),
          ...(body!.displayName ? { displayName: String(body!.displayName) } : {}),
        };
        boxes = [...boxes, created];
        return json({ mailbox: created }, 201);
      }
      if (url.endsWith("/api/mail/webmail")) return json({ enabled: false, running: false });
      return json({});
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setLocale("pt-BR", { persist: false });
});

function renderPanel(props: { projectId?: string } = {}) {
  return render(
    <MemoryRouter>
      <MailboxesPanel domain="exemplo.com.br" {...props} />
    </MemoryRouter>,
  );
}

const dialogField = () => within(screen.getByRole("dialog")).getByLabelText("Nome de exibição (opcional)");
const rowOf = (id: string) => screen.getByText(id).closest("[data-mailbox]") as HTMLElement;

describe("criar caixa — campo Nome de exibição", () => {
  it("página do domínio: o campo existe, com exemplo e dica, e o nome vai no corpo (aparado)", async () => {
    const calls = mockApi({ mailboxes: [] });
    const user = userEvent.setup();
    renderPanel();
    const field = await screen.findByLabelText("Nome de exibição (opcional)");
    expect(field).toHaveAttribute("placeholder", "Ex.: Loja Exemplo - Atendimento");
    expect(screen.getByText(/Em branco, o e-mail sai só com o endereço/)).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("contato"), "suporte");
    await user.type(field, "  Suporte Exemplo ");
    await user.click(screen.getByRole("radio", { name: /Gerar uma senha forte/ }));
    await user.click(screen.getByRole("button", { name: /Criar caixa/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        localPart: "suporte",
        generatePassword: true,
        displayName: "Suporte Exemplo",
      }),
    );
    // aparece na lista junto do endereço e o campo é limpo
    expect(await screen.findByText("Nome de exibição: Suporte Exemplo")).toBeInTheDocument();
    expect(screen.getByLabelText("Nome de exibição (opcional)")).toHaveValue("");
  });

  it("sem nome: nada de displayName no corpo", async () => {
    const calls = mockApi({ mailboxes: [] });
    const user = userEvent.setup();
    renderPanel();
    await user.type(await screen.findByPlaceholderText("contato"), "geral");
    await user.click(screen.getByRole("radio", { name: /Gerar uma senha forte/ }));
    await user.click(screen.getByRole("button", { name: /Criar caixa/ }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toBeTruthy());
    expect(calls.find((c) => c.method === "POST")!.body).not.toHaveProperty("displayName");
  });

  it("aba do projeto: o mesmo campo, junto do projectId", async () => {
    const calls = mockApi({ mailboxes: [PROJECT_BOX] });
    const user = userEvent.setup();
    renderPanel({ projectId: "p1" });
    await user.type(await screen.findByPlaceholderText("contato"), "suporte");
    await user.type(screen.getByLabelText("Nome de exibição (opcional)"), "Suporte da Loja");
    await user.click(screen.getByRole("radio", { name: /Gerar uma senha forte/ }));
    await user.click(screen.getByRole("button", { name: /Criar caixa/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        localPart: "suporte",
        generatePassword: true,
        projectId: "p1",
        displayName: "Suporte da Loja",
      }),
    );
  });

  it("nome com < >, aspas ou barra invertida: erro no campo (aria-invalid) e Criar caixa desabilitado", async () => {
    mockApi({ mailboxes: [] });
    const user = userEvent.setup();
    renderPanel();
    const field = await screen.findByLabelText("Nome de exibição (opcional)");
    await user.type(screen.getByPlaceholderText("contato"), "x");
    await user.click(screen.getByRole("radio", { name: /Gerar uma senha forte/ }));
    for (const bad of ["a<b", 'a"b', "a\\b", "x".repeat(81)]) {
      fireEvent.change(field, { target: { value: bad } });
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("button", { name: /Criar caixa/ })).toBeDisabled();
    }
    expect(screen.getByText("No máximo 80 caracteres.")).toBeInTheDocument();
    fireEvent.change(field, { target: { value: "ok" } });
    expect(field).not.toHaveAttribute("aria-invalid");
    expect(screen.getByRole("button", { name: /Criar caixa/ })).toBeEnabled();
  });

  it("quebra de linha colada no campo também é recusada", async () => {
    mockApi({ mailboxes: [] });
    renderPanel();
    const field = await screen.findByLabelText("Nome de exibição (opcional)");
    fireEvent.change(field, { target: { value: "Oi\r\nBcc: x@evil.test" } });
    // input de uma linha tira CR/LF sozinho no navegador; o que sobrar ainda é validado como texto
    expect(screen.queryByText(/Sem quebra de linha/)).toBeNull();
    fireEvent.change(field, { target: { value: "Oi\tTab" } });
    expect(field).toHaveAttribute("aria-invalid", "true");
  });

  it("o rótulo está ligado ao campo e a dica descreve o campo (acessibilidade)", async () => {
    mockApi({ mailboxes: [] });
    renderPanel();
    const field = await screen.findByLabelText("Nome de exibição (opcional)");
    const hintId = field.getAttribute("aria-describedby")!;
    expect(document.getElementById(hintId)).toHaveTextContent(/80 caracteres/);
  });
});

describe("listas — nome ao lado do endereço", () => {
  it("mostra o nome e, sem nome, 'Sem nome de exibição'; texto longo quebra linha (sem estourar 360 px)", async () => {
    mockApi({ mailboxes: [USER_BOX, NO_NAME_BOX, { ...PROJECT_BOX, displayName: "Loja Royal" }] });
    renderPanel();
    await screen.findByText("vendas@exemplo.com.br");
    const named = screen.getByTestId("display-name-vendas@exemplo.com.br");
    expect(named).toHaveTextContent("Nome de exibição: Loja Exemplo - Vendas");
    expect(named.className).toContain("break-words");
    expect(screen.getByTestId("display-name-contato@exemplo.com.br")).toHaveTextContent("Sem nome de exibição");
    expect(screen.getByTestId("display-name-loja@exemplo.com.br")).toHaveTextContent("Nome de exibição: Loja Royal");
  });

  it("o nome vindo do servidor é texto, nunca HTML", async () => {
    mockApi({ mailboxes: [{ ...USER_BOX, displayName: "<img src=x onerror=alert(1)>" }] });
    renderPanel();
    await screen.findByText("vendas@exemplo.com.br");
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByTestId("display-name-vendas@exemplo.com.br")).toHaveTextContent("<img src=x onerror=alert(1)>");
  });
});

describe("Alterar nome de exibição", () => {
  it("abre um modal curto com o nome atual, explica o que NÃO muda e envia só o nome", async () => {
    const calls = mockApi({ mailboxes: [USER_BOX] });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("vendas@exemplo.com.br");
    await user.click(within(rowOf("vendas@exemplo.com.br")).getByRole("button", { name: "Alterar nome de exibição de vendas@exemplo.com.br" }));
    const dialog = screen.getByRole("dialog");
    const field = within(dialog).getByLabelText("Nome de exibição (opcional)");
    expect(field).toHaveValue("Loja Exemplo - Vendas");
    expect(dialog).toHaveTextContent(/a senha, o 2FA, as senhas de app, os apelidos e as mensagens da caixa ficam como estão/);
    // sem mudar nada, Salvar fica desabilitado
    expect(within(dialog).getByRole("button", { name: /Salvar nome/ })).toBeDisabled();
    await user.clear(field);
    await user.type(field, "Vendas Exemplo");
    await user.click(within(dialog).getByRole("button", { name: /Salvar nome/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")).toMatchObject({
        url: "/api/mail/mailboxes/vendas%40exemplo.com.br/display-name",
        body: { displayName: "Vendas Exemplo" },
      }),
    );
    expect(calls.find((c) => c.method === "PUT")!.body).not.toHaveProperty("projectId");
    expect(await screen.findByText("Nome de exibição de vendas@exemplo.com.br alterado.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("Nome de exibição: Vendas Exemplo")).toBeInTheDocument();
  });

  it("limpar o campo remove o nome", async () => {
    const calls = mockApi({ mailboxes: [USER_BOX] });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("vendas@exemplo.com.br");
    await user.click(within(rowOf("vendas@exemplo.com.br")).getByRole("button", { name: /Alterar nome de exibição/ }));
    await user.clear(within(screen.getByRole("dialog")).getByLabelText("Nome de exibição (opcional)"));
    await user.click(screen.getByRole("button", { name: /Salvar nome/ }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ displayName: "" }));
    expect(await screen.findByText("Nome de exibição de vendas@exemplo.com.br removido.")).toBeInTheDocument();
    expect(await screen.findByTestId("display-name-vendas@exemplo.com.br")).toHaveTextContent("Sem nome de exibição");
  });

  it("aba do projeto: manda o projectId (o servidor só aceita caixa do projeto)", async () => {
    const calls = mockApi({ mailboxes: [{ ...PROJECT_BOX, displayName: "Loja" }] });
    const user = userEvent.setup();
    renderPanel({ projectId: "p1" });
    await screen.findByText("loja@exemplo.com.br");
    await user.click(screen.getByRole("button", { name: /Alterar nome de exibição de loja@/ }));
    const dialog = screen.getByRole("dialog");
    // caixa de envio do projeto: avisa que vale no próximo deploy
    expect(dialog).toHaveTextContent(/MAIL_FROM_NAME/);
    expect(dialog).toHaveTextContent(/próximo deploy/);
    await user.type(within(dialog).getByLabelText("Nome de exibição (opcional)"), " Royal");
    await user.click(within(dialog).getByRole("button", { name: /Salvar nome/ }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ displayName: "Loja Royal", projectId: "p1" }));
  });

  it("caixa de envio: depois de salvar, o aviso manda fazer um novo deploy", async () => {
    mockApi({ mailboxes: [PROJECT_BOX], putExtra: { projectEmail: { projectId: "p1", appliesOnNextDeploy: true } } });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("loja@exemplo.com.br");
    await user.click(screen.getByRole("button", { name: /Alterar nome de exibição de loja@/ }));
    await user.type(dialogField(), "Loja Royal");
    await user.click(screen.getByRole("button", { name: /Salvar nome/ }));
    expect(await screen.findByText(/Faça um novo deploy do projeto/)).toBeInTheDocument();
  });

  it("erro do servidor: mostra a mensagem num alerta e mantém o modal aberto com o texto digitado", async () => {
    mockApi({ mailboxes: [USER_BOX], putStatus: 403 });
    const user = userEvent.setup();
    renderPanel({ projectId: "p1" });
    await screen.findByText("vendas@exemplo.com.br");
    await user.click(screen.getByRole("button", { name: /Alterar nome de exibição de vendas@/ }));
    const field = dialogField();
    await user.type(field, " X");
    await user.click(screen.getByRole("button", { name: /Salvar nome/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A caixa não é deste projeto.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(field).toHaveValue("Loja Exemplo - Vendas X");
  });

  it("carregando: o botão fica desabilitado e o campo travado até a resposta", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    mockApi({ mailboxes: [USER_BOX], holdPut: hold });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("vendas@exemplo.com.br");
    await user.click(screen.getByRole("button", { name: /Alterar nome de exibição de vendas@/ }));
    await user.type(dialogField(), " 2");
    await user.click(screen.getByRole("button", { name: /Salvar nome/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Salvar nome/ })).toBeDisabled());
    expect(dialogField()).toBeDisabled();
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("nome inválido no modal: Salvar desabilitado; Cancelar fecha sem chamar o servidor", async () => {
    const calls = mockApi({ mailboxes: [USER_BOX] });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("vendas@exemplo.com.br");
    await user.click(screen.getByRole("button", { name: /Alterar nome de exibição de vendas@/ }));
    const field = dialogField();
    fireEvent.change(field, { target: { value: "a<b" } });
    expect(screen.getByRole("button", { name: /Salvar nome/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
});

describe("i18n", () => {
  it("em inglês não sobra chave crua nem texto em português no campo, na lista e no modal", async () => {
    setLocale("en", { persist: false });
    mockApi({ mailboxes: [USER_BOX, NO_NAME_BOX] });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("vendas@exemplo.com.br");
    expect(screen.getByLabelText("Display name (optional)")).toHaveAttribute("placeholder", "E.g. Example Store - Support");
    expect(screen.getByTestId("display-name-contato@exemplo.com.br")).toHaveTextContent("No display name");
    expect(screen.getByTestId("display-name-vendas@exemplo.com.br")).toHaveTextContent("Display name: Loja Exemplo - Vendas");
    await user.click(screen.getByRole("button", { name: "Change display name of vendas@exemplo.com.br" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(/Only the name changes/);
    expect(document.body.textContent).not.toMatch(/mail\.(boxes|displayName)\./);
  });

  it("em português não sobra chave crua", async () => {
    mockApi({ mailboxes: [USER_BOX] });
    renderPanel();
    await screen.findByText("vendas@exemplo.com.br");
    expect(document.body.textContent).not.toMatch(/mail\.(boxes|displayName)\./);
  });
});
