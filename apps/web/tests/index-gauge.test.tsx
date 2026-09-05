/**
 * IndexGauge: o rótulo da fonte da nota tem que caber dentro do anel nos dois
 * tamanhos (96px e 112px) e nas duas fontes (Lynis e índice interno), sem
 * vazar e sem quebrar em duas linhas. O texto por extenso continua acessível
 * pelo aria-label e pelo title.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { IndexGauge } from "../src/components/IndexGauge";

afterEach(cleanup);

describe("IndexGauge", () => {
  it("mostra o rótulo curto da fonte Lynis nos dois tamanhos", () => {
    const { rerender } = render(<IndexGauge value={82} source="lynis" size="sm" />);
    expect(screen.getByText("Lynis")).toBeInTheDocument();
    expect(screen.queryByText("Lynis Index")).not.toBeInTheDocument();

    rerender(<IndexGauge value={82} source="lynis" size="md" />);
    expect(screen.getByText("Lynis")).toBeInTheDocument();
  });

  it("mostra o rótulo curto da fonte interna nos dois tamanhos", () => {
    const { rerender } = render(<IndexGauge value={36} source="internal" size="sm" />);
    expect(screen.getByText("Interno")).toBeInTheDocument();
    expect(screen.queryByText("Índice interno")).not.toBeInTheDocument();

    rerender(<IndexGauge value={36} source="internal" size="md" />);
    expect(screen.getByText("Interno")).toBeInTheDocument();
  });

  it("impede que o rótulo quebre em duas linhas e o mantém dentro do anel", () => {
    render(<IndexGauge value={36} source="internal" />);
    const rotulo = screen.getByText("Interno");
    expect(rotulo.className).toContain("whitespace-nowrap");
    expect(rotulo.className).toContain("leading-none");
  });

  it("guarda o nome por extenso da fonte no title do rótulo", () => {
    const { rerender } = render(<IndexGauge value={36} source="internal" />);
    expect(screen.getByText("Interno")).toHaveAttribute("title", "Índice interno");

    rerender(<IndexGauge value={82} source="lynis" />);
    expect(screen.getByText("Lynis")).toHaveAttribute("title", "Lynis Index");
  });

  it("descreve nota e fonte por extenso no aria-label", () => {
    const { rerender } = render(<IndexGauge value={36} source="internal" />);
    expect(screen.getByRole("img")).toHaveAttribute(
      "aria-label",
      "Índice de segurança: 36 de 100 (fonte: Índice interno)",
    );

    rerender(<IndexGauge value={82} source="lynis" />);
    expect(screen.getByRole("img")).toHaveAttribute(
      "aria-label",
      "Índice de segurança: 82 de 100 (fonte: Lynis Index)",
    );
  });

  it("mostra travessão quando ainda não há nota", () => {
    render(<IndexGauge value={null} source="internal" />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAttribute(
      "aria-label",
      "Índice de segurança: — de 100 (fonte: Índice interno)",
    );
  });
});
