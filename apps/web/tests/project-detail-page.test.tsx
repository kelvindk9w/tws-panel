/**
 * project-detail-page.test.tsx — cabeçalho do projeto. Validação real: não
 * havia botão para abrir o site, e o card dizia "HTTP padrão" com o Caddy
 * servindo HTTPS automático.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ProjectDetailPage } from "@/pages/ProjectDetailPage";

const PROJECT = {
  id: "p1",
  name: "devLink",
  slug: "devlink",
  ingestMode: "git",
  source: "https://github.com/kelvin/devLink",
  branch: "main",
  domain: "devlink.203-0-113-10.sslip.io",
  websocket: false,
  detection: { type: "static", composeFile: null, outputDir: null, packageManager: null, buildCommand: null, proxyService: null, proxyPort: null, warnings: [], details: [] },
  proxyService: null,
  proxyPort: null,
  createdAt: "2026-09-30T10:00:00Z",
  updatedAt: "2026-09-30T10:00:00Z",
  lastDeployAt: "2026-09-30T10:05:00Z",
  lastDeployStatus: "success",
  deployedBranch: "main",
  deployedSource: "https://github.com/kelvin/devLink",
};

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path === "/api/projects/p1") {
      return {
        project: PROJECT,
        status: "running",
        containers: [],
        url: "https://devlink.203-0-113-10.sslip.io",
        credential: { configured: false, hint: null, username: null, updatedAt: null },
      };
    }
    if (path === "/api/projects/p1/jobs") return { jobs: [] };
    return {};
  });
});
afterEach(cleanup);

function abrir() {
  render(
    <MemoryRouter initialEntries={["/projects/p1"]}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProjectDetailPage — acesso ao site", () => {
  it("botão \"Abrir site\" com o endereço https, em nova aba", async () => {
    abrir();
    const botao = await screen.findByRole("link", { name: /Abrir site/ });
    expect(botao).toHaveAttribute("href", "https://devlink.203-0-113-10.sslip.io");
    expect(botao).toHaveAttribute("target", "_blank");
  });

  it("o card diz HTTPS automático (não \"HTTP padrão\")", async () => {
    abrir();
    expect(await screen.findByText(/HTTPS automático/)).toBeInTheDocument();
    expect(screen.queryByText(/HTTP padrão/)).not.toBeInTheDocument();
  });
});
