/**
 * Testes do Passo 4 do wizard (criação da conta admin): validações ao vivo
 * (força de senha, confirmação, usuário), submit na API e a tela de sucesso
 * com score de segurança e o botão "Ir para o login".
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminStep } from "../src/pages/setup/AdminStep";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SCAN_REPORT = {
  report: {
    scannedAt: "x",
    target: "container",
    durationMs: 1,
    lynisAvailable: false,
    hardeningIndex: 82,
    hardeningIndexSource: "internal",
    summary: { total: 10, pass: 8, warning: 1, critical: 1, unknown: 0 },
    checks: [],
  },
  cached: true,
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderAdminStep() {
  return render(
    <MemoryRouter initialEntries={["/setup"]}>
      <Routes>
        <Route path="/setup" element={<AdminStep />} />
        <Route path="/login" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** fetch mock: scan ok por padrão; o comportamento do POST é configurável. */
function mockFetch(postResponse: () => Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/security/scan")) return jsonResponse(SCAN_REPORT);
    return postResponse();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("AdminStep (Passo 4 do wizard)", () => {
  it("botão desabilitado até usuário válido + senha forte + confirmação igual", async () => {
    mockFetch(async () => jsonResponse({}, 500));
    const user = userEvent.setup();
    renderAdminStep();

    const submit = screen.getByRole("button", { name: /concluir setup/i });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(/^usuário/i), "admin");
    await user.type(screen.getByLabelText(/^senha/i), "MinhaSenha123");
    expect(submit).toBeDisabled(); // falta confirmar

    await user.type(screen.getByLabelText(/confirmar senha/i), "MinhaSenha123");
    expect(submit).toBeEnabled();
  });

  it("senha fraca → checklist ao vivo marca as regras não atendidas", async () => {
    mockFetch(async () => jsonResponse({}, 500));
    const user = userEvent.setup();
    renderAdminStep();

    await user.type(screen.getByLabelText(/^senha/i), "fraca");

    const minChars = screen.getByText(/mínimo de 12 caracteres/i).closest("li")!;
    const upper = screen.getByText(/letra maiúscula/i).closest("li")!;
    const number = screen.getByText(/um número/i).closest("li")!;
    // regras violadas aparecem em cinza (não-emerald); minúscula está ok
    expect(minChars.className).toContain("text-muted-foreground");
    expect(upper.className).toContain("text-muted-foreground");
    expect(number.className).toContain("text-muted-foreground");
    expect(screen.getByText(/letra minúscula/i).closest("li")!.className).toContain("text-emerald-400");
    expect(screen.getByRole("button", { name: /concluir setup/i })).toBeDisabled();
  });

  it("confirmação diferente → aviso e botão desabilitado", async () => {
    mockFetch(async () => jsonResponse({}, 500));
    const user = userEvent.setup();
    renderAdminStep();

    await user.type(screen.getByLabelText(/^usuário/i), "admin");
    await user.type(screen.getByLabelText(/^senha/i), "MinhaSenha123");
    await user.type(screen.getByLabelText(/confirmar senha/i), "OutraSenha123");

    expect(screen.getByText(/as senhas não coincidem/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /concluir setup/i })).toBeDisabled();
  });

  it("sucesso → POST correto, tela de sucesso com score e botão 'Ir para o login'", async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse({ ok: true, user: { username: "admin", createdAt: "x" } }, 201),
    );
    const user = userEvent.setup();
    renderAdminStep();

    await user.type(screen.getByLabelText(/^usuário/i), "admin");
    await user.type(screen.getByLabelText(/^senha/i), "MinhaSenha123");
    await user.type(screen.getByLabelText(/confirmar senha/i), "MinhaSenha123");
    await user.click(screen.getByRole("button", { name: /concluir setup/i }));

    // tela de sucesso com o score do Passo 2
    expect(await screen.findByText(/setup concluído/i)).toBeInTheDocument();
    expect(screen.getByText("82")).toBeInTheDocument();

    const [url, init] = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/setup/admin"))!;
    expect(url).toBe("/api/setup/admin");
    expect(JSON.parse(String(init?.body))).toEqual({ username: "admin", password: "MinhaSenha123" });

    // botão leva ao login
    await user.click(screen.getByRole("button", { name: /ir para o login/i }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/login"));
  });

  it("409 admin_exists → exibe a mensagem da API", async () => {
    mockFetch(async () =>
      jsonResponse(
        { error: "admin_exists", message: "A conta de administrador já foi criada. Entre pela tela de login." },
        409,
      ),
    );
    const user = userEvent.setup();
    renderAdminStep();

    await user.type(screen.getByLabelText(/^usuário/i), "admin");
    await user.type(screen.getByLabelText(/^senha/i), "MinhaSenha123");
    await user.type(screen.getByLabelText(/confirmar senha/i), "MinhaSenha123");
    await user.click(screen.getByRole("button", { name: /concluir setup/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/já foi criada/i);
    // não mostrou a tela de sucesso
    expect(screen.queryByText(/setup concluído/i)).not.toBeInTheDocument();
  });
});
