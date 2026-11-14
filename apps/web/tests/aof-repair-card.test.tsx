/**
 * aof-repair-card.test.tsx — o redis que não sobe por causa do arquivo AOF corrompido: a causa em linguagem
 * simples, o reparo só com confirmação explícita (o que vai acontecer, quantos bytes saem, a cópia antes), a
 * medição quando o redis não diz os bytes, o resultado com a saída, o projeto parado pela pessoa que continua
 * parado, o corte maior que o confirmado (nada alterado, confirmar de novo), erros, duplo clique, o Dashboard
 * dizendo a causa e a aba Recursos com o cartão.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AofRepairResponse, MetricsSummaryResponse, ProjectAofFinding, ProjectMetricsResponse } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { setLocale } from "@/i18n/core";
import { AofRepairCard } from "@/components/project/AofRepairCard";
import { MetricsStrip } from "@/components/metrics/MetricsStrip";
import { ProjectResourcesSection } from "@/components/project/ProjectResourcesSection";

const FINDING: ProjectAofFinding = { service: "redis", container: "paas-loja-redis-1", engine: "redis", kind: "format", file: "appendonly.aof.27.incr.aof", bytes: 1397 };
const OK: AofRepairResponse = {
  ok: true,
  outcome: "repaired",
  service: "redis",
  backup: "appendonlydir.bak-20261114-031509",
  discardedBytes: 1397,
  restarted: true,
  keptStopped: false,
  output: "== Reparo ==\nSuccessfully truncated AOF appendonly.aof.27.incr.aof",
};

function show(findings: ProjectAofFinding[] = [FINDING], onChanged?: () => void) {
  return render(<AofRepairCard projectId="p1" findings={findings} {...(onChanged ? { onChanged } : {})} />);
}

const openConfirm = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Reparar arquivo do redis" }));
  return screen.findByTestId("aof-confirm");
};

beforeEach(() => {
  setLocale("pt-BR");
  apiFetchMock.mockReset();
});
afterEach(() => cleanup());

describe("AofRepairCard — a causa", () => {
  it("diz em linguagem simples o que aconteceu, o arquivo e os bytes que o redis informa", () => {
    show();
    const c = screen.getByTestId("aof-finding-redis");
    expect(c).toHaveTextContent("O redis do serviço redis não sobe");
    expect(c).toHaveTextContent("appendonly.aof.27.incr.aof");
    expect(c).toHaveTextContent("cai de forma brusca");
    expect(screen.getByTestId("aof-bytes")).toHaveTextContent(/últimos 1\.?397 bytes do arquivo/);
    expect(within(c).getByRole("link", { name: /Como funciona/ })).toHaveAttribute("href", expect.stringContaining("/pt-br/guides/redis-aof-repair/"));
  });

  it("nada a mostrar sem diagnóstico", () => {
    const { container } = show([]);
    expect(container).toBeEmptyDOMElement();
  });

  it("em inglês", () => {
    setLocale("en");
    show([{ ...FINDING, engine: "valkey", bytes: null }]);
    expect(screen.getByTestId("aof-finding-redis")).toHaveTextContent("The valkey of service redis does not start");
    expect(screen.getByRole("button", { name: "Measure how much will be discarded" })).toBeInTheDocument();
  });
});

describe("AofRepairCard — confirmação e reparo", () => {
  it("nada acontece sem confirmar: o diálogo diz a cópia, os bytes e o serviço parado, e exige marcar 'Entendi'", async () => {
    show();
    const dlg = await openConfirm();
    expect(dlg).toHaveTextContent("Parar o serviço durante o reparo");
    expect(dlg).toHaveTextContent(".bak-<data-hora>");
    expect(dlg).toHaveTextContent(/Descartar 1\.?397 bytes do fim do arquivo/);
    expect(dlg).toHaveTextContent("o corte é maior: confira o número");
    const ok = screen.getByRole("button", { name: "Reparar agora" });
    expect(ok).toBeDisabled();
    fireEvent.click(ok);
    expect(apiFetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByTestId("aof-confirm")).toBeNull();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("confirmado: manda só o serviço e o máximo confirmado; mostra o resultado e a saída", async () => {
    const onChanged = vi.fn();
    apiFetchMock.mockResolvedValue(OK);
    show([FINDING], onChanged);
    await openConfirm();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Reparar agora" }));
    await screen.findByTestId("aof-result");
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = apiFetchMock.mock.calls[0]!;
    expect(url).toBe("/api/projects/p1/aof-repair");
    expect(JSON.parse(init.body)).toEqual({ service: "redis", maxBytes: 1397 });
    const r = screen.getByTestId("aof-result");
    expect(r).toHaveTextContent("Arquivo reparado");
    expect(r).toHaveTextContent("appendonlydir.bak-20261114-031509");
    expect(r).toHaveTextContent("Successfully truncated");
    expect(screen.queryByRole("button", { name: "Reparar arquivo do redis" })).toBeNull();
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByTestId("aof-confirm")).toBeNull();
  });

  it("duplo clique no confirmar: um pedido só", async () => {
    let resolve!: (v: AofRepairResponse) => void;
    apiFetchMock.mockReturnValue(new Promise((r) => (resolve = r)));
    show();
    await openConfirm();
    fireEvent.click(screen.getByRole("checkbox"));
    const ok = screen.getByRole("button", { name: "Reparar agora" });
    fireEvent.click(ok);
    fireEvent.click(ok);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Reparando… não feche esta janela." })).toBeDisabled();
    await act(async () => resolve(OK));
    await screen.findByTestId("aof-result");
  });

  it.each([
    [{ ...OK, ok: false, outcome: "fix_failed", discardedBytes: null } as AofRepairResponse, "A ferramenta não cortou o arquivo", false],
    [{ ...OK, ok: false, outcome: "backup_failed", backup: null, discardedBytes: null } as AofRepairResponse, "nada foi cortado", false],
    [{ ...OK, ok: false, outcome: "start_failed", restarted: false } as AofRepairResponse, "não voltou a subir", false],
    [{ ...OK, ok: false, outcome: "fix_failed", restarted: false, discardedBytes: null } as AofRepairResponse, "Atenção: o serviço não voltou a subir", true],
  ])("resultado de falha (%#) aparece com o motivo", async (res, text, extra) => {
    apiFetchMock.mockResolvedValue(res);
    show();
    await openConfirm();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Reparar agora" }));
    const r = await screen.findByTestId("aof-result");
    expect(r).toHaveTextContent(text);
    if (extra) expect(r).toHaveTextContent("Inicie o projeto");
  });

  it("projeto parado pela pessoa: o resultado diz que o serviço ficou parado (sem o aviso de 'não voltou')", async () => {
    apiFetchMock.mockResolvedValue({ ...OK, restarted: false, keptStopped: true });
    show();
    await openConfirm();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Reparar agora" }));
    const r = await screen.findByTestId("aof-result");
    expect(r).toHaveTextContent("Arquivo reparado");
    expect(r).toHaveTextContent("O serviço ficou parado porque o projeto está parado por você");
    expect(r).not.toHaveTextContent("não voltou a subir");
  });

  it("projeto parado e a cópia falhou: voltou ao estado de antes, parado", async () => {
    apiFetchMock.mockResolvedValue({ ...OK, ok: false, outcome: "backup_failed", backup: null, discardedBytes: null, restarted: false, keptStopped: true });
    show();
    await openConfirm();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Reparar agora" }));
    const r = await screen.findByTestId("aof-result");
    expect(r).toHaveTextContent("voltou ao estado de antes");
    expect(r).toHaveTextContent("o serviço ficou parado");
    expect(r).not.toHaveTextContent("não voltou a subir");
  });

  it("a ferramenta cortaria mais que o confirmado: nada alterado, o número novo aparece e é preciso confirmar de novo", async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiRequestError(409, "aof_discard_exceeds", "O reparo descartaria 5000 bytes", { error: "aof_discard_exceeds", bytes: 5000 }));
    show();
    const dlg = await openConfirm();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Reparar agora" }));
    await within(dlg).findByRole("alert");
    expect(dlg).toHaveTextContent(/descartaria 5\.?000 bytes/);
    expect(dlg).toHaveTextContent(/Descartar 5\.?000 bytes do fim/);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    apiFetchMock.mockResolvedValueOnce(OK);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Reparar agora" }));
    await screen.findByTestId("aof-result");
    expect(JSON.parse(apiFetchMock.mock.calls[1]![1].body)).toEqual({ service: "redis", maxBytes: 5000 });
  });

  it("outro erro (imagem sem a ferramenta): a mensagem do servidor, dentro do diálogo", async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiRequestError(422, "aof_tool_missing", "A imagem do serviço não tem a ferramenta redis-check-aof."));
    show();
    const dlg = await openConfirm();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Reparar agora" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("não tem a ferramenta redis-check-aof");
  });
});

describe("AofRepairCard — redis que não diz os bytes (antes do Redis 8.4, Valkey)", () => {
  it("primeiro mede (nada alterado), depois confirma com o número medido", async () => {
    apiFetchMock.mockResolvedValueOnce({ service: "redis", file: FINDING.file, bytes: 812 });
    show([{ ...FINDING, bytes: null }]);
    expect(screen.getByTestId("aof-bytes")).toHaveTextContent("não diz quantos bytes");
    expect(screen.queryByRole("button", { name: "Reparar arquivo do redis" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Medir quanto será descartado" }));
    expect(await screen.findByTestId("aof-bytes")).toHaveTextContent("mediu 812 bytes");
    expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/p1/aof-repair/measure", expect.objectContaining({ method: "POST", body: JSON.stringify({ service: "redis" }) }));
    const dlg = await openConfirm();
    expect(dlg).toHaveTextContent("Descartar 812 bytes");
  });

  it("medição que falhou: mostra o erro e continua sem o botão de reparar", async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiRequestError(422, "aof_manifest_missing", "O manifesto não está na pasta de dados."));
    show([{ ...FINDING, bytes: null }]);
    fireEvent.click(screen.getByRole("button", { name: "Medir quanto será descartado" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("O manifesto não está na pasta de dados.");
    expect(screen.queryByRole("button", { name: "Reparar arquivo do redis" })).toBeNull();
    // erro que não é da API: texto padrão
    apiFetchMock.mockRejectedValueOnce("falhou");
    fireEvent.click(screen.getByRole("button", { name: "Medir quanto será descartado" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível medir."));
  });
});

describe("Dashboard: a causa no lugar de 'pode estar fora do ar'", () => {
  it("o item de atenção diz o serviço, o arquivo e aponta o reparo na aba Recursos", async () => {
    const T = Date.parse("2026-11-14T03:00:00Z");
    const summary: MetricsSummaryResponse = {
      generatedAt: new Date(T).toISOString(),
      collector: { mode: "full", hostSource: "mounted", containerSource: "cgroup", lastTickAt: new Date(T).toISOString(), lastError: null, retention: { minuteHours: 48, hourDays: 90, dayDays: 730 } },
      cpu: { level: "ok", spark: [], busyPct: 10, stealPct: 0, psi: 0, cores: 2 },
      memory: { level: "ok", spark: [], usedPct: 40, availBytes: 5e9, totalBytes: 8e9, swapUsedBytes: 0, psi: 0, oomKills24h: 0 },
      disk: { level: "ok", spark: [], usedPct: 40, freeBytes: 4e10, inodePct: 5, daysToFull: null },
      network: { level: "ok", spark: [], rxBytesPerSecond: 1, txBytesPerSecond: 1 },
      projects: { level: "critical", spark: [], running: 1, total: 1, problemCount: 1, problems: [{ slug: "loja", services: ["redis"], reasons: ["aof_corrupt", "restarting"], level: "critical", aof: [FINDING] }] },
      protections: { level: "ok", certificates: { total: 1, problems: 0 }, backups: { destinationConnected: true, lastFailure: false } },
    };
    apiFetchMock.mockResolvedValue(summary);
    render(
      <MemoryRouter>
        <MetricsStrip projects={[{ slug: "loja", id: "p-loja", name: "Loja Virtual" }]} />
      </MemoryRouter>,
    );
    const item = await screen.findByTestId("attention-project-loja");
    expect(item).toHaveTextContent("redis não sobe: o arquivo de dados do redis (appendonly.aof.27.incr.aof) ficou com o final corrompido");
    expect(item).not.toHaveTextContent("pode estar fora do ar");
    expect(within(item).getByRole("link", { name: "Reparar o arquivo do redis de Loja Virtual" })).toHaveAttribute("href", "/projects/p-loja/resources");
    expect(screen.getByTestId("metric-projects")).toHaveTextContent("arquivo de dados do redis corrompido (tem reparo)");
  });
});

describe("aba Recursos: o cartão aparece com o diagnóstico", () => {
  it("mostra o cartão quando a resposta traz serviços em ciclo pelo AOF", async () => {
    const reply: ProjectMetricsResponse = {
      range: "24h",
      resolution: "minute",
      stepSeconds: 240,
      from: 0,
      to: 86400,
      partial: false,
      total: null,
      services: [],
      events: [],
      aof: [FINDING],
      collector: { mode: "full", hostSource: "mounted", containerSource: "cgroup", lastTickAt: null, lastError: null, retention: { minuteHours: 48, hourDays: 90, dayDays: 730 } },
    };
    apiFetchMock.mockResolvedValue(reply);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    render(
      <MemoryRouter>
        <ProjectResourcesSection projectId="p1" />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("aof-finding-redis")).toBeInTheDocument();
  });
});
