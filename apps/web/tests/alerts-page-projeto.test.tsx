/**
 * Alertas filtrados por projeto: o atalho da página do projeto abre /alerts?project=<slug>.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { setLocale } from "@/i18n/core";
import { AlertsPage } from "@/pages/AlertsPage";

beforeEach(() => {
  setLocale("pt-BR");
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({ alerts: [], total: 0, openCount: 0, page: 1, perPage: 50 });
});
afterEach(cleanup);

describe("AlertsPage com ?project=", () => {
  it("pede só os alertas do projeto e deixa limpar o filtro", async () => {
    render(
      <MemoryRouter initialEntries={["/alerts?project=loja"]}>
        <AlertsPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(expect.stringContaining("project=loja")));
    expect(screen.getByText("Projeto: loja")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mostrar todos" }));
    await waitFor(() => expect(screen.queryByText("Projeto: loja")).not.toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenLastCalledWith(expect.not.stringContaining("project="));
  });
});
