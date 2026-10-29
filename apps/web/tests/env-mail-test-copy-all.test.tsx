/**
 * Variáveis com a caixa de teste de e-mail ligada — convive com "Copiar todas" e "Apagar todas": a cópia leva o que a
 * lista mostra (o SMTP já apontando para a caixa), não as dezenas de nomes agrupados no aviso, e o "Apagar todas"
 * segue disponível por haver variável do projeto.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";
import { MemoryRouter } from "react-router";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});
const copyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", () => ({
  copyText: copyMock,
  copyTextLater: async (p: Promise<string>) => {
    try {
      return await copyMock(await p);
    } catch {
      return false;
    }
  },
}));

import { ProjectEnvCard } from "@/components/ProjectEnvCard";
import { parseDotenv } from "../src/lib/dotenv";
import { setLocale } from "../src/i18n";

const PROJECT = { id: "p1", name: "loja", slug: "loja", detection: { type: "compose" } } as unknown as Project;
const BOX_NAMES = ["MAIL_HOST", "SMTP_HOST", "SPRING_MAIL_HOST"];

beforeEach(() => {
  apiFetchMock.mockReset();
  copyMock.mockReset();
  copyMock.mockResolvedValue(true);
  window.localStorage.clear();
  setLocale("pt-BR", { persist: false });
  apiFetchMock.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (init?.method === "PUT") return JSON.parse(String(init.body));
    return {
      vars: [{ key: "API_KEY", value: "abc" }],
      compose: null,
      provided: BOX_NAMES,
      providedValues: { SMTP_HOST: "paas-mailtest-loja", MAIL_HOST: "paas-mailtest-loja", SPRING_MAIL_HOST: "paas-mailtest-loja" },
      links: {},
      mailTest: { host: "paas-mailtest-loja", variables: BOX_NAMES },
    };
  });
});
afterEach(cleanup);

describe("Variáveis com a caixa de teste ligada", () => {
  it("Copiar todas leva as variáveis do projeto e o SMTP da caixa, sem os nomes só agrupados no aviso", async () => {
    render(
      <MemoryRouter>
        <ProjectEnvCard project={PROJECT} />
      </MemoryRouter>,
    );
    await screen.findByDisplayValue("abc");
    fireEvent.click(screen.getByRole("button", { name: "Copiar todas as variáveis" }));
    await screen.findByText(/variáveis? copiadas?/);
    const back = Object.fromEntries(parseDotenv(copyMock.mock.calls.at(-1)![0] as string).vars.map((v) => [v.key, v.value]));
    expect(back).toEqual({ API_KEY: "abc", SMTP_HOST: "paas-mailtest-loja" });
    expect((screen.getByRole("button", { name: /Apagar todas/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
