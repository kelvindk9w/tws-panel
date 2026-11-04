import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MetricPoint } from "@paas/core";
import { setLocale } from "@/i18n/core";
import { LevelBadge, MetricChart, Sparkline } from "@/components/metrics/charts";

beforeEach(() => setLocale("pt-BR"));
afterEach(cleanup);

const pts = (vals: number[], step = 60): MetricPoint[] => vals.map((v, i) => ({ t: i * step, v, max: v + 1 }));
const fmt = (v: number) => `${v}u`;

describe("LevelBadge", () => {
  it("texto + ícone para cada nível (a cor nunca é o único sinal)", () => {
    for (const [level, text] of [
      ["ok", "Normal"],
      ["warning", "Atenção"],
      ["critical", "Crítico"],
      ["unknown", "Sem dados"],
    ] as const) {
      const { container, unmount } = render(<LevelBadge level={level} />);
      expect(screen.getByText(text)).toBeInTheDocument();
      expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(container.firstElementChild).toHaveAttribute("data-level", level);
      unmount();
    }
  });
  it("em inglês", () => {
    setLocale("en");
    render(<LevelBadge level="warning" />);
    expect(screen.getByText("Attention")).toBeInTheDocument();
  });
});

describe("Sparkline", () => {
  it("desenha a linha e descreve em texto (agora, média e pico) para leitor de tela", () => {
    render(<Sparkline title="Processador" points={pts([10, 20, 30])} from={0} to={120} step={60} max={100} format={fmt} />);
    const svg = screen.getByRole("img");
    expect(svg).toHaveAttribute("aria-label", "Processador, últimas 24 horas: agora 30u, média 20u, pico 31u");
    expect(svg.querySelectorAll("path")).toHaveLength(2);
    expect(svg.querySelector("path[stroke]")?.getAttribute("d")).toMatch(/^M0 /);
  });
  it("sem pontos: mensagem em vez de gráfico vazio", () => {
    render(<Sparkline title="x" points={[]} from={0} to={1} step={60} format={fmt} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByTestId("spark-empty")).toHaveTextContent("Sem medidas nas últimas 24 horas");
  });
  it("sem teto fixo escolhe o teto pelos valores", () => {
    render(<Sparkline title="x" points={pts([1000, 2000])} from={0} to={60} step={60} format={fmt} />);
    expect(screen.getByRole("img")).toBeInTheDocument();
  });
});

describe("MetricChart", () => {
  const base = { from: 0, to: 600, step: 60, rangeLabel: "24 horas", format: fmt };

  it("uma série: título, eixo (teto e zero), resumo visível e descrição para leitor de tela", () => {
    render(<MetricChart title="Processador" series={[{ label: "Processador", points: pts([10, 20, 30]) }]} {...base} max={100} />);
    const fig = screen.getByTestId("metric-chart");
    const img = within(fig).getByRole("img");
    expect(img.getAttribute("aria-label")).toContain("Processador: Processador: agora 30u, média 20u, pico 31u");
    expect(img.getAttribute("aria-label")).toContain("24 horas");
    expect(fig).toHaveTextContent("100u");
    expect(fig).toHaveTextContent("0u");
    expect(fig).toHaveTextContent("agora 30u · média 20u · pico 31u");
    expect(img.querySelectorAll("path")).toHaveLength(1);
  });

  it("duas séries: legenda com traço diferente, eixo comum e resumo de cada uma", () => {
    render(
      <MetricChart
        title="Disco"
        series={[
          { label: "Leitura", points: pts([100, 200]) },
          { label: "Escrita", points: pts([5, 6]), dashed: true },
        ]}
        {...base}
      />,
    );
    const fig = screen.getByTestId("metric-chart");
    expect(fig).toHaveTextContent("Leitura");
    expect(fig).toHaveTextContent("Escrita");
    const paths = fig.querySelectorAll("svg[role=img] path");
    expect(paths).toHaveLength(2);
    expect(paths[0]).not.toHaveAttribute("stroke-dasharray");
    expect(paths[1]).toHaveAttribute("stroke-dasharray");
    // a legenda também mostra o traço tracejado
    expect(fig.querySelectorAll("figcaption line[stroke-dasharray]")).toHaveLength(1);
    expect(fig).toHaveTextContent(/Leitura:\s*agora 200u/);
    expect(fig).toHaveTextContent(/Escrita:\s*agora 6u/);
  });

  it("sem pontos nenhum: mensagem 'sem medidas', sem gráfico", () => {
    render(<MetricChart title="Rede" series={[{ label: "Entrada", points: [] }]} {...base} />);
    expect(screen.getByTestId("chart-empty")).toHaveTextContent("Sem medidas neste período");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("uma das duas séries vazia: a legenda mostra as duas, o gráfico só a que tem dados", () => {
    render(
      <MetricChart
        title="Rede"
        series={[
          { label: "Entrada", points: pts([1, 2]) },
          { label: "Saída", points: [], dashed: true },
        ]}
        {...base}
      />,
    );
    expect(screen.getByTestId("metric-chart").querySelectorAll("svg[role=img] path")).toHaveLength(1);
  });
});
