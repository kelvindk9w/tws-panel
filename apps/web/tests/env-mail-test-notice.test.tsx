/**
 * Variáveis — com a caixa de teste de e-mail ligada, o painel fornece dezenas de nomes: eles ficam AGRUPADOS num item
 * recolhível dentro do aviso da caixa, e não em dezenas de linhas na tabela.
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

import { ProjectEnvCard } from "@/components/ProjectEnvCard";
import { setLocale } from "../src/i18n";

const PROJECT = { id: "p1", name: "loja", slug: "loja", detection: { type: "compose" } } as unknown as Project;
const BOX_NAMES = ["MAIL_HOST", "MAIL_MAILER", "SMTP_ADDRESS", "SMTP_HOST", "SMTP_PASS", "SMTP_URL", "SPRING_MAIL_HOST"];

function serve(mailTest: { host: string; variables: string[] } | null, links: Record<string, string> = {}) {
  apiFetchMock.mockImplementation(async () => ({
    vars: [{ key: "API_KEY", value: "abc" }],
    compose: null,
    provided: mailTest ? BOX_NAMES : [],
    providedValues: {},
    links,
    mailTest,
  }));
}

beforeEach(() => {
  apiFetchMock.mockReset();
  window.localStorage.clear();
  setLocale("pt-BR", { persist: false });
});
afterEach(cleanup);

function renderCard() {
  return render(
    <MemoryRouter>
      <ProjectEnvCard project={PROJECT} />
    </MemoryRouter>,
  );
}

describe("aviso da caixa de teste na tela Variáveis", () => {
  it("agrupa os nomes num item recolhível e não os repete como linhas da tabela", async () => {
    serve({ host: "paas-mailtest-loja", variables: BOX_NAMES });
    renderCard();
    const notice = await screen.findByTestId("env-mail-test");
    expect(notice.textContent).toContain("paas-mailtest-loja");
    const details = screen.getByTestId("env-mail-test-variables") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("7 variáveis redirecionadas");
    expect(details.textContent).toContain("SPRING_MAIL_HOST");
    // o "linked" do bloco de fornecidos não lista os nomes só da caixa
    expect(screen.getByTestId("env-provided").textContent).not.toContain("SPRING_MAIL_HOST");
    fireEvent.click(details.querySelector("summary")!);
  });

  it("uma variável do app que a pessoa LIGOU ao e-mail continua aparecendo nos fornecidos", async () => {
    serve({ host: "paas-mailtest-loja", variables: BOX_NAMES }, { SMTP_ADDRESS: "SMTP_HOST" });
    renderCard();
    await screen.findByTestId("env-mail-test");
    expect(screen.getByTestId("env-provided").textContent).toContain("SMTP_ADDRESS");
  });

  it("uma só variável usa o singular; sem a caixa, nada disso aparece", async () => {
    serve({ host: "paas-mailtest-loja", variables: ["SMTP_HOST"] });
    renderCard();
    expect((await screen.findByTestId("env-mail-test-variables")).textContent).toContain("1 variável redirecionada");
    cleanup();
    serve(null);
    renderCard();
    await screen.findByDisplayValue("abc");
    expect(screen.queryByTestId("env-mail-test")).toBeNull();
  });
});
