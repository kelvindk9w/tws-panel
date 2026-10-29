/**
 * mcp-token-editor-email.test.tsx — ampliar as opções MCP de um token com o código por e-mail ligado:
 * o formulário mostra o campo, envia o código (pedido para "ampliar token") e o manda no PATCH.
 * (Regressão da revisão: a tela não tinha onde digitar o código e a ampliação ficava impossível.)
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiTokenInfo } from "@paas/core";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetchMock(path, init),
  ApiRequestError: class extends Error {},
}));

import { McpTokenEditor } from "@/components/settings/McpTokenOptions";

const TOKEN = {
  id: "t1",
  name: "assistente",
  scope: "write",
  reach: "panel",
  projects: [],
  canCreate: false,
  hostMetrics: false,
  mcp: { securityApply: false, secretsRead: false, skipApproval: false, metrics: false },
  createdAt: "2026-10-01T00:00:00Z",
  expiresAt: "2027-10-01T00:00:00Z",
} as unknown as ApiTokenInfo;

let calls: Array<{ path: string; body: Record<string, unknown> }>;

beforeEach(() => {
  calls = [];
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path, body });
    if (path === "/api/auth/email-code") return { enabled: true, address: "d***@example.com" };
    if (path === "/api/auth/email-code/send") return { sentTo: "d***@example.com", expiresInSec: 600, resendAfterSec: 30 };
    return { ok: true };
  });
});
afterEach(cleanup);

describe("McpTokenEditor com o código por e-mail ligado", () => {
  it("mostra o campo, pede o código para 'ampliar token' e envia o emailCode", async () => {
    const onSaved = vi.fn();
    render(<McpTokenEditor token={TOKEN} twoFactor={true} onSaved={onSaved} onCancel={() => undefined} />);
    fireEvent.click(screen.getByTestId("mcp-edit-securityApply"));
    const field = await screen.findByTestId("email-code-field");
    expect(field).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Enviar código" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/auth/email-code/send")).toBe(true));
    expect(calls.find((c) => c.path === "/api/auth/email-code/send")!.body).toEqual({ action: "token.edit" });
    const inputs = document.querySelectorAll("input:not([type=checkbox])");
    const byId = (suffix: string) => Array.from(inputs).find((i) => (i as HTMLInputElement).id.endsWith(suffix)) as HTMLInputElement;
    fireEvent.change(byId("mcp-edit-email-code"), { target: { value: "123456" } });
    const password = Array.from(document.querySelectorAll("input[type=password]"))[0] as HTMLInputElement;
    fireEvent.change(password, { target: { value: "senha-do-painel" } });
    const code = Array.from(inputs).find((i) => (i as HTMLInputElement).autocomplete === "one-time-code" && !(i as HTMLInputElement).id.endsWith("email-code")) as HTMLInputElement;
    fireEvent.change(code, { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: /Salvar/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const patch = calls.find((c) => c.path === "/api/settings/api-tokens/t1/mcp")!;
    expect(patch.body).toMatchObject({ currentPassword: "senha-do-painel", code: "654321", emailCode: "123456" });
  });
});
