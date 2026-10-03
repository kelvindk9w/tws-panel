/**
 * "Ligar às variáveis do projeto" — validação real (03/10/2026): o dono
 * tentou ligar MAIL_FROM a MAIL_FROM_NAME e o seletor não achou; digitou
 * "host" e "smtp" e faltavam variáveis. Os nomes que o painel já entrega
 * sumiam da lista, e as que o app lê por env_file (SMTP_USUARIO, SMTP_SENHA,
 * só no .env.example) nem eram oferecidas. Agora: compose + .env.example +
 * Variáveis, com a origem; os do painel e os reservados aparecem
 * desabilitados, com o motivo.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEmailConfig } from "@paas/core";
import { COMPOSE_NAMES, ENV_EXAMPLE_NAMES } from "./fixtures/cassino-env-names";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetchMock(path, init),
  ApiRequestError: class ApiRequestError extends Error {},
}));

import { EmailLinksModal } from "@/components/project/EmailLinksModal";

const EMAIL: ProjectEmailConfig = {
  enabled: true,
  domain: "envio.exemplo.com.br",
  mailbox: "contato@envio.exemplo.com.br",
  mailFrom: "contato@envio.exemplo.com.br",
  fromName: "Contato",
  env: {
    SMTP_HOST: "mail.envio.exemplo.com.br",
    SMTP_PORT: "587",
    SMTP_USER: "contato@envio.exemplo.com.br",
    SMTP_PASS: "••••••••",
    MAIL_FROM: "contato@envio.exemplo.com.br",
    MAIL_FROM_NAME: "Contato",
  },
  envLinks: {},
};

const ENV = {
  vars: [
    { key: "KYC_MODO", value: "x" },
    { key: "COMPOSE_PROFILES", value: "" },
  ],
  compose: { usesEnvFile: true, variables: COMPOSE_NAMES.map((name) => ({ name, required: false, defaultValue: null })) },
  provided: ["MAIL_FROM", "MAIL_FROM_NAME", "SMTP_HOST", "SMTP_PASS", "SMTP_PORT", "SMTP_USER"],
  links: {},
  example: { files: [".env.example"], variables: ENV_EXAMPLE_NAMES.map((name) => ({ name, file: ".env.example" })) },
};

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path === "/api/projects/p1/env") return ENV;
    throw new Error(path);
  });
});
afterEach(cleanup);

async function openPicker(key: string) {
  const user = userEvent.setup();
  render(<EmailLinksModal projectId="p1" email={EMAIL} onClose={vi.fn()} onSaved={vi.fn()} />);
  const dialog = await screen.findByRole("dialog");
  // espera as variáveis chegarem
  await within(dialog).findByText(/SMTP_PASS/);
  await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
  const box = within(dialog).getByRole("combobox", { name: `Variável que recebe ${key}` });
  await user.click(box);
  return { user, dialog, box };
}

const optionTexts = () => screen.getAllByRole("option").map((o) => o.textContent ?? "");
const option = (name: string) => screen.getAllByRole("option").find((o) => o.textContent?.startsWith(name))!;

describe("EmailLinksModal — opções do seletor", () => {
  it("'smtp' acha todas: as do compose, as só do .env.example e as que o painel entrega (desabilitadas)", async () => {
    const { user, box } = await openPicker("SMTP_PASS");
    await user.type(box, "smtp");
    const texts = optionTexts();
    for (const name of ["SMTP_PORTA", "SMTP_USUARIO", "SMTP_SENHA", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS"]) {
      expect(texts.some((t) => t.startsWith(name)), name).toBe(true);
    }
    // origem como dica
    expect(option("SMTP_SENHA")).toHaveTextContent("do .env.example");
    expect(option("SMTP_SENHA")).not.toHaveAttribute("aria-disabled");
    expect(option("SMTP_PORTA")).toHaveTextContent("do compose · do .env.example");
    // nome que o painel já entrega: aparece, desabilitado, com o motivo
    expect(option("SMTP_HOST")).toHaveAttribute("aria-disabled", "true");
    expect(option("SMTP_HOST")).toHaveTextContent("o painel já entrega com este nome");
    expect(option("SMTP_PASS")).toHaveAttribute("aria-disabled", "true");
    // as escolhíveis vêm antes das desabilitadas
    const listed = texts.filter((t) => !t.startsWith("Usar o nome novo"));
    const firstDisabled = listed.findIndex((t) => /o painel já entrega/.test(t));
    expect(firstDisabled).toBeGreaterThan(0);
    expect(listed.slice(firstDisabled).every((t) => /o painel já entrega/.test(t))).toBe(true);
  });

  it("'host' (minúsculas) acha SITE_HOST, CARTEIRA_HOST e SMTP_HOST", async () => {
    const { user, box } = await openPicker("SMTP_HOST");
    await user.type(box, "host");
    const texts = optionTexts();
    for (const name of ["CARTEIRA_HOST", "SITE_HOST", "SMTP_HOST"]) expect(texts.some((t) => t.startsWith(name)), name).toBe(true);
  });

  it("'mail_from' mostra MAIL_FROM e MAIL_FROM_NAME desabilitadas (o painel já entrega) — e explica", async () => {
    const { user, box } = await openPicker("MAIL_FROM");
    await user.type(box, "mail_from");
    expect(option("MAIL_FROM_NAME")).toHaveAttribute("aria-disabled", "true");
    expect(option("MAIL_FROM_NAME")).toHaveTextContent("o painel já entrega com este nome");
    expect(option("MAIL_FROM")).toHaveAttribute("aria-disabled", "true");
    // clicar não escolhe: a lista continua aberta e a escolha não muda
    await user.click(option("MAIL_FROM_NAME"));
    expect(box).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(box).toHaveValue("mesmo nome (padrão)");
  });

  it("nome reservado aparece desabilitado com o motivo; nas Variáveis tem a dica", async () => {
    const { user, box } = await openPicker("SMTP_USER");
    await user.type(box, "compose_");
    expect(option("COMPOSE_PROFILES")).toHaveAttribute("aria-disabled", "true");
    expect(option("COMPOSE_PROFILES")).toHaveTextContent(/nome reservado/);
    await user.clear(box);
    await user.type(box, "kyc");
    expect(option("KYC_MODO")).toHaveTextContent("do compose · do .env.example · nas Variáveis");
  });

  it("ainda dá para digitar um nome novo e escolher uma do .env.example", async () => {
    const { user, box, dialog } = await openPicker("SMTP_PASS");
    await user.type(box, "senha");
    await user.click(option("SMTP_SENHA"));
    expect(box).toHaveValue("SMTP_SENHA");
    const from = within(dialog).getByRole("combobox", { name: "Variável que recebe MAIL_FROM" });
    await user.click(from);
    await user.type(from, "REMETENTE_APP");
    expect(screen.getByRole("option", { name: "Usar o nome novo REMETENTE_APP" })).toBeInTheDocument();
  });

  it("servidor antigo (sem example): só compose e Variáveis", async () => {
    apiFetchMock.mockImplementation(async () => ({ vars: [], compose: null, provided: [] }));
    const { user, box } = await openPicker("SMTP_PASS");
    await user.type(box, "smtp");
    // só os nomes do próprio e-mail, desabilitados
    expect(screen.getAllByRole("option").filter((o) => !o.hasAttribute("aria-disabled")).map((o) => o.textContent)).toEqual([
      "Usar o nome novo smtp",
    ]);
  });
});
