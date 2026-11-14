/**
 * Aviso de disco maior que o sistema de arquivos (depois de um upgrade no provedor) na faixa
 * "Saúde da VPS": no cartão Disco e na lista de atenção, com o link para o guia. O painel só
 * avisa; a previsão continua e o texto diz que ampliar resolve.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiskUnexpanded, MetricsSummaryResponse } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { setLocale } from "@/i18n/core";
import { SITE_URL } from "@/lib/links";
import { MetricsStrip } from "@/components/metrics/MetricsStrip";

const T = Date.parse("2026-11-14T12:00:00Z");
const GiB = 1024 ** 3;

/** O caso real: disco de 200 GiB, sistema de arquivos de 95,8 GiB (o "96G" do df), 103 GiB a liberar. */
const CASO_REAL: DiskUnexpanded = {
  diskBytes: 200 * GiB,
  fsBytes: 102888095744,
  spareBytes: 110785478656,
  disk: "sda",
  partition: "sda1",
  partitionNumber: 1,
  fsType: "ext4",
  growPartition: true,
};

function summary(disk: Partial<MetricsSummaryResponse["disk"]> = {}): MetricsSummaryResponse {
  return {
    generatedAt: new Date(T).toISOString(),
    collector: { mode: "full", hostSource: "mounted", containerSource: "cgroup", lastTickAt: new Date(T - 20_000).toISOString(), lastError: null, retention: { minuteHours: 48, hourDays: 90, dayDays: 730 } },
    cpu: { level: "ok", spark: [], busyPct: 10, stealPct: 0, psi: 0, cores: 4 },
    memory: { level: "ok", spark: [], usedPct: 40, availBytes: 5 * GiB, totalBytes: 8 * GiB, swapUsedBytes: 0, psi: 0, oomKills24h: 0 },
    disk: { level: "ok", spark: [], usedPct: 40, freeBytes: 57 * GiB, inodePct: 5, daysToFull: null, ...disk },
    network: { level: "ok", spark: [], rxBytesPerSecond: 100, txBytesPerSecond: 100 },
    projects: { level: "ok", spark: [], running: 1, total: 1, problems: [], problemCount: 0 },
    protections: { level: "ok", certificates: { total: 1, problems: 0 }, backups: { destinationConnected: true, lastFailure: false } },
  };
}

