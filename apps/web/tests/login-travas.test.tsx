/**
 * login-travas.test.tsx — mensagens das travas do login: bloqueio do código por
 * conta (two_factor_locked) mantém o campo do código aberto e mostra o caminho
 * (código de recuperação) em pt-BR e en; aviso do proxy da Cloudflare na tela
 * de Segurança.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../src/i18n";
import { LoginPage } from "../src/pages/LoginPage";
import { SecurityPage } from "../src/pages/SecurityPage";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const REPORT = {
  id: "scan-1",
  scannedAt: "2026-08-21T10:00:00.000Z",
  durationMs: 1000,
  target: "host",
  hardeningIndex: 75,
  hardeningIndexSource: "lynis",
  lynisAvailable: true,
  checks: [],
  summary: { total: 10, pass: 8, fail: 2, unknown: 0, critical: 0, warning: 2 },
  profile: "host",
  skippedChecks: [],
  profileNote: null,
};

const LOCKED_PT =
  "Verificação em duas etapas temporariamente bloqueada por excesso de códigos errados. Tente mais tarde ou use um código de recuperação.";

afterEach(() => {
  cleanup();
  setLocale("pt-BR");
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

async function loginUntilCode() {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await user.type(screen.getByLabelText(/^(usuário|username)$/i), "admin");
  await user.type(screen.getByLabelText(/^(senha|password)$/i), "MinhaSenha123");
  await user.click(screen.getByRole("button", { name: /^(entrar|sign in)$/i }));
  const code = await screen.findByLabelText(/(código de verificação|verification code)/i);
  await user.type(code, "123456");
  await user.click(screen.getByRole("button", { name: /^(entrar|sign in)$/i }));
  return code;
}

function stubLogin() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { code?: string };
      if (!body.code) return jsonResponse({ error: "two_factor_required", message: "Digite o código." }, 401);
      return jsonResponse({ error: "two_factor_locked", message: LOCKED_PT, retryAfterSec: 300 }, 429);
    }),
  );
}

describe("LoginPage — bloqueio do código por conta", () => {
  it("pt-BR: mostra a mensagem do servidor com o caminho do código de recuperação e mantém o campo", async () => {
    stubLogin();
    const code = await loginUntilCode();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/código de recuperação/i);
    expect(alert.textContent).not.toMatch(/^errors\.|two_factor_locked/);
    expect(code).toBeInTheDocument();
  });

  it("en: usa o texto traduzido, sem chave crua", async () => {
    setLocale("en");
    stubLogin();
    await loginUntilCode();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/recovery code/i);
    expect(alert.textContent).not.toMatch(/errors\.|code\.two_factor_locked/);
    expect(alert.textContent).not.toMatch(/bloqueada/);
  });
});

describe("SecurityPage — aviso do proxy da Cloudflare", () => {
  function stubSecurity(cloudflareProxy: boolean) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.includes("/api/security/edge")) return jsonResponse({ cloudflareProxy, lastSeenAt: null });
        if (u.includes("/api/security/scan")) return jsonResponse({ report: REPORT, cached: true, refreshing: false });
        if (u.includes("/api/security/history")) return jsonResponse({ entries: [], firstIndex: null, latestIndex: null, applied: null });
        if (u.includes("/api/security/baseline")) return jsonResponse({ baseline: null });
        return jsonResponse({}, 404);
      }),
    );
  }
  const renderPage = () =>
    render(
      <MemoryRouter>
        <SecurityPage />
      </MemoryRouter>,
    );

  it("detectado: avisa para deixar a nuvem cinza (pt-BR e en)", async () => {
    stubSecurity(true);
    renderPage();
    expect(await screen.findByRole("status")).toHaveTextContent(/nuvem cinza/i);
    cleanup();
    setLocale("en");
    renderPage();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/grey cloud/i));
  });

  it("não detectado: nenhum aviso", async () => {
    stubSecurity(false);
    renderPage();
    await screen.findByText(/Segurança/);
    await waitFor(() => expect(screen.queryByText(/Cloudflare/)).toBeNull());
  });
});
