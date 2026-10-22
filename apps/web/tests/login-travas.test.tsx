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

function stubLogin(retryAfterSec: number | null = 300) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { code?: string };
      if (!body.code) return jsonResponse({ error: "two_factor_required", message: "Digite o código." }, 401);
      return jsonResponse({ error: "two_factor_locked", message: LOCKED_PT, ...(retryAfterSec === null ? {} : { retryAfterSec }) }, 429);
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
    expect(alert).toHaveTextContent("Tente de novo em 5 min.");
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
    expect(alert).toHaveTextContent("Try again in 5 min.");
  });
});

describe("LoginPage — tempo restante do bloqueio", () => {
  it.each([
    [30, "Tente de novo em 30 s."],
    [90, "Tente de novo em 2 min."],
    [7200, "Tente de novo em 2 h."],
  ])("retryAfterSec=%i → %s", async (seconds, text) => {
    stubLogin(seconds);
    await loginUntilCode();
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("sem retryAfterSec: só a mensagem do servidor", async () => {
    stubLogin(null);
    await loginUntilCode();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/Tente de novo em/);
  });
});

describe("LoginPage — tentativas restantes no código errado", () => {
  function stubWrong(data: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { code?: string };
        if (!body.code) return jsonResponse({ error: "two_factor_required", message: "Digite o código." }, 401);
        return jsonResponse({ error: "invalid_two_factor_code", message: "Código incorreto.", ...data }, 401);
      }),
    );
  }

  it("pt-BR: mostra quantas tentativas restam e por quanto tempo bloqueia", async () => {
    stubWrong({ attemptsLeft: 3, nextLockSec: 300 });
    await loginUntilCode();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Código incorreto. Restam 3 tentativas antes de bloquear o código do app por 5 min.",
    );
  });

  it("pt-BR: singular quando resta uma", async () => {
    stubWrong({ attemptsLeft: 1, nextLockSec: 60 });
    await loginUntilCode();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Código incorreto. Resta 1 tentativa antes de bloquear o código do app por 1 min.",
    );
  });

  it("en: texto traduzido, com plural", async () => {
    setLocale("en");
    stubWrong({ attemptsLeft: 4, nextLockSec: 300 });
    await loginUntilCode();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Wrong code. 4 attempts left before the app code is locked for 5 min.");
    expect(alert.textContent).not.toMatch(/Restam|auth\.login/);
    cleanup();
    stubWrong({ attemptsLeft: 1, nextLockSec: 7200 });
    await loginUntilCode();
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong code. 1 attempt left before the app code is locked for 2 h.");
  });

  it("o aviso é anunciado (alert assertivo) e o campo do código continua", async () => {
    stubWrong({ attemptsLeft: 2, nextLockSec: 300 });
    const code = await loginUntilCode();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(code).toBeInTheDocument();
  });

  it("sem os números (servidor antigo ou resposta sem contagem): só a mensagem do servidor, sem 'undefined'", async () => {
    stubWrong({});
    await loginUntilCode();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Código incorreto.");
    expect(alert.textContent).not.toMatch(/Restam|undefined|NaN|antes de bloquear/);
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
