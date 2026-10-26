/**
 * mcp-access.test.tsx — Configurações → Acesso por IA, parte do MCP: liga/desliga (desligado por padrão),
 * pedidos de aprovação, opções por token (criar e editar) e validade ilimitada. API simulada com estado.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiTokenInfo, McpApprovalInfo } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { setLocale } from "@/i18n/core";
import { ApiAccessSettings } from "@/pages/settings/ApiAccessSettings";

const SECRET = "tws_pat_" + "Q".repeat(43);
let enabled: boolean;
let twoFactor: boolean;
let tokens: ApiTokenInfo[];
let approvals: McpApprovalInfo[];
let failures: Record<string, ApiRequestError>;
let calls: Array<{ key: string; body: Record<string, unknown> }>;

function info(over: Partial<ApiTokenInfo> = {}): ApiTokenInfo {
  return {
    id: "0123456789abcdef",
    name: "assistente",
    scope: "write",
    reach: "panel",
    projects: [],
    canCreate: false,
    hostMetrics: false,
    mcp: { securityApply: false, secretsRead: false, skipApproval: false, metrics: false },
    neverExpires: false,
    createdAt: "2026-10-22T12:00:00.000Z",
    expiresAt: "2026-11-21T12:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
    status: "active",
    ...over,
  };
}

function approval(over: Partial<McpApprovalInfo> = {}): McpApprovalInfo {
  return {
    id: "ap1",
    tool: "recreate_project",
    args: { project: "Fazenda" },
    tokenId: "0123456789abcdef",
    tokenName: "assistente",
    client: "claude-code",
    status: "pending",
    createdAt: "2026-10-26T12:00:00.000Z",
    expiresAt: "2026-10-26T12:10:00.000Z",
    ...over,
  } as McpApprovalInfo;
}

beforeEach(() => {
  enabled = false;
  twoFactor = false;
  tokens = [];
  approvals = [];
  failures = {};
  calls = [];
  setLocale("pt-BR");
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${path.replace(/\/[0-9a-f]{16}(\/mcp)?$/, (_m, m) => `/:id${m ?? ""}`).replace(/\/approvals\/[a-z0-9]+\//, "/approvals/:id/")}`;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ key, body });
    if (failures[key]) throw failures[key];
    if (key === "GET /api/settings/mcp") return { enabled, path: "/mcp" };
    if (key === "PUT /api/settings/mcp") {
      enabled = body.enabled === true;
      return { enabled, path: "/mcp" };
    }
    if (key === "GET /api/mcp/approvals") return { approvals };
    if (key === "POST /api/mcp/approvals/:id/approve" || key === "POST /api/mcp/approvals/:id/reject") {
      approvals = approvals.map((a) => ({ ...a, status: key.endsWith("approve") ? "approved" : "rejected" }));
      return { ok: true };
    }
    if (key === "GET /api/auth/2fa") return { enabled: twoFactor, recoveryCodesLeft: 0 };
    if (key === "GET /api/projects") return { projects: [] };
    if (key === "GET /api/settings/api-tokens") return { tokens, maxActive: 20 };
    if (key === "POST /api/settings/api-tokens") {
      const made = info({ id: "aaaaaaaaaaaaaaaa", name: String(body.name), neverExpires: body.neverExpires === true, mcp: { securityApply: false, secretsRead: false, skipApproval: false, metrics: false, ...(body.mcp as object) } });
      tokens = [made, ...tokens];
      return { token: SECRET, info: made };
    }
    if (key === "PATCH /api/settings/api-tokens/:id/mcp") {
      tokens = tokens.map((t) => ({ ...t, mcp: { ...t.mcp, ...(body.mcp as object) } }));
      return { info: tokens[0] };
    }
    throw new Error(`rota inesperada: ${key}`);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderPage() {
  return render(
    <MemoryRouter>
      <ApiAccessSettings />
    </MemoryRouter>,
  );
}

describe("MCP: liga e desliga", () => {
  it("vem desligado, com aviso, e ligar pede a senha", async () => {
    renderPage();
    const form = await screen.findByTestId("mcp-enable-form");
    expect(within(screen.getByTestId("mcp-access")).getByText("Desligado")).toBeInTheDocument();
    expect(within(form).getByText(/abre o endereço do MCP na internet/)).toBeInTheDocument();
    const button = within(form).getByRole("button", { name: /Ligar o acesso por IA/ });
    expect(button).toBeDisabled();
    fireEvent.change(within(form).getByLabelText("Senha para ligar o acesso por IA"), { target: { value: "MinhaSenha123" } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(await screen.findByText("Ligado")).toBeInTheDocument();
    const put = calls.find((c) => c.key === "PUT /api/settings/mcp")!;
    expect(put.body).toEqual({ enabled: true, currentPassword: "MinhaSenha123" });
    expect(screen.getByLabelText("Endereço do MCP")).toHaveValue(`${window.location.origin}/mcp`);
    expect(screen.getByTestId("mcp-connect-example").textContent).toContain("claude mcp add --transport http");
    expect(screen.getByText("Nenhum pedido agora.")).toBeInTheDocument();
  });

  it("com 2FA o código também é exigido e enviado", async () => {
    twoFactor = true;
    renderPage();
    const form = await screen.findByTestId("mcp-enable-form");
    fireEvent.change(within(form).getByLabelText("Senha para ligar o acesso por IA"), { target: { value: "MinhaSenha123" } });
    const button = within(form).getByRole("button", { name: /Ligar o acesso por IA/ });
    await waitFor(() => expect(within(form).getByLabelText("Código de 6 dígitos para ligar o acesso por IA")).toBeInTheDocument());
    expect(button).toBeDisabled();
    fireEvent.change(within(form).getByLabelText("Código de 6 dígitos para ligar o acesso por IA"), { target: { value: " 123456 " } });
    fireEvent.click(button);
    await screen.findByText("Ligado");
    expect(calls.find((c) => c.key === "PUT /api/settings/mcp")!.body).toEqual({ enabled: true, currentPassword: "MinhaSenha123", code: "123456" });
  });

  it("desligar não pede senha; erro ao ligar aparece como alerta", async () => {
    enabled = true;
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Desligar o acesso por IA" }));
    expect(await screen.findByText("Desligado")).toBeInTheDocument();
    expect(calls.find((c) => c.key === "PUT /api/settings/mcp")!.body).toEqual({ enabled: false });
    failures["PUT /api/settings/mcp"] = new ApiRequestError(401, "invalid_password", "Senha incorreta.");
    const form = await screen.findByTestId("mcp-enable-form");
    fireEvent.change(within(form).getByLabelText("Senha para ligar o acesso por IA"), { target: { value: "errada" } });
    fireEvent.click(within(form).getByRole("button", { name: /Ligar o acesso por IA/ }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("falha ao ler o estado mostra o erro e nada de formulário", async () => {
    failures["GET /api/settings/mcp"] = new ApiRequestError(500, "internal", "");
    renderPage();
    expect(await screen.findByText("Não foi possível ler o estado do acesso por IA.")).toBeInTheDocument();
    expect(screen.queryByTestId("mcp-enable-form")).toBeNull();
  });

  it("em inglês os textos mudam", async () => {
    setLocale("en");
    renderPage();
    expect(await screen.findByText("AI access (MCP)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Turn on AI access/ })).toBeInTheDocument();
  });
});

describe("MCP: pedidos de aprovação", () => {
  beforeEach(() => {
    enabled = true;
    approvals = [approval(), approval({ id: "ap2", tool: "security_apply", status: "used", client: "outro" }), approval({ id: "ap3", tool: "x_desconhecida", status: "rejected" })];
  });

  it("lista pendentes e decididos; aprovar pede senha (e código com 2FA)", async () => {
    twoFactor = true;
    renderPage();
    const pending = await screen.findByTestId("mcp-approval-pending");
    // o nome do TOKEN em destaque; o nome do programa vem marcado como informado pela própria IA
    expect(within(pending).getByTestId("mcp-approval-token")).toHaveTextContent("assistente");
    expect(within(pending).getByText(/pede: recriar os containers do projeto/)).toBeInTheDocument();
    expect(within(pending).getByTestId("mcp-approval-client")).toHaveTextContent("Programa que a IA diz usar (informado por ela, sem garantia): claude-code");
    expect(within(pending).getByText("Projeto")).toBeInTheDocument();
    expect(within(pending).getByText("Fazenda")).toBeInTheDocument();
    expect(screen.getByText("1 esperando")).toBeInTheDocument();
    expect(within(screen.getByTestId("mcp-approvals-decided")).getByText("Executado")).toBeInTheDocument();
    fireEvent.click(within(pending).getByRole("button", { name: /^Aprovar/ }));
    const confirm = within(pending).getByRole("button", { name: /Confirmar a aprovação/ });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(pending).getByLabelText("Sua senha atual"), { target: { value: "MinhaSenha123" } });
    await waitFor(() => expect(within(pending).getByLabelText(/Código/)).toBeInTheDocument());
    fireEvent.change(within(pending).getByLabelText(/Código/), { target: { value: "654321" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(calls.some((c) => c.key === "POST /api/mcp/approvals/:id/approve")).toBe(true));
    expect(calls.find((c) => c.key === "POST /api/mcp/approvals/:id/approve")!.body).toEqual({ currentPassword: "MinhaSenha123", code: "654321" });
    await waitFor(() => expect(screen.queryByTestId("mcp-approval-pending")).toBeNull());
  });

  it("pedidos novos: variáveis só com nomes; campo desconhecido aparece como veio; em inglês, rótulos em inglês", async () => {
    approvals = [
      approval({ id: "ev", tool: "set_env_vars", args: { project: "Fazenda (aaaa)", variables: "NODE_OPTIONS (nova; nome que pode executar código)", values: "os valores não são mostrados", extra: "x" } }),
      approval({ id: "up", tool: "update_project", args: { project: "Fazenda (aaaa)", domain: "novo.example.com" } }),
    ];
    setLocale("en");
    renderPage();
    const pending = await screen.findAllByTestId("mcp-approval-pending");
    expect(pending).toHaveLength(2);
    expect(within(pending[0]!).getByText("Variables")).toBeInTheDocument();
    expect(within(pending[0]!).getByText("extra")).toBeInTheDocument();
    expect(within(pending[0]!).getByText(/NODE_OPTIONS/)).toBeInTheDocument();
    expect(within(pending[0]!).getByText(/write environment variables/)).toBeInTheDocument();
    expect(within(pending[1]!).getByText("Main domain")).toBeInTheDocument();
    expect(within(pending[1]!).getByText(/change a project's domain/)).toBeInTheDocument();
    expect(within(pending[1]!).getByTestId("mcp-approval-client")).toHaveTextContent("self-reported, no guarantee");
  });

  it("o valor novo das variáveis perigosas aparece inteiro, numa área com rolagem e focável pelo teclado", async () => {
    const valor = "--max-old-space-size=4096 ".repeat(8) + "--import=data:text/javascript,console.log(1)";
    approvals = [approval({ id: "ev", tool: "set_env_vars", args: { project: "Fazenda (aaaa)", variables: "NODE_OPTIONS (nova)", values: `NODE_OPTIONS = ${valor}` } })];
    renderPage();
    const area = await screen.findByTestId("mcp-approval-values");
    expect(area).toHaveTextContent(`NODE_OPTIONS = ${valor}`);
    expect(area.tagName).toBe("PRE");
    expect(area).toHaveAttribute("tabindex", "0");
    expect(area.className).toContain("overflow-auto");
    expect(area.className).toContain("font-mono");
  });

  it("cancelar a senha volta aos botões; recusar não pede senha", async () => {
    renderPage();
    const pending = await screen.findByTestId("mcp-approval-pending");
    fireEvent.click(within(pending).getByRole("button", { name: /^Aprovar/ }));
    fireEvent.click(within(pending).getByRole("button", { name: "Cancelar" }));
    expect(within(pending).getByRole("button", { name: /^Aprovar/ })).toBeInTheDocument();
    fireEvent.click(within(pending).getByRole("button", { name: /Recusar/ }));
    await waitFor(() => expect(calls.some((c) => c.key === "POST /api/mcp/approvals/:id/reject")).toBe(true));
    await waitFor(() => expect(screen.queryByTestId("mcp-approval-pending")).toBeNull());
  });

  it("erros de aprovar e recusar aparecem no próprio pedido; erro de lista fica no bloco", async () => {
    failures["POST /api/mcp/approvals/:id/approve"] = new ApiRequestError(409, "approval_not_pending", "Este pedido já foi decidido ou venceu.");
    failures["POST /api/mcp/approvals/:id/reject"] = new ApiRequestError(500, "internal", "");
    renderPage();
    const pending = await screen.findByTestId("mcp-approval-pending");
    fireEvent.click(within(pending).getByRole("button", { name: /Recusar/ }));
    expect(await within(pending).findByRole("alert")).toHaveTextContent("Não foi possível recusar o pedido.");
    fireEvent.click(within(pending).getByRole("button", { name: /^Aprovar/ }));
    fireEvent.change(within(pending).getByLabelText("Sua senha atual"), { target: { value: "x" } });
    fireEvent.click(within(pending).getByRole("button", { name: /Confirmar a aprovação/ }));
    await waitFor(() => expect(within(pending).getByRole("alert")).toHaveTextContent("já foi decidido"));
    failures["GET /api/mcp/approvals"] = new ApiRequestError(500, "internal", "");
    fireEvent.click(screen.getByRole("button", { name: "Atualizar a lista de pedidos" }));
    expect(await screen.findByText("Não foi possível carregar os pedidos.")).toBeInTheDocument();
  });

  it("a lista é consultada de novo sozinha", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    renderPage();
    await vi.waitFor(() => expect(calls.filter((c) => c.key === "GET /api/mcp/approvals").length).toBe(1));
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await vi.waitFor(() => expect(calls.filter((c) => c.key === "GET /api/mcp/approvals").length).toBe(2));
  });
});

describe("tokens: validade ilimitada e opções do MCP", () => {
  async function fillBasics() {
    fireEvent.change(await screen.findByLabelText("Nome"), { target: { value: "ia" } });
    fireEvent.change(screen.getByLabelText("Sua senha atual"), { target: { value: "MinhaSenha123" } });
  }

  it("ilimitado mostra o aviso e só libera o botão com a confirmação", async () => {
    renderPage();
    await fillBasics();
    fireEvent.change(screen.getByLabelText("Validade"), { target: { value: "never" } });
    expect(screen.getByTestId("api-token-never-warning")).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "Criar token" });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByTestId("api-token-never-ack"));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await screen.findByTestId("api-token-created");
    const post = calls.find((c) => c.key === "POST /api/settings/api-tokens")!;
    expect(post.body).toMatchObject({ neverExpires: true, confirmNeverExpires: true });
    expect(post.body).not.toHaveProperty("expiresInHours");
    expect(await screen.findByText(/^Sem vencimento · /)).toBeInTheDocument();
  });

  it("as opções do MCP vêm desligadas (nada é enviado) e ligar mostra o aviso e envia só o que ligou", async () => {
    renderPage();
    await fillBasics();
    expect(screen.queryByTestId("mcp-new-warning")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
    await screen.findByTestId("api-token-created");
    expect(calls.find((c) => c.key === "POST /api/settings/api-tokens")!.body).not.toHaveProperty("mcp");
    expect(await screen.findByText(/todas desligadas \(padrão seguro\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Já copiei, fechar" }));

    await fillBasics();
    fireEvent.click(screen.getByTestId("mcp-new-secretsRead"));
    expect(screen.getByTestId("mcp-new-warning")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
    await waitFor(() => expect(calls.filter((c) => c.key === "POST /api/settings/api-tokens")).toHaveLength(2));
    expect(calls.filter((c) => c.key === "POST /api/settings/api-tokens")[1]!.body.mcp).toMatchObject({ secretsRead: true, securityApply: false });
    expect(await screen.findByText(/Opções de IA ligadas: lê segredos/)).toBeInTheDocument();
  });

  it("editar: ligar pede senha; desligar vale na hora; cancelar fecha", async () => {
    tokens = [info({ mcp: { securityApply: false, secretsRead: true, skipApproval: false, metrics: false } })];
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Editar as opções de IA do token assistente" }));
    const form = await screen.findByTestId("api-token-mcp-edit");
    const save = within(form).getByRole("button", { name: "Salvar opções" });
    expect(save).toBeDisabled();
    expect(within(form).getByText(/Desligar uma opção não pede senha/)).toBeInTheDocument();
    fireEvent.click(within(form).getByTestId("mcp-edit-secretsRead"));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.key === "PATCH /api/settings/api-tokens/:id/mcp")).toBe(true));
    expect(calls.find((c) => c.key === "PATCH /api/settings/api-tokens/:id/mcp")!.body).toEqual({ mcp: { securityApply: false, secretsRead: false, skipApproval: false, metrics: false } });
    await waitFor(() => expect(screen.queryByTestId("api-token-mcp-edit")).toBeNull());

    fireEvent.click(await screen.findByRole("button", { name: "Editar as opções de IA do token assistente" }));
    const again = await screen.findByTestId("api-token-mcp-edit");
    fireEvent.click(within(again).getByTestId("mcp-edit-metrics"));
    expect(within(again).getByText(/confirme com a sua senha/)).toBeInTheDocument();
    const save2 = within(again).getByRole("button", { name: "Salvar opções" });
    expect(save2).toBeDisabled();
    fireEvent.change(within(again).getByLabelText("Sua senha atual"), { target: { value: "MinhaSenha123" } });
    failures["PATCH /api/settings/api-tokens/:id/mcp"] = new ApiRequestError(409, "token_mcp_changed", "As opções deste token mudaram enquanto você editava.");
    fireEvent.click(save2);
    expect(await within(again).findByRole("alert")).toHaveTextContent("mudaram");
    fireEvent.click(within(again).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByTestId("api-token-mcp-edit")).toBeNull();
  });

  it("editar com 2FA pede o código ao ligar e o envia", async () => {
    twoFactor = true;
    tokens = [info()];
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Editar as opções de IA do token assistente" }));
    const form = await screen.findByTestId("api-token-mcp-edit");
    fireEvent.click(within(form).getByTestId("mcp-edit-skipApproval"));
    fireEvent.change(within(form).getByLabelText("Sua senha atual"), { target: { value: "MinhaSenha123" } });
    await waitFor(() => expect(within(form).getByLabelText(/Código/)).toBeInTheDocument());
    const save = within(form).getByRole("button", { name: "Salvar opções" });
    expect(save).toBeDisabled();
    fireEvent.change(within(form).getByLabelText(/Código/), { target: { value: "111222" } });
    fireEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.key === "PATCH /api/settings/api-tokens/:id/mcp")).toBe(true));
    expect(calls.find((c) => c.key === "PATCH /api/settings/api-tokens/:id/mcp")!.body).toMatchObject({ currentPassword: "MinhaSenha123", code: "111222" });
  });
});
