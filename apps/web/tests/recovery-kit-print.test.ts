import { describe, expect, it, vi } from "vitest";
import { printText } from "@/lib/recovery-kit";

describe("printText", () => {
  it("escreve o texto escapado na janela e manda imprimir", () => {
    const doc = { write: vi.fn(), close: vi.fn() };
    const win = { document: doc, focus: vi.fn(), print: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
    expect(printText("Kit <1>", "a & <b>")).toBe(true);
    const html = String(doc.write.mock.calls[0]![0]);
    expect(html).toContain("a &amp; &lt;b&gt;");
    expect(html).toContain("Kit &lt;1&gt;");
    expect(win.print).toHaveBeenCalled();
    open.mockRestore();
  });

  it("devolve false quando o navegador bloqueia a janela", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    expect(printText("t", "x")).toBe(false);
    open.mockRestore();
  });
});
