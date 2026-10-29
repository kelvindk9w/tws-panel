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

function serve(mailTest: { host: string; variables: string[]; state?: "active" | "pendingOn" | "pendingOff" } | null, links: Record<string, string> = {}) {
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

  it("M1: ligada mas sem reiniciar, o aviso é forte e diz que o app AINDA envia e-mail real (não afirma que vai para a caixa)", async () => {
    serve({ host: "paas-mailtest-loja", variables: BOX_NAMES, state: "pendingOn" });
    renderCard();
    const notice = await screen.findByTestId("env-mail-test");
    expect(notice.dataset.state).toBe("pendingOn");
    expect(notice.className).toContain("red");
    expect(notice.textContent).toContain("o app ainda envia e-mail de verdade");
    expect(notice.textContent).toContain("continua usando o servidor de e-mail real");
    expect(notice.textContent).not.toContain("estão indo para a caixa de teste");
  });

  it("M1: desligada sem reiniciar, o aviso diz que o app ainda aponta para a caixa e que os envios falham", async () => {
    serve({ host: "paas-mailtest-loja", variables: BOX_NAMES, state: "pendingOff" });
    renderCard();
    const notice = await screen.findByTestId("env-mail-test");
    expect(notice.dataset.state).toBe("pendingOff");
    expect(notice.className).toContain("red");
    expect(notice.textContent).toContain("ainda aponta para ela");
    expect(notice.textContent).toContain("os envios dele falham");
  });

  it("M1: aplicada (state active ou ausente) mantém o aviso azul de sempre", async () => {
    serve({ host: "paas-mailtest-loja", variables: BOX_NAMES, state: "active" });
    renderCard();
    const notice = await screen.findByTestId("env-mail-test");
    expect(notice.className).toContain("sky");
    expect(notice.textContent).toContain("estão indo para a caixa de teste");
  });
});
