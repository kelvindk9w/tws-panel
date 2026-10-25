/**
 * api-access-settings.test.tsx — Configurações → Acesso por IA: criar, copiar
 * (o valor aparece UMA vez), listar e revogar tokens de API. API simulada com
 * estado; o token nunca volta numa listagem.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiTokenInfo } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { setLocale } from "@/i18n/core";
import { SETTINGS_SECTIONS } from "@/pages/settings/SettingsLayout";
import { ApiAccessSettings } from "@/pages/settings/ApiAccessSettings";

const SECRET = "tws_pat_" + "Q".repeat(43);
let tokens: ApiTokenInfo[];
let twoFactor: boolean;
let failures: Record<string, ApiRequestError>;
let bodies: Array<Record<string, unknown>>;
let projectList: Array<[string, string]>;
let patches: Array<{ id: string; projects: string[]; canCreate: boolean; currentPassword?: string; code?: string }>;
let clipboard: string[];

function info(over: Partial<ApiTokenInfo> = {}): ApiTokenInfo {
  return {
    id: "0123456789abcdef",
    name: "assistente",
    scope: "read",
    reach: "panel",
    projects: [],
    canCreate: false,
    createdAt: "2026-10-22T12:00:00.000Z",
    expiresAt: "2026-11-21T12:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
    status: "active",
    ...over,
  };
}

beforeEach(() => {
  tokens = [];
  twoFactor = false;
  failures = {};
  bodies = [];
  patches = [];
  projectList = [["aaaa1111aaaa1111", "Fazenda"], ["bbbb2222bbbb2222", "Loja"]];
  clipboard = [];
  Object.defineProperty(navigator, "clipboard", { value: { writeText: (t: string) => (clipboard.push(t), Promise.resolve()) }, configurable: true });
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${path.replace(/\/[0-9a-f]{16}$/, "/:id")}`;
    if (failures[key]) throw failures[key];
    if (key === "GET /api/settings/api-tokens") return { tokens, maxActive: 20 };
    if (key === "GET /api/auth/2fa") return { enabled: twoFactor, recoveryCodesLeft: 0 };
    if (key === "GET /api/projects") return { projects: projectList.map(([id, name]) => ({ project: { id, name } })) };
    if (key === "PATCH /api/settings/api-tokens/:id") {
      const body = JSON.parse(String(init?.body)) as { projects: string[]; canCreate: boolean; currentPassword?: string; code?: string };
      patches.push({ id: path.split("/").pop()!, ...body });
      tokens = tokens.map((t) => (t.id === path.split("/").pop() ? { ...t, projects: body.projects, canCreate: body.canCreate } : t));
      return { info: tokens.find((t) => t.id === path.split("/").pop()) };
    }
    if (key === "POST /api/settings/api-tokens") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const made = info({
        id: "aaaaaaaaaaaaaaaa",
        name: String(body.name),
        scope: body.scope as ApiTokenInfo["scope"],
        reach: (body.reach as ApiTokenInfo["reach"]) ?? "panel",
        projects: (body.projects as string[]) ?? [],
        canCreate: body.canCreate === true,
      });
      tokens = [made, ...tokens];
      return { token: SECRET, info: made };
    }
    if (key === "DELETE /api/settings/api-tokens/:id") {
      tokens = tokens.map((t) => (t.id === path.split("/").pop() ? { ...t, status: "revoked", revokedAt: "2026-10-22T13:00:00.000Z" } : t));
      return { ok: true };
    }
    throw new Error(`rota inesperada: ${key}`);
  });
});

afterEach(cleanup);

function renderPage() {
  return render(
    <MemoryRouter>
      <ApiAccessSettings />
    </MemoryRouter>,
  );
}

async function fill(name = "meu-assistente", password = "MinhaSenha123") {
  fireEvent.change(await screen.findByLabelText("Nome"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("Sua senha atual"), { target: { value: password } });
}

describe("Configurações → Acesso por IA", () => {
  it("aparece no menu de Configurações", () => {
    expect(SETTINGS_SECTIONS.some((s) => s.to === "/settings/api-access" && s.label === "Acesso por IA")).toBe(true);
  });

  it("lista vazia: mensagem e contagem; avisa o que um token nunca faz", async () => {
    renderPage();
    expect(await screen.findByText("Nenhum token criado ainda.")).toBeInTheDocument();
    expect(screen.getByText("0 de 20 tokens ativos")).toBeInTheDocument();
    expect(screen.getByText(/não abre o terminal/)).toBeInTheDocument();
  });

  it("criar: mostra o token UMA vez com aviso e botão copiar; fechar apaga o valor da tela", async () => {
    renderPage();
    await fill();
    fireEvent.click(screen.getByLabelText(/Administração/));
    fireEvent.change(screen.getByLabelText("Validade"), { target: { value: "24" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar token" }));

    const panel = await screen.findByTestId("api-token-created");
    expect(within(panel).getByText(/único momento em que o token aparece/)).toBeInTheDocument();
    expect(within(panel).getByLabelText(/Token de acesso/)).toHaveValue(SECRET);
    expect(bodies[0]).toMatchObject({ name: "meu-assistente", scope: "admin", expiresInHours: 24, currentPassword: "MinhaSenha123" });
    expect(bodies[0]).not.toHaveProperty("code");

    fireEvent.click(within(panel).getByRole("button", { name: /Copiar/ }));
    await waitFor(() => expect(clipboard).toEqual([SECRET]));

    // o formulário limpa a senha e o nome; a lista traz o novo token, sem valor
    expect(screen.getByLabelText("Sua senha atual")).toHaveValue("");
    const list = await screen.findByTestId("api-token-list");
    expect(within(list).getByText("meu-assistente")).toBeInTheDocument();
    expect(list.textContent).not.toContain(SECRET);

    fireEvent.click(within(panel).getByRole("button", { name: "Já copiei, fechar" }));
    expect(screen.queryByTestId("api-token-created")).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("validade padrão: 30 dias", async () => {
    renderPage();
    await fill();
    fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
    await screen.findByTestId("api-token-created");
    expect(bodies[0]!.expiresInHours).toBe(720);
    expect(bodies[0]!.scope).toBe("read");
  });

  it("nome inválido ou senha vazia: o botão fica desligado", async () => {
    renderPage();
    const submit = await screen.findByRole("button", { name: "Criar token" });
    expect(submit).toBeDisabled();
    await fill("<script>", "x");
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "ok" } });
    expect(submit).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Sua senha atual"), { target: { value: "" } });
    expect(submit).toBeDisabled();
  });

  it("com a verificação em duas etapas ativa pede o código e o envia", async () => {
    twoFactor = true;
    renderPage();
    await fill();
    const submit = screen.getByRole("button", { name: "Criar token" });
    expect(await screen.findByLabelText("Código do app autenticador")).toBeInTheDocument();
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Código do app autenticador"), { target: { value: " 123456 " } });
    fireEvent.click(submit);
    await screen.findByTestId("api-token-created");
    expect(bodies[0]!.code).toBe("123456");
  });

  it("consulta do 2FA falhou: o campo do código aparece com aviso e 'Tentar de novo'; o código vai junto", async () => {
    failures["GET /api/auth/2fa"] = new ApiRequestError(500, "internal_error", "falhou");
    twoFactor = true;
    renderPage();
    await fill();
    expect(await screen.findByLabelText("Código do app autenticador")).toBeInTheDocument();
    expect(screen.getByText(/Não foi possível conferir se a verificação em duas etapas está ativa/)).toBeInTheDocument();
    // sem o status o botão não trava: o servidor decide se o código é exigido
    const submit = screen.getByRole("button", { name: "Criar token" });
    expect(submit).toBeEnabled();

    // tentar de novo: a consulta passa a dar certo e a mensagem normal volta
    delete failures["GET /api/auth/2fa"];
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText(/A verificação em duas etapas está ativa/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tentar de novo" })).toBeNull();
    expect(submit).toBeDisabled();
  });

  it("consulta do 2FA falhou e o código foi digitado: é enviado; sem código, não manda o campo", async () => {
    failures["GET /api/auth/2fa"] = new ApiRequestError(500, "internal_error", "falhou");
    renderPage();
    await fill();
    await screen.findByLabelText("Código do app autenticador");
    fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
    await screen.findByTestId("api-token-created");
    expect(bodies[0]).not.toHaveProperty("code");
    fireEvent.click(screen.getByRole("button", { name: "Já copiei, fechar" }));
    await fill("outro-token");
    fireEvent.change(screen.getByLabelText("Código do app autenticador"), { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]!.code).toBe("654321");
  });

  it("depois de criar, o foco vai para o aviso do segredo e ele é anunciado (role=status)", async () => {
    renderPage();
    await fill();
    fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
    const panel = await screen.findByTestId("api-token-created");
    expect(panel).toHaveAttribute("role", "status");
    await waitFor(() => expect(document.activeElement).toBe(panel));
    expect(within(panel).getByText(/Token meu-assistente criado\. Copie agora/)).toBeInTheDocument();
  });

  it("avisa sem rodeio que escrita e administração alcançam as variáveis dos projetos", async () => {
    renderPage();
    const caveat = await screen.findByTestId("api-token-caveat");
    expect(caveat).toHaveTextContent(/código que roda no projeto enxerga as variáveis/);
    expect(caveat).toHaveTextContent(/trate os escopos de escrita e de administração como acesso às variáveis/i);
    expect(screen.getByLabelText(/Escrita/)).toBeInTheDocument();
    expect(screen.getByText(/Um deploy roda o código do projeto com as variáveis dele/)).toBeInTheDocument();
  });

  it("sem a verificação em duas etapas não há campo de código", async () => {
    renderPage();
    await fill();
    expect(screen.queryByLabelText("Código do app autenticador")).toBeNull();
  });

  it("erro do servidor na criação aparece como alerta e não mostra token", async () => {
    failures["POST /api/settings/api-tokens"] = new ApiRequestError(401, "invalid_current_password", "A senha atual está incorreta.");
    renderPage();
    await fill();
    fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A senha atual está incorreta.");
    expect(screen.queryByTestId("api-token-created")).toBeNull();
  });

  it("lista: escopo, estado, validade e último uso; revogar pede confirmação e vale", async () => {
    tokens = [
      info({ id: "1111111111111111", name: "usado", scope: "write", lastUsedAt: "2026-10-22T12:30:00.000Z" }),
      info({ id: "2222222222222222", name: "vencido", status: "expired" }),
      info({ id: "3333333333333333", name: "antigo", status: "revoked", revokedAt: "2026-10-20T10:00:00.000Z" }),
    ];
    renderPage();
    const list = await screen.findByTestId("api-token-list");
    expect(screen.getByText("1 de 20 tokens ativos")).toBeInTheDocument();
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText("Escrita")).toBeInTheDocument();
    expect(within(items[0]!).getByText("Ativo")).toBeInTheDocument();
    expect(within(items[0]!).getByText(/Último uso:/)).toBeInTheDocument();
    expect(within(items[1]!).getByText("Vencido")).toBeInTheDocument();
    expect(within(items[1]!).getByText(/Venceu em/)).toBeInTheDocument();
    expect(within(items[1]!).queryByRole("button")).toBeNull();
    expect(within(items[2]!).getByText(/Revogado em/)).toBeInTheDocument();
    expect(within(items[2]!).getByText(/Nunca usado/)).toBeInTheDocument();

    fireEvent.click(within(items[0]!).getByRole("button", { name: "Revogar o token usado" }));
    // primeiro clique só pede confirmação; nada foi enviado
    expect(apiFetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
    fireEvent.click(within(items[0]!).getByRole("button", { name: "Cancelar" }));
    expect(within(items[0]!).getByRole("button", { name: "Revogar o token usado" })).toBeInTheDocument();
    fireEvent.click(within(items[0]!).getByRole("button", { name: "Revogar o token usado" }));
    fireEvent.click(within(items[0]!).getByRole("button", { name: "Confirmar revogação" }));
    await waitFor(() => expect(screen.getByText("0 de 20 tokens ativos")).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledWith("/api/settings/api-tokens/1111111111111111", { method: "DELETE" });
  });

  it("falha ao revogar mostra o erro e o token continua ativo", async () => {
    tokens = [info()];
    failures["DELETE /api/settings/api-tokens/:id"] = new ApiRequestError(500, "storage_write_failed", "Não foi possível salvar. O token continua valendo.");
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Revogar o token assistente" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar revogação" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("continua valendo");
    expect(screen.getByText("1 de 20 tokens ativos")).toBeInTheDocument();
  });

  it("falha ao carregar: alerta com a mensagem", async () => {
    failures["GET /api/settings/api-tokens"] = new ApiRequestError(503, "token_store_unavailable", "Não foi possível ler os tokens de API no servidor.");
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível ler os tokens");
  });

  it("falha ao consultar o 2FA não impede a tela (o servidor ainda exige o código)", async () => {
    failures["GET /api/auth/2fa"] = new ApiRequestError(500, "x", "x");
    renderPage();
    expect(await screen.findByText("Nenhum token criado ainda.")).toBeInTheDocument();
  });

  it("em inglês: textos traduzidos e erro pelo código", async () => {
    setLocale("en", { persist: false });
    failures["POST /api/settings/api-tokens"] = new ApiRequestError(409, "too_many_tokens", "Limite de 20 tokens ativos.");
    renderPage();
    expect(await screen.findByText("AI access (API tokens)")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "claude" } });
    fireEvent.change(screen.getByLabelText("Your current password"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Active token limit reached");
  });

  it("acessibilidade e 360 px: campos com rótulo, aviso em região nomeada, nada de largura fixa", async () => {
    renderPage();
    await fill();
    fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
    const panel = await screen.findByRole("status", { name: /Token criado/ });
    expect(panel.innerHTML).not.toMatch(/w-\[\d+px\]|min-w-\[\d+px\]/);
    const input = within(panel).getByLabelText(/Token de acesso/) as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(input.className).toContain("min-w-0");
    // 3 níveis + 3 alcances ("pode criar" só aparece com administração; "domínios" só sem ela)
    expect(screen.getAllByRole("radio")).toHaveLength(6);
    for (const radio of screen.getAllByRole("radio")) expect(radio).toHaveAccessibleName();
  });
});

describe("alcance do token", () => {
  const FAZENDA = "aaaa1111aaaa1111";
  const LOJA = "bbbb2222bbbb2222";

  it("padrão: painel inteiro, sem lista de projetos e sem enviar campos de alcance (igual à Fase 0)", async () => {
    renderPage();
    await fill();
    expect(screen.getByLabelText(/O painel inteiro/)).toBeChecked();
    expect(screen.queryByTestId("api-token-projects")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
    await screen.findByTestId("api-token-created");
    expect(bodies[0]).not.toHaveProperty("reach");
    expect(bodies[0]).not.toHaveProperty("projects");
  });

  it("só os projetos escolhidos: lista com os projetos; exige marcar ao menos um; envia reach, projects e canCreate=false", async () => {
    renderPage();
    await fill();
    fireEvent.click(screen.getByLabelText(/Só os projetos que eu escolher/));
    const picker = await screen.findByTestId("api-token-projects");
    await within(picker).findByLabelText("Fazenda");
    expect(within(picker).getByLabelText("Fazenda")).not.toBeChecked();
    expect(within(picker).getByLabelText("Loja")).not.toBeChecked();
    const submit = screen.getByRole("button", { name: "Criar token" });
    expect(submit).toBeDisabled();
    expect(within(picker).getByText("Marque ao menos um projeto.")).toBeInTheDocument();
    fireEvent.click(within(picker).getByLabelText("Fazenda"));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await screen.findByTestId("api-token-created");
    expect(bodies[0]).toMatchObject({ reach: "projects", projects: [FAZENDA], canCreate: false });
    // depois de criar, o formulário volta ao padrão (nada de herdar alcance no token seguinte)
    expect(screen.getByLabelText(/O painel inteiro/)).toBeChecked();
  });

  it("'pode criar' só aparece com o nível de administração; sair da administração desfaz a escolha", async () => {
    renderPage();
    await fill();
    expect(screen.queryByLabelText(/pode criar projetos novos/)).toBeNull();
    fireEvent.click(screen.getByLabelText(/Administração/));
    fireEvent.click(screen.getByLabelText(/pode criar projetos novos/));
    expect(screen.getByLabelText(/pode criar projetos novos/)).toBeChecked();
    fireEvent.click(screen.getByLabelText(/Escrita/));
    expect(screen.queryByLabelText(/pode criar projetos novos/)).toBeNull();
    expect(screen.getByLabelText(/Só os projetos que eu escolher/)).toBeChecked();
  });

  it("projetos + criar: pode ficar sem projeto marcado; envia canCreate=true", async () => {
    renderPage();
    await fill();
    fireEvent.click(screen.getByLabelText(/Administração/));
    fireEvent.click(screen.getByLabelText(/pode criar projetos novos/));
    expect(screen.getByRole("button", { name: "Criar token" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
    await screen.findByTestId("api-token-created");
    expect(bodies[0]).toMatchObject({ reach: "projects", projects: [], canCreate: true });
  });

  it("desmarcar tira o projeto da lista enviada", async () => {
    renderPage();
    await fill();
    fireEvent.click(screen.getByLabelText(/Só os projetos que eu escolher/));
    const picker = await screen.findByTestId("api-token-projects");
    await within(picker).findByLabelText("Fazenda");
    fireEvent.click(within(picker).getByLabelText("Fazenda"));
    fireEvent.click(within(picker).getByLabelText("Loja"));
    fireEvent.click(within(picker).getByLabelText("Fazenda"));
    fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
    await screen.findByTestId("api-token-created");
    expect(bodies[0]!.projects).toEqual([LOJA]);
  });

  it("sem projetos ainda: explica o que fazer", async () => {
    projectList = [];
    renderPage();
    await fill();
    fireEvent.click(screen.getByLabelText(/Só os projetos que eu escolher/));
    expect(await screen.findByText(/Você ainda não tem projetos/)).toBeInTheDocument();
  });

  it("falha ao carregar os projetos: alerta no lugar da lista, a tela continua", async () => {
    failures["GET /api/projects"] = new ApiRequestError(500, "internal_error", "falhou");
    renderPage();
    await fill();
    fireEvent.click(screen.getByLabelText(/Só os projetos que eu escolher/));
    expect(await screen.findByText("falhou")).toBeInTheDocument();
  });

  it("a lista mostra o alcance de cada token (nomes dos projetos, 'pode criar', painel inteiro, nenhum)", async () => {
    tokens = [
      info({ id: "1111111111111111", name: "amplo" }),
      info({ id: "2222222222222222", name: "fazenda", reach: "projects", projects: [FAZENDA] }),
      info({ id: "3333333333333333", name: "criador", reach: "projects", projects: [FAZENDA, LOJA], canCreate: true }),
      info({ id: "4444444444444444", name: "vazio", reach: "projects", projects: [], canCreate: true }),
      info({ id: "5555555555555555", name: "sem-nada", reach: "projects", projects: [] }),
    ];
    renderPage();
    const list = await screen.findByTestId("api-token-list");
    await waitFor(() => expect(within(list).getAllByTestId("api-token-reach-line")[1]).toHaveTextContent("Alcance: só Fazenda"));
    const lines = within(list).getAllByTestId("api-token-reach-line").map((l) => l.textContent);
    expect(lines).toEqual([
      "Alcance: o painel inteiro",
      "Alcance: só Fazenda",
      "Alcance: só Fazenda, Loja · pode criar projetos novos",
      "Alcance: nenhum projeto no momento · pode criar projetos novos",
      "Alcance: nenhum projeto no momento",
    ]);
    // só token ativo de projetos tem "Editar projetos"
    expect(screen.queryByRole("button", { name: "Editar os projetos do token amplo" })).toBeNull();
    expect(screen.getByRole("button", { name: "Editar os projetos do token fazenda" })).toBeInTheDocument();
  });

  it("editar: reduzir não pede senha e vale na hora", async () => {
    tokens = [info({ id: "3333333333333333", name: "criador", scope: "admin", reach: "projects", projects: [FAZENDA, LOJA], canCreate: true })];
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Editar os projetos do token criador" }));
    const editor = await screen.findByTestId("api-token-edit");
    await within(editor).findByLabelText("Loja");
    expect(within(editor).getByText(/Diminuir o alcance não pede senha/)).toBeInTheDocument();
    fireEvent.click(within(editor).getByLabelText("Loja"));
    fireEvent.click(within(editor).getByLabelText(/Pode criar projetos novos/));
    fireEvent.click(within(editor).getByRole("button", { name: "Salvar alcance" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ id: "3333333333333333", projects: [FAZENDA], canCreate: false, basedOn: [FAZENDA, LOJA] });
    await waitFor(() => expect(screen.queryByTestId("api-token-edit")).toBeNull());
    expect((await screen.findAllByTestId("api-token-reach-line"))[0]).toHaveTextContent("Alcance: só Fazenda");
  });

  it("editar: aumentar pede a senha (e o código com 2FA) e só então libera salvar", async () => {
    twoFactor = true;
    tokens = [info({ id: "2222222222222222", name: "fazenda", reach: "projects", projects: [FAZENDA] })];
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Editar os projetos do token fazenda" }));
    const editor = await screen.findByTestId("api-token-edit");
    await within(editor).findByLabelText("Loja");
    const save = within(editor).getByRole("button", { name: "Salvar alcance" });
    fireEvent.click(within(editor).getByLabelText("Loja"));
    expect(within(editor).getByText(/Você está aumentando o alcance/)).toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.change(within(editor).getByLabelText("Sua senha atual"), { target: { value: "MinhaSenha123" } });
    expect(save).toBeDisabled();
    fireEvent.change(within(editor).getByLabelText("Código do app autenticador"), { target: { value: " 123456 " } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ id: "2222222222222222", projects: [FAZENDA, LOJA], canCreate: false, basedOn: [FAZENDA], currentPassword: "MinhaSenha123", code: "123456" });
  });

  it("editar: ligar 'pode criar' também é aumentar; esvaziar a lista sem 'pode criar' é recusado na tela", async () => {
    tokens = [info({ id: "2222222222222222", name: "fazenda", scope: "admin", reach: "projects", projects: [FAZENDA] })];
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Editar os projetos do token fazenda" }));
    const editor = await screen.findByTestId("api-token-edit");
    await within(editor).findByLabelText("Fazenda");
    fireEvent.click(within(editor).getByLabelText(/Pode criar projetos novos/));
    expect(within(editor).getByLabelText("Sua senha atual")).toBeInTheDocument();
    fireEvent.click(within(editor).getByLabelText(/Pode criar projetos novos/));
    fireEvent.click(within(editor).getByLabelText("Fazenda"));
    expect(within(editor).getByText(/Deixe ao menos um projeto marcado/)).toBeInTheDocument();
    expect(within(editor).getByRole("button", { name: "Salvar alcance" })).toBeDisabled();
    fireEvent.click(within(editor).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByTestId("api-token-edit")).toBeNull();
  });

  it("editar: erro do servidor aparece e o editor continua aberto", async () => {
    failures["PATCH /api/settings/api-tokens/:id"] = new ApiRequestError(401, "invalid_current_password", "A senha atual está incorreta.");
    tokens = [info({ id: "2222222222222222", name: "fazenda", reach: "projects", projects: [FAZENDA] })];
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Editar os projetos do token fazenda" }));
    const editor = await screen.findByTestId("api-token-edit");
    await within(editor).findByLabelText("Loja");
    fireEvent.click(within(editor).getByLabelText("Loja"));
    fireEvent.change(within(editor).getByLabelText("Sua senha atual"), { target: { value: "x" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Salvar alcance" }));
    expect(await within(editor).findByRole("alert")).toHaveTextContent("A senha atual está incorreta.");
    expect(screen.getByTestId("api-token-edit")).toBeInTheDocument();
  });

  it("editar: token sem administração não oferece 'pode criar'", async () => {
    tokens = [info({ id: "2222222222222222", name: "fazenda", scope: "write", reach: "projects", projects: [FAZENDA] })];
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Editar os projetos do token fazenda" }));
    const editor = await screen.findByTestId("api-token-edit");
    await within(editor).findByLabelText("Loja");
    expect(within(editor).queryByLabelText(/Pode criar projetos novos/)).toBeNull();
  });

  it("editar: a lista mudou durante a edição (409): recarrega, marca o projeto novo e o editor continua aberto", async () => {
    tokens = [info({ id: "2222222222222222", name: "fazenda", scope: "admin", reach: "projects", projects: [FAZENDA], canCreate: true })];
    projectList.push(["cccc3333cccc3333", "Horta"]);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Editar os projetos do token fazenda" }));
    const editor = await screen.findByTestId("api-token-edit");
    await within(editor).findByLabelText("Loja");
    fireEvent.click(within(editor).getByLabelText("Loja"));
    fireEvent.change(within(editor).getByLabelText("Sua senha atual"), { target: { value: "MinhaSenha123" } });
    // o token criou outro projeto enquanto isso
    tokens = tokens.map((t) => ({ ...t, projects: [FAZENDA, "cccc3333cccc3333"] }));
    failures["PATCH /api/settings/api-tokens/:id"] = new ApiRequestError(409, "token_reach_changed", "A lista mudou.");
    fireEvent.click(within(editor).getByRole("button", { name: "Salvar alcance" }));
    expect(await within(editor).findByRole("alert")).toHaveTextContent("A lista mudou.");
    expect(screen.getByTestId("api-token-edit")).toBeInTheDocument();
    await waitFor(() => expect(within(editor).getByLabelText("Horta")).toBeChecked());
    delete failures["PATCH /api/settings/api-tokens/:id"];
    fireEvent.click(within(editor).getByRole("button", { name: "Salvar alcance" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({ projects: expect.arrayContaining([FAZENDA, LOJA, "cccc3333cccc3333"]), basedOn: [FAZENDA, "cccc3333cccc3333"] });
  });

  it("editar: 409 e a recarga também falha: o erro aparece e nada quebra", async () => {
    tokens = [info({ id: "2222222222222222", name: "fazenda", scope: "admin", reach: "projects", projects: [FAZENDA] })];
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Editar os projetos do token fazenda" }));
    const editor = await screen.findByTestId("api-token-edit");
    await within(editor).findByLabelText("Loja");
    fireEvent.click(within(editor).getByLabelText("Fazenda"));
    fireEvent.click(within(editor).getByLabelText("Loja"));
    fireEvent.change(within(editor).getByLabelText("Sua senha atual"), { target: { value: "x" } });
    failures["PATCH /api/settings/api-tokens/:id"] = new ApiRequestError(409, "token_reach_changed", "A lista mudou.");
    fireEvent.click(within(editor).getByRole("button", { name: "Salvar alcance" }));
    await within(editor).findByRole("alert");
    failures["GET /api/settings/api-tokens"] = new ApiRequestError(500, "internal_error", "x");
    fireEvent.click(within(editor).getByRole("button", { name: "Salvar alcance" }));
    expect(await within(editor).findByRole("alert")).toHaveTextContent("A lista mudou.");
  });

  it("em inglês: opções de alcance traduzidas", async () => {
    setLocale("en", { persist: false });
    renderPage();
    fireEvent.click(await screen.findByLabelText(/Admin/));
    expect(await screen.findByLabelText(/The whole panel/)).toBeChecked();
    expect(screen.getByLabelText(/Only the projects I choose/)).toBeInTheDocument();
    expect(screen.getByLabelText(/it can create new projects/)).toBeInTheDocument();
  });
});

describe("textos dos escopos coincidem com a regra do servidor e com o guia do site", async () => {
  const { readFileSync } = await import("node:fs");
  const ptBR = (await import("../src/locales/pt-BR/settings")).default as Record<string, string>;
  const en = (await import("../src/locales/en/settings")).default as Record<string, string>;
  const guide = (lang: string) => readFileSync(`${import.meta.dirname}/../../../site/src/content/docs/${lang}/guides/ai-access.md`, "utf8");

  it("Escrita não promete domínios, portas nem repositório; Administração os cobre (pt-BR e en)", () => {
    const write = { pt: ptBR["apiAccess.scope.write.desc"]!, en: en["apiAccess.scope.write.desc"]! };
    const admin = { pt: ptBR["apiAccess.scope.admin.desc"]!, en: en["apiAccess.scope.admin.desc"]! };
    // a frase de escrita só cita domínios/portas para dizer que NÃO mexe neles
    expect(write.pt).toMatch(/Não troca repositório, domínios nem portas/);
    expect(write.en).toMatch(/Cannot change repositories, domains or ports/);
    expect(write.pt.replace(/Não troca repositório, domínios nem portas\./, "")).not.toMatch(/domínios|portas/);
    expect(write.en.replace(/Cannot change repositories, domains or ports\./, "")).not.toMatch(/domains|ports/);
    expect(admin.pt).toMatch(/domínios e portas/);
    expect(admin.pt).toMatch(/repositório/);
    expect(admin.en).toMatch(/domains and ports/);
    expect(admin.en).toMatch(/repository/);
  });

  it("o guia do site diz o mesmo da Escrita (pt-br e en)", () => {
    expect(guide("pt-br")).toMatch(/\*\*Escrita\*\*[^\n]*Não troca repositório, domínios nem portas/);
    expect(guide("en")).toMatch(/\*\*Write\*\*[^\n]*Cannot change repositories, domains or ports/);
  });
});

describe("Acesso por IA — token de domínios do projeto", () => {
  const FAZENDA = "aaaa1111aaaa1111";

  it("só os domínios dos projetos escolhidos: exige marcar um projeto, envia reach=domains sem 'pode criar' e não existe com administração", async () => {
    renderPage();
    await fill();
    fireEvent.click(screen.getByLabelText(/Só os domínios dos projetos que eu escolher/));
    const picker = await screen.findByTestId("api-token-projects");
    await within(picker).findByLabelText("Fazenda");
    expect(screen.getByRole("button", { name: "Criar token" })).toBeDisabled();
    expect(within(picker).getByText("Marque ao menos um projeto.")).toBeInTheDocument();
    // com administração a opção some e a escolha volta para "projetos"
    fireEvent.click(screen.getByLabelText(/Administração/));
    expect(screen.queryByLabelText(/Só os domínios dos projetos que eu escolher/)).toBeNull();
    expect(screen.getByLabelText(/Só os projetos que eu escolher/)).toBeChecked();
    fireEvent.click(screen.getByLabelText(/Escrita/));
    fireEvent.click(screen.getByLabelText(/Só os domínios dos projetos que eu escolher/));
    fireEvent.click(within(await screen.findByTestId("api-token-projects")).getByLabelText("Fazenda"));
    expect(screen.getByRole("button", { name: "Criar token" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
    await screen.findByTestId("api-token-created");
    expect(bodies[0]).toMatchObject({ scope: "write", reach: "domains", projects: [FAZENDA], canCreate: false });
  });

  it("a lista mostra o alcance 'só os domínios de' e oferece editar a lista de projetos", async () => {
    tokens = [info({ reach: "domains", projects: [FAZENDA], scope: "write", name: "app-do-cliente" })];
    renderPage();
    expect(await screen.findByTestId("api-token-reach-line")).toHaveTextContent("Alcance: só os domínios de Fazenda");
    expect(screen.getByRole("button", { name: /Editar/ })).toBeInTheDocument();
  });
});