function show() {
  return render(
    <MemoryRouter>
      <MetricsStrip projects={[]} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setLocale("pt-BR");
  apiFetchMock.mockReset();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => cleanup());

const GUIA_PT = `${SITE_URL}/pt-br/guides/disk-expand/`;
const GUIA_EN = `${SITE_URL}/en/guides/disk-expand/`;

describe("disco maior que o sistema de arquivos", () => {
  it("caso real (78% usado, enche em 5 a 6 dias): o cartão explica os números, diz que ampliar resolve e leva ao guia", async () => {
    apiFetchMock.mockResolvedValue(summary({ level: "critical", usedPct: 78, freeBytes: 22 * GiB, daysToFull: { low: 5, high: 6 }, unexpanded: CASO_REAL }));
    show();
    const card = await screen.findByTestId("metric-disk");
    const aviso = within(card).getByTestId("disk-unexpanded");
    expect(aviso).toHaveTextContent("O disco tem 200 GB, mas o sistema usa só 95,8 GB. O restante (103 GB) ainda não foi liberado, o que é comum depois de um upgrade no provedor.");
    // a previsão continua, e o texto diz que ela conta só o espaço em uso
    expect(card).toHaveTextContent("No ritmo atual, enche em cerca de 5 a 6 dias");
    expect(aviso).toHaveTextContent("A previsão conta só os 95,8 GB em uso: ampliar a partição resolve.");
    expect(aviso).toHaveTextContent("Disco /dev/sda, partição /dev/sda1 (ext4)");
    const link = within(aviso).getByRole("link", { name: "Como ampliar o disco (abre o guia em outra aba)" });
    expect(link).toHaveAttribute("href", GUIA_PT);
    // o texto visível faz parte do nome acessível (o leitor de tela e quem enxerga ouvem/leem o mesmo)
    expect(link).toHaveTextContent("Como ampliar o disco");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("caso real na lista de atenção: o item do disco ganha a explicação e o botão do guia, sem item a mais", async () => {
    apiFetchMock.mockResolvedValue(summary({ level: "critical", usedPct: 78, freeBytes: 22 * GiB, daysToFull: { low: 5, high: 6 }, unexpanded: CASO_REAL }));
    show();
    const item = await screen.findByTestId("attention-disk");
    expect(item).toHaveTextContent("No ritmo atual, o disco enche em cerca de 5 a 6 dias.");
    expect(item).toHaveTextContent("O disco tem 200 GB, mas o sistema usa só 95,8 GB. O restante (103 GB) ainda não foi liberado");
    expect(item).toHaveTextContent("Ampliar a partição libera esse espaço; o guia mostra o passo a passo.");
    expect(within(item).getByRole("link", { name: "Como ampliar o disco (abre o guia em outra aba)" })).toHaveAttribute("href", GUIA_PT);
    expect(screen.queryByTestId("attention-disk-unexpanded")).toBeNull();
    expect(screen.getByTestId("metrics-summary")).toHaveAttribute("data-attention", "1");
  });

  it("disco em ordem com espaço sobrando: item só informativo na lista (selo 'Informação'), e o resumo continua 'Tudo em ordem'", async () => {
    apiFetchMock.mockResolvedValue(summary({ unexpanded: CASO_REAL }));
    show();
    const item = await screen.findByTestId("attention-disk-unexpanded");
    expect(item).toHaveTextContent("Espaço do disco ainda não liberado");
    expect(item).toHaveTextContent("Informação");
    expect(within(item).getByText("Informação").closest("[data-level]")).toHaveAttribute("data-level", "info");
    expect(within(item).getByRole("link", { name: "Como ampliar o disco (abre o guia em outra aba)" })).toHaveAttribute("href", GUIA_PT);
    const resumo = screen.getByTestId("metrics-summary");
    expect(resumo).toHaveAttribute("data-state", "ok");
    expect(resumo).toHaveAttribute("data-attention", "0");
    expect(screen.queryByTestId("attention-disk")).toBeNull();
    // sem previsão de encher, o cartão não fala de previsão
    expect(screen.getByTestId("disk-unexpanded")).not.toHaveTextContent("A previsão");
  });

  it("sem espaço sobrando (null) ou servidor antigo (campo ausente): nada de aviso", async () => {
    apiFetchMock.mockResolvedValue(summary({ unexpanded: null }));
    const first = show();
    await screen.findByTestId("metric-disk");
    expect(screen.queryByTestId("disk-unexpanded")).toBeNull();
    expect(screen.queryByTestId("attention-disk-unexpanded")).toBeNull();
    expect(screen.queryByRole("link", { name: /Como ampliar/ })).toBeNull();
    first.unmount();
    apiFetchMock.mockResolvedValue(summary({ level: "critical", usedPct: 93 }));
    show();
    const item = await screen.findByTestId("attention-disk");
    expect(item).not.toHaveTextContent("ainda não foi liberado");
    expect(within(item).queryByRole("link")).toBeNull();
  });

  it("disco inteiro sem partição (xfs): o texto fala em ampliar o sistema de arquivos", async () => {
    const semParticao: DiskUnexpanded = { diskBytes: 100 * GiB, fsBytes: 50 * GiB, spareBytes: 50 * GiB, disk: "sdb", partition: null, partitionNumber: null, fsType: "xfs", growPartition: false };
    apiFetchMock.mockResolvedValue(summary({ level: "warning", usedPct: 60, daysToFull: { low: 20, high: 25 }, unexpanded: semParticao }));
    show();
    const aviso = await screen.findByTestId("disk-unexpanded");
    expect(aviso).toHaveTextContent("O disco tem 100 GB, mas o sistema usa só 50 GB. O restante (50 GB)");
    expect(aviso).toHaveTextContent("A previsão conta só os 50 GB em uso: ampliar o sistema de arquivos resolve.");
    expect(aviso).toHaveTextContent("Disco /dev/sdb, sem partição (xfs)");
    expect(screen.getByTestId("attention-disk")).toHaveTextContent("Ampliar o sistema de arquivos libera esse espaço");
  });

  it("em inglês: textos traduzidos e o guia em inglês", async () => {
    setLocale("en");
    apiFetchMock.mockResolvedValue(summary({ level: "critical", usedPct: 78, daysToFull: { low: 5, high: 6 }, unexpanded: CASO_REAL }));
    show();
    const aviso = await screen.findByTestId("disk-unexpanded");
    expect(aviso).toHaveTextContent("The disk has 200 GB, but the system only uses 95.8 GB. The rest (103 GB) has not been made available yet, which is common after an upgrade at the provider.");
    expect(aviso).toHaveTextContent("The forecast only counts the 95.8 GB in use: expanding the partition solves it.");
    expect(aviso).toHaveTextContent("Disk /dev/sda, partition /dev/sda1 (ext4)");
    expect(within(aviso).getByRole("link", { name: "How to expand the disk (opens the guide in another tab)" })).toHaveAttribute("href", GUIA_EN);
    const item = screen.getByTestId("attention-disk");
    expect(item).toHaveTextContent("Expanding the partition frees that space; the guide shows the steps.");
    expect(within(item).getByRole("link", { name: "How to expand the disk (opens the guide in another tab)" })).toHaveAttribute("href", GUIA_EN);
  });

  it("em inglês, disco em ordem: item informativo com o selo 'Information'", async () => {
    setLocale("en");
    apiFetchMock.mockResolvedValue(summary({ unexpanded: CASO_REAL }));
    show();
    const item = await screen.findByTestId("attention-disk-unexpanded");
    expect(item).toHaveTextContent("Disk space not made available yet");
    expect(item).toHaveTextContent("Information");
  });
});
