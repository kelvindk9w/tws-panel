/**
 * ip-in-address.test.tsx — indicador discreto "contém o IP da VPS" nos
 * endereços de sslip.io já criados (lista de domínios do projeto e cabeçalho
 * da página do projeto). Nada para endereços do domínio de aplicações, de
 * domínio próprio ou .localhost.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";
import { MemoryRouter } from "react-router";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { setLocale } from "@/i18n/core";
import { addressHasVpsIp, IpInAddressHint } from "@/components/IpInAddress";
import { ProjectDomainsCard } from "@/components/ProjectDomainsCard";

const project = (domain: string, aliases: string[] = []) =>
  ({ id: "p1", name: "loja", slug: "loja", domain, aliases, lastDeployStatus: "success", detection: { type: "dockerfile" } }) as unknown as Project;

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("addressHasVpsIp", () => {
  it.each([
    ["loja.203-0-113-10.sslip.io", true],
    ["LOJA.203-0-113-10.SSLIP.IO", true],
    ["loja-k3x9q.apps.example.com", false],
    ["loja.example.com", false],
    ["loja.localhost", false],
    ["sslip.io.example.com", false],
    ["meusslip.io", false],
    ["evil-sslip.io", false],
    ["", false],
    [null, false],
    [undefined, false],
  ])("%j → %s", (domain, expected) => {
    expect(addressHasVpsIp(domain)).toBe(expected);
  });
});

describe("IpInAddressHint", () => {
  it("sslip.io: ícone + texto curto com título explicativo", () => {
    render(<IpInAddressHint domain="loja.203-0-113-10.sslip.io" />);
    const hint = screen.getByTestId("ip-in-address");
    expect(hint).toHaveTextContent("contém o IP da VPS");
    expect(hint).toHaveAttribute("title", expect.stringMatching(/contém o IP da VPS.*domínio ou subdomínio/));
    expect(hint.querySelector("svg")).not.toBeNull();
  });

  it("compacto: só o ícone na tela, mas o texto continua para leitor de tela", () => {
    render(<IpInAddressHint domain="loja.203-0-113-10.sslip.io" compact />);
    const text = within(screen.getByTestId("ip-in-address")).getByText("contém o IP da VPS");
    expect(text.className).toContain("sr-only");
  });

  it("outros endereços: nada", () => {
    render(<IpInAddressHint domain="loja-k3x9q.apps.example.com" />);
    expect(screen.queryByTestId("ip-in-address")).not.toBeInTheDocument();
  });

  it("em inglês", () => {
    setLocale("en", { persist: false });
    render(<IpInAddressHint domain="loja.203-0-113-10.sslip.io" />);
    expect(screen.getByTestId("ip-in-address")).toHaveTextContent("contains the VPS IP");
  });
});

describe("Domínios do projeto", () => {
  it("só o endereço sslip.io leva o indicador; o do domínio de aplicações e o próprio, não", () => {
    render(
      <MemoryRouter>
        <ProjectDomainsCard
          project={project("loja.203-0-113-10.sslip.io", ["loja-k3x9q.apps.example.com", "loja.example.com"])}
          publicIp="203.0.113.10"
          onChanged={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(within(screen.getByTestId("domain-loja.203-0-113-10.sslip.io")).getByTestId("ip-in-address")).toBeInTheDocument();
    expect(within(screen.getByTestId("domain-loja-k3x9q.apps.example.com")).queryByTestId("ip-in-address")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("domain-loja.example.com")).queryByTestId("ip-in-address")).not.toBeInTheDocument();
  });
});
