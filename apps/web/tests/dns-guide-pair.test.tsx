/**
 * dns-guide-pair.test.tsx — a orientação de DNS cobre o nome digitado E o par
 * com/sem www: tipo, nome como se escreve no provedor (@, www), valor, copiar,
 * o que acontece se só um apontar, e o resultado da verificação de cada nome
 * (par que falha é aviso, nunca erro).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainCheckResponse } from "@paas/core";
import { DnsGuide } from "@/components/DnsGuide";
import { dnsRecords, typedHost } from "@/lib/dns-records";
import { setLocale } from "../src/i18n";

const IP = "203.0.113.10";
const writeText = vi.fn(async () => undefined);

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(cleanup);

function check(over: Partial<DomainCheckResponse>): DomainCheckResponse {
  return { domain: "example.com", devLocal: false, ok: true, state: "pointed", resolvedIps: [IP], machineIps: [IP], message: "ok", ...over };
}

describe("dnsRecords / typedHost", () => {
  it("limpa o que foi digitado: esquema, caminho, maiúsculas, ponto final", () => {
    expect(typedHost(" HTTPS://Example.COM/loja?x=1 ")).toBe("example.com");
    expect(typedHost("example.com.")).toBe("example.com");
    expect(typedHost("não é domínio")).toBe("");
    expect(typedHost("")).toBe("");
  });

  it("apex: A @ e A www (com CNAME opcional para o apex); www: A www e A @; subdomínio: um só", () => {
    expect(dnsRecords("example.com", IP, true).rows).toEqual([
      { kind: "canonical", name: "example.com", label: "@", type: "A", value: IP },
      { kind: "pair", name: "www.example.com", label: "www", type: "A", value: IP, cname: "example.com" },
    ]);
    expect(dnsRecords("www.example.com", IP, true).rows).toEqual([
      { kind: "canonical", name: "www.example.com", label: "www", type: "A", value: IP },
      { kind: "pair", name: "example.com", label: "@", type: "A", value: IP },
    ]);
    expect(dnsRecords("loja.example.com", IP, true).rows).toHaveLength(1);
    expect(dnsRecords("loja.example.com", IP, true).pair).toBeNull();
  });

  it("TLD composto e par desligado", () => {
    const { rows } = dnsRecords("example.com.br", IP, true);
    expect(rows.map((r) => [r.label, r.name])).toEqual([["@", "example.com.br"], ["www", "www.example.com.br"]]);
    expect(dnsRecords("example.com", IP, false).rows).toHaveLength(1);
    expect(dnsRecords("example.com", IP, false).pair?.pair).toBe("www.example.com");
    expect(dnsRecords("", IP, true)).toEqual({ rows: [], pair: null });
  });
});

describe("DnsGuide — o par com/sem www", () => {
  it("apex digitado: orienta o @ e o www, cada um com tipo, nome, valor e copiar", async () => {
    render(<DnsGuide domain="example.com" publicIp={IP} />);
    const canonical = screen.getByTestId("dns-row-canonical");
    const pair = screen.getByTestId("dns-row-pair");
    expect(within(canonical).getByText("@")).toBeInTheDocument();
    expect(within(canonical).getByText("example.com")).toBeInTheDocument();
    expect(within(canonical).getByText("A", { selector: "div" })).toBeInTheDocument();
    expect(canonical).toHaveTextContent(IP);
    expect(within(pair).getByText("www")).toBeInTheDocument();
    expect(within(pair).getByText("www.example.com")).toBeInTheDocument();
    expect(pair).toHaveTextContent(IP);

    fireEvent.click(within(pair).getByRole("button", { name: /Copiar o nome do registro de www\.example\.com/ }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("www"));
    fireEvent.click(within(canonical).getByRole("button", { name: /Copiar o nome do registro de example\.com/ }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("@"));
    fireEvent.click(within(pair).getByRole("button", { name: /Copiar o valor do registro de www\.example\.com/ }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(IP));
  });

  it("www digitado: o par é o apex (@), sempre registro A, e o CNAME alternativo não aparece", () => {
    render(<DnsGuide domain="www.example.com" publicIp={IP} />);
    expect(within(screen.getByTestId("dns-row-canonical")).getByText("www")).toBeInTheDocument();
    const pair = screen.getByTestId("dns-row-pair");
    expect(within(pair).getByText("@")).toBeInTheDocument();
    expect(within(pair).getByText("A", { selector: "div" })).toBeInTheDocument();
    expect(screen.queryByTestId("dns-guide-cname")).not.toBeInTheDocument();
    expect(screen.getByTestId("dns-guide-apex")).toHaveTextContent(/CNAME/);
  });

  it("apex digitado: oferece o CNAME do www para o apex, com copiar", async () => {
    render(<DnsGuide domain="example.com" publicIp={IP} />);
    const cname = screen.getByTestId("dns-guide-cname");
    expect(cname).toHaveTextContent("CNAME");
    expect(cname).toHaveTextContent("www.example.com");
    fireEvent.click(within(cname).getByRole("button"));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("example.com"));
  });

  it("TLD composto: @ e www de example.com.br", () => {
    render(<DnsGuide domain="Example.com.br" publicIp={IP} />);
    expect(within(screen.getByTestId("dns-row-canonical")).getByText("@")).toBeInTheDocument();
    expect(within(screen.getByTestId("dns-row-pair")).getByText("www.example.com.br")).toBeInTheDocument();
  });

  it("explica, em linguagem de leigo, o que acontece se só um dos dois apontar", () => {
    render(<DnsGuide domain="example.com" publicIp={IP} />);
    const texto = screen.getByTestId("dns-guide-only-one");
    expect(texto).toHaveTextContent(/Se só example\.com apontar, o site abre nele, mas quem digitar www\.example\.com vê um erro de conexão/);
    expect(texto).toHaveTextContent(/Se só www\.example\.com apontar, nada abre/);
    expect(screen.getByTestId("dns-guide-pair")).toHaveTextContent(/redirecionamento permanente/);
  });

  it("subdomínio comum: um registro só, sem bloco do par", () => {
    render(<DnsGuide domain="app.example.com" publicIp={IP} onPairEnabledChange={vi.fn()} />);
    expect(screen.queryByTestId("dns-row-pair")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dns-guide-pair")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("dns-row-canonical")).getByText("app")).toBeInTheDocument();
  });

  it("a nuvem cinza da Cloudflare continua no guia", () => {
    render(<DnsGuide domain="example.com" publicIp={IP} />);
    expect(screen.getByTestId("dns-guide-cloudflare")).toHaveTextContent(/nuvem .*cinza/i);
  });

  it("sem domínio: o exemplo de sempre; sem IP conhecido: texto de reserva e sem copiar o valor", () => {
    const { unmount } = render(<DnsGuide domain="" publicIp={null} />);
    expect(screen.getByTestId("dns-guide")).toHaveTextContent("loja.meusite.com.br");
    expect(screen.getByTestId("dns-guide")).toHaveTextContent("IP da sua VPS");
    unmount();
    render(<DnsGuide domain="example.com" publicIp={null} />);
    expect(screen.getAllByText("IP da sua VPS")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Copiar o valor/ })).not.toBeInTheDocument();
  });

  it("a caixa liga/desliga o par: desligado, some a linha do par", () => {
    const onChange = vi.fn();
    const { rerender } = render(<DnsGuide domain="example.com" publicIp={IP} pairEnabled onPairEnabledChange={onChange} />);
    const box = screen.getByRole("checkbox", { name: /Também deixar www\.example\.com funcionando/ });
    expect(box).toBeChecked();
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(false);
    rerender(<DnsGuide domain="example.com" publicIp={IP} pairEnabled={false} onPairEnabledChange={onChange} />);
    expect(screen.queryByTestId("dns-row-pair")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dns-guide-only-one")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("sem onPairEnabledChange não há caixa (o par sempre aparece)", () => {
    render(<DnsGuide domain="example.com" publicIp={IP} />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByTestId("dns-row-pair")).toBeInTheDocument();
  });

  it("em inglês", () => {
    setLocale("en", { persist: false });
    render(<DnsGuide domain="example.com" publicIp={IP} onPairEnabledChange={vi.fn()} />);
    expect(screen.getByTestId("dns-guide")).toHaveTextContent(/create these 2 records/);
    expect(screen.getByTestId("dns-guide-only-one")).toHaveTextContent(/What if only one points here\?/);
    expect(screen.getByRole("checkbox", { name: /Also make www\.example\.com work/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copy the record name for www\.example\.com/ })).toBeInTheDocument();
  });
});

describe("DnsGuide — verificação por nome", () => {
  it("os dois apontam: dois 'apontado'", () => {
    render(
      <DnsGuide
        domain="example.com"
        publicIp={IP}
        check={check({ pair: { domain: "www.example.com", role: "www", ok: true, state: "pointed", resolvedIps: [IP], message: "" } })}
      />,
    );
    expect(screen.getByTestId("dns-state-canonical")).toHaveAttribute("data-state", "pointed");
    expect(screen.getByTestId("dns-state-pair")).toHaveAttribute("data-state", "pointed");
    expect(screen.getByTestId("dns-state-pair")).toHaveTextContent("www.example.com: aponta para esta VPS");
  });

  it.each([
    ["missing", /ainda não aponta/],
    ["elsewhere", /aponta para outro lugar \(198\.51\.100\.7\)/],
    ["cloudflare", /proxy da Cloudflare ligado \(nuvem laranja\)/],
    ["unavailable", /o DNS não respondeu agora/],
  ] as const)("par %s: aviso (não erro) e o principal segue apontado", (state, texto) => {
    render(
      <DnsGuide
        domain="example.com"
        publicIp={IP}
        check={check({ pair: { domain: "www.example.com", role: "www", ok: false, state, resolvedIps: ["198.51.100.7"], message: "" } })}
      />,
    );
    expect(screen.getByTestId("dns-state-canonical")).toHaveAttribute("data-state", "pointed");
    const par = screen.getByTestId("dns-state-pair");
    expect(par).toHaveAttribute("data-state", state);
    expect(par).toHaveTextContent(texto);
    expect(par).toHaveTextContent(/É só um aviso/);
    expect(par).toHaveClass("text-amber-400");
    expect(screen.getByTestId("dns-state-canonical")).toHaveClass("text-emerald-400");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("o principal que não aponta aparece como pendência, sem o aviso de 'só um aviso'", () => {
    render(<DnsGuide domain="example.com" publicIp={IP} check={check({ ok: false, state: "cloudflare", resolvedIps: ["104.16.1.1"] })} />);
    const principal = screen.getByTestId("dns-state-canonical");
    expect(principal).toHaveAttribute("data-state", "cloudflare");
    expect(principal).not.toHaveTextContent(/É só um aviso/);
  });

  it("par já usado por outro projeto, pelo painel ou por este projeto: avisa e não mostra o estado do DNS dele", () => {
    const base = { domain: "www.example.com", role: "www" as const, ok: true, state: "pointed" as const, resolvedIps: [IP], message: "" };
    for (const [occupiedBy, texto] of [
      ["other_project", /já pertence a outro projeto/],
      ["panel", /endereço do próprio painel/],
      ["mail", /nome do servidor de e-mail \(ou do webmail\)/],
      ["same_project", /já está conectado a este projeto/],
    ] as const) {
      const { unmount } = render(<DnsGuide domain="example.com" publicIp={IP} check={check({ pair: { ...base, occupiedBy } })} />);
      expect(screen.getByTestId("dns-guide-occupied")).toHaveTextContent(texto);
      expect(screen.queryByTestId("dns-state-pair")).not.toBeInTheDocument();
      expect(screen.getByTestId("dns-state-canonical")).toBeInTheDocument();
      unmount();
    }
  });

  it("par desligado: não mostra o estado do par", () => {
    render(
      <DnsGuide
        domain="example.com"
        publicIp={IP}
        pairEnabled={false}
        check={check({ pair: { domain: "www.example.com", role: "www", ok: true, state: "pointed", resolvedIps: [IP], message: "" } })}
      />,
    );
    expect(screen.queryByTestId("dns-state-pair")).not.toBeInTheDocument();
    expect(screen.getByTestId("dns-state-canonical")).toBeInTheDocument();
  });

  it("resposta antiga, sem 'state': deriva do ok; sem nada, não mostra estado", () => {
    const { unmount } = render(<DnsGuide domain="example.com" publicIp={IP} check={{ ...check({}), state: undefined as never }} />);
    expect(screen.getByTestId("dns-state-canonical")).toHaveAttribute("data-state", "pointed");
    unmount();
    render(<DnsGuide domain="example.com" publicIp={IP} check={{ ...check({ ok: false }), state: undefined as never }} />);
    expect(screen.queryByTestId("dns-guide-states")).not.toBeInTheDocument();
  });

  it("sufixo desconhecido: o nome copiável é o nome completo, nunca um trecho truncado", () => {
    render(<DnsGuide domain="www.example.xyz.br" publicIp={IP} />);
    expect(screen.getByTestId("dns-row-canonical")).toHaveTextContent("www.example.xyz.br");
    expect(screen.getByTestId("dns-row-canonical").querySelector("code")).toHaveTextContent(/^www\.example\.xyz\.br$/);
  });

  it("sufixo conhecido fora do .com.br (example.dev.br) continua com @", () => {
    render(<DnsGuide domain="example.dev.br" publicIp={IP} />);
    expect(screen.getByTestId("dns-row-canonical").querySelector("code")).toHaveTextContent("@");
  });

  it("cartões empilhados (sem tabela nem rolagem): nome, valor e copiar quebram dentro da largura", () => {
    render(<DnsGuide domain="www.example.br.com" publicIp={IP} />);
    expect(document.querySelector("table")).toBeNull();
    const row = screen.getByTestId("dns-row-canonical");
    expect(row.className).toContain("flex-col");
    expect(row.querySelector(".overflow-x-auto")).toBeNull();
    for (const cell of Array.from(row.querySelectorAll(":scope > div > div"))) expect(cell).toHaveClass("min-w-0", "break-all");
    expect(within(row).getByText(IP)).toHaveClass("whitespace-nowrap");
    expect(within(row).getAllByRole("button")).toHaveLength(2);
  });

  it("nome incerto: os dois registros ficam com o nome completo (sem '@' ao lado de nome inteiro)", () => {
    render(<DnsGuide domain="www.site.de" publicIp={IP} />);
    expect(screen.getByTestId("dns-row-canonical").querySelector("code")).toHaveTextContent(/^www\.site\.de$/);
    expect(screen.getByTestId("dns-row-pair").querySelector("code")).toHaveTextContent(/^site\.de$/);
  });

  it("nome certo: @ e www continuam relativos", () => {
    render(<DnsGuide domain="example.salvador.br" publicIp={IP} />);
    expect(screen.getByTestId("dns-row-canonical").querySelector("code")).toHaveTextContent(/^@$/);
    expect(screen.getByTestId("dns-row-pair").querySelector("code")).toHaveTextContent(/^www$/);
  });
});
