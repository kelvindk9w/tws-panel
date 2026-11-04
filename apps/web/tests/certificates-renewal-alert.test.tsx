/**
 * Página Certificados: próxima renovação esperada (proporcional à validade) e
 * o estado do alerta de cada nome.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CertificateItem, CertificateListResponse } from "@paas/core";
import { CertificatesPage } from "../src/pages/CertificatesPage";
import { alertReasonKey, validityDays } from "../src/lib/certificates";

const base: CertificateItem = {
  host: "loja.exemplo.com.br",
  owner: { kind: "project", projectId: "p1", projectName: "Loja" },
  mode: "automatic",
  coveredBy: null,
  state: "valid",
  issuer: "Let's Encrypt",
  validFrom: "2027-03-01T00:00:00.000Z",
  validTo: "2027-05-04T00:00:00.000Z", // 64 dias
  renewsAround: "2027-04-12T08:00:00.000Z",
  lastError: null,
  manual: null,
  canRetry: false,
  alert: { level: "none", reason: null },
  failure: null,
};

function show(item: CertificateItem) {
  const body: CertificateListResponse = { checkedAt: new Date().toISOString(), proxyRunning: true, items: [item] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })),
  );
  render(
    <MemoryRouter>
      <CertificatesPage pollMs={10} pollMaxMs={50} />
    </MemoryRouter>,
  );
  return screen.findByTestId(`cert-${item.host}`);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("validityDays / alertReasonKey", () => {
  it("validade total em dias (90, 64, 45, 6) e null sem datas ou incoerentes", () => {
    expect(validityDays({ validFrom: "2027-03-01T00:00:00Z", validTo: "2027-05-04T00:00:00Z" })).toBe(64);
    expect(validityDays({ validFrom: "2027-03-01T00:00:00Z", validTo: "2027-04-15T00:00:00Z" })).toBe(45);
    expect(validityDays({ validFrom: "2027-03-01T00:00:00Z", validTo: "2027-03-07T00:00:00Z" })).toBe(6);
    expect(validityDays({ validFrom: "2027-03-01T00:00:00Z", validTo: "2027-03-01T01:00:00Z" })).toBe(1);
    expect(validityDays({ validFrom: null, validTo: "2027-03-07T00:00:00Z" })).toBeNull();
    expect(validityDays({ validFrom: "2027-03-01T00:00:00Z", validTo: null })).toBeNull();
    expect(validityDays({ validFrom: "2027-03-07T00:00:00Z", validTo: "2027-03-01T00:00:00Z" })).toBeNull();
    expect(validityDays({ validFrom: "lixo", validTo: "2027-03-01T00:00:00Z" })).toBeNull();
  });
  it("chave do alerta só quando há alerta com motivo", () => {
    expect(alertReasonKey({ alert: { level: "none", reason: null } })).toBeNull();
    expect(alertReasonKey({ alert: { level: "warning", reason: null } })).toBeNull();
    expect(alertReasonKey({ alert: { level: "warning", reason: "renewal_late" } })).toBe("certificates.card.alert.reason.renewal_late");
  });
});

describe("CertificatesPage — renovação esperada e alerta", () => {
  it("mostra a próxima renovação e a validade do certificado (64 dias)", async () => {
    const card = await show(base);
    expect(within(card).getByTestId("renews-around")).toHaveTextContent(/próxima renovação esperada por volta de 12\/04\/2027/);
    expect(within(card).getByTestId("renews-around")).toHaveTextContent(/dura 64 dias/);
  });

  it("sem o início da validade a data aparece sem a duração", async () => {
    const card = await show({ ...base, validFrom: null });
    const text = within(card).getByTestId("renews-around").textContent!;
    expect(text).toMatch(/12\/04\/2027/);
    expect(text).not.toMatch(/dura/);
  });

  it("sem alerta: diz que está tudo certo", async () => {
    const card = await show(base);
    expect(within(card).getByTestId("alert-state")).toHaveTextContent(/tudo certo/);
  });

  it("renovação atrasada (atenção) e crítica têm texto e cor próprios", async () => {
    const card = await show({ ...base, state: "expiring", alert: { level: "warning", reason: "renewal_late" } });
    const el = within(card).getByTestId("alert-state");
    expect(el).toHaveTextContent(/Alerta ativo \(atenção\): o Caddy devia ter renovado/);
    expect(el.className).toMatch(/amber/);
    cleanup();
    const crit = await show({ ...base, state: "expiring", alert: { level: "critical", reason: "renewal_late" } });
    expect(within(crit).getByTestId("alert-state")).toHaveTextContent(/\(crítico\)/);
    expect(within(crit).getByTestId("alert-state").className).toMatch(/destructive/);
  });

  it("emissão falhando com certificado válido: caixa com tentativas, desde quando e a causa traduzida", async () => {
    const card = await show({
      ...base,
      alert: { level: "warning", reason: "issuance_failing" },
      failure: {
        rounds: 5,
        firstAt: "2027-03-10T00:00:00.000Z",
        lastAt: "2027-03-10T09:00:00.000Z",
        error: { cause: "dns", message: "O DNS deste nome não aponta para esta VPS.", detail: null, at: null, retryAfter: null },
      },
    });
    const box = within(card).getByTestId("failure-box");
    expect(box).toHaveTextContent(/tentou 5 vezes desde 10\/03\/2027/);
    expect(box).toHaveTextContent(/O DNS deste nome não aponta/);
  });

  it("a caixa da falha não repete o erro quando o item já mostra o último erro", async () => {
    const card = await show({
      ...base,
      state: "failed",
      issuer: null,
      validFrom: null,
      validTo: null,
      renewsAround: null,
      alert: { level: "warning", reason: "issuance_failing" },
      lastError: { cause: "dns", message: "Causa do último erro.", detail: null, at: null, retryAfter: null },
      failure: { rounds: 3, firstAt: null, lastAt: null, error: null },
    });
    expect(within(card).queryByTestId("failure-box")).toBeNull();
    expect(within(card).getByText("Causa do último erro.")).toBeInTheDocument();
  });

  it("falha sem data nem causa traduzida: mostra traço e não quebra", async () => {
    const card = await show({
      ...base,
      alert: { level: "warning", reason: "issuance_failing" },
      failure: { rounds: 3, firstAt: null, lastAt: null, error: null },
    });
    expect(within(card).getByTestId("failure-box")).toHaveTextContent(/desde —/);
  });

  it("certificado próprio perto do fim: alerta de vencimento (manual), sem data de renovação", async () => {
    const card = await show({ ...base, mode: "manual", state: "expiring", renewsAround: null, alert: { level: "warning", reason: "expiring" } });
    expect(within(card).getByTestId("alert-state")).toHaveTextContent(/o certificado próprio está perto de vencer/);
    expect(within(card).queryByTestId("renews-around")).toBeNull();
  });

  it("certificado próprio sem alerta: explica a regra de 1/3 da validade", async () => {
    const card = await show({ ...base, mode: "manual", renewsAround: null });
    expect(within(card).getByTestId("alert-state")).toHaveTextContent(/1\/3 da validade/);
  });

  it("proxy fora do ar (estado desconhecido): não mostra linha de alerta", async () => {
    const card = await show({ ...base, state: "unknown", issuer: null, validFrom: null, validTo: null, renewsAround: null });
    expect(within(card).queryByTestId("alert-state")).toBeNull();
  });

  it("vencido: texto próprio", async () => {
    const card = await show({ ...base, state: "expired", alert: { level: "critical", reason: "expired" } });
    expect(within(card).getByTestId("alert-state")).toHaveTextContent(/o certificado venceu/);
  });
});
