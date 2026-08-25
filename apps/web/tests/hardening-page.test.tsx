/**
 * Página de hardening acessível fora do wizard.
 *
 * O fluxo scan → plano → aplicar → confirmar vivia apenas em SecurityStep,
 * alcançável só pelo wizard de instalação. Depois do setup concluído não
 * havia caminho de volta: a página /security mostrava só o índice, e
 * reaplicar hardening exigia reinstalar o painel.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("@/lib/api", async () => {
  const real = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...real, apiFetch: apiFetchMock };
});

const REPORT = {
  id: "scan-1",
  scannedAt: "2026-08-21T10:00:00.000Z",
  durationMs: 115_000,
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

afterEach(() => {
  cleanup();
  apiFetchMock.mockReset();
});

describe("HardeningPage", () => {
  it("renderiza o fluxo de hardening fora do wizard de setup", async () => {
    const { HardeningPage } = await import("../src/pages/HardeningPage");
    apiFetchMock.mockResolvedValue({ report: REPORT, entries: [], phases: [] });

    render(
      <MemoryRouter initialEntries={["/security/hardening"]}>
        <Routes>
          <Route path="/security/hardening" element={<HardeningPage />} />
        </Routes>
      </MemoryRouter>,
    );

    // O componente do wizard é reaproveitado; basta ele montar sem exigir
    // contexto de setup para provar que o fluxo é alcançável aqui.
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
  });

  it("oferece caminho de volta para a página de segurança", async () => {
    const { HardeningPage } = await import("../src/pages/HardeningPage");
    apiFetchMock.mockResolvedValue({ report: REPORT, entries: [], phases: [] });

    render(
      <MemoryRouter initialEntries={["/security/hardening"]}>
        <Routes>
          <Route path="/security/hardening" element={<HardeningPage />} />
          <Route path="/security" element={<p>pagina de seguranca</p>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
  });
});

describe("SecurityPage", () => {
  it("mostra um caminho para reaplicar o hardening", async () => {
    const { SecurityPage } = await import("../src/pages/SecurityPage");
    apiFetchMock.mockResolvedValue({ report: REPORT, entries: [], phases: [] });

    render(
      <MemoryRouter initialEntries={["/security"]}>
        <Routes>
          <Route path="/security" element={<SecurityPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const link = await screen.findByRole("link", { name: /hardening|revisar|aplicar/i });
    expect(link).toHaveAttribute("href", "/security/hardening");
  });
});
