import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText, copyTextLater } from "../src/lib/clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function clip(c: Record<string, unknown> | undefined) {
  Object.defineProperty(navigator, "clipboard", { value: c, configurable: true });
}

describe("copyText", () => {
  it("usa writeText", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clip({ writeText });
    expect(await copyText("x")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("x");
  });
  it("sem Clipboard API usa execCommand e remove a caixa", async () => {
    clip(undefined);
    document.execCommand = vi.fn().mockReturnValue(true);
    expect(await copyText("x")).toBe(true);
    expect(document.querySelector("textarea")).toBeNull();
  });
  it("remove a caixa mesmo se execCommand lançar", async () => {
    clip(undefined);
    document.execCommand = vi.fn(() => {
      throw new Error("x");
    });
    expect(await copyText("segredo")).toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });
});

describe("copyTextLater", () => {
  it("escreve um ClipboardItem com a promessa, na hora", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    clip({ write });
    const items: unknown[] = [];
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(data: unknown) {
          items.push(data);
        }
      },
    );
    let resolve!: (v: string) => void;
    const p = new Promise<string>((r) => (resolve = r));
    const done = copyTextLater(p);
    expect(write).toHaveBeenCalledTimes(1);
    resolve("texto");
    expect(await done).toBe(true);
    const blob = await (items[0] as { "text/plain": Promise<Blob> })["text/plain"];
    expect(blob.type).toBe("text/plain");
  });
  it("sem ClipboardItem espera o texto e usa copyText", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clip({ writeText });
    expect(await copyTextLater(Promise.resolve("t"))).toBe(true);
    expect(writeText).toHaveBeenCalledWith("t");
  });
  it("write recusado cai no texto simples", async () => {
    clip({ write: vi.fn().mockRejectedValue(new Error("no")), writeText: vi.fn().mockResolvedValue(undefined) });
    vi.stubGlobal("ClipboardItem", class {});
    expect(await copyTextLater(Promise.resolve("t"))).toBe(true);
  });
  it("promessa rejeitada devolve false", async () => {
    clip({ writeText: vi.fn() });
    expect(await copyTextLater(Promise.reject(new Error("x")))).toBe(false);
  });
});
