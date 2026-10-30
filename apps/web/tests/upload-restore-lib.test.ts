/**
 * upload-restore-lib.test.ts — o envio cru com progresso (XMLHttpRequest), a leitura dos primeiros bytes e a porcentagem.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, SESSION_EXPIRED_EVENT } from "@/lib/api";
import { UploadAborted, percentOf, putRaw, readHead } from "@/lib/upload-restore";

class FakeXhr {
  static last: FakeXhr;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  responseType = "";
  responseText = "";
  status = 0;
  upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  sent: unknown;
  constructor() {
    FakeXhr.last = this;
  }
  open(m: string, u: string) {
    this.method = m;
    this.url = u;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(b: unknown) {
    this.sent = b;
  }
  abort() {
    this.onabort?.();
  }
}

beforeEach(() => {
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("percentOf", () => {
  it("limita entre 0 e 100 e trata total desconhecido", () => {
    expect(percentOf(50, 200)).toBe(25);
    expect(percentOf(300, 200)).toBe(100);
    expect(percentOf(-5, 200)).toBe(0);
    expect(percentOf(5, 0)).toBe(0);
  });
});

describe("readHead", () => {
  it("lê só o começo", async () => {
    const buf = await readHead(new Blob(["abcdefgh"]), 3);
    expect(buf.byteLength).toBe(3);
    expect((await readHead(new Blob(["xy"]))).byteLength).toBe(2);
  });
});

describe("putRaw", () => {
  it("envia como octet-stream, avisa o progresso e devolve o JSON", async () => {
    const seen: Array<[number, number]> = [];
    const body = new Blob(["12345"]);
    const h = putRaw<{ uploadId: string }>("/x", body, (l, t) => seen.push([l, t]));
    const x = FakeXhr.last;
    expect(x.method).toBe("PUT");
    expect(x.headers["Content-Type"]).toBe("application/octet-stream");
    expect(x.sent).toBe(body);
    x.upload.onprogress?.({ loaded: 2, total: 5, lengthComputable: true });
    x.upload.onprogress?.({ loaded: 5, total: 0, lengthComputable: false });
    expect(seen).toEqual([
      [2, 5],
      [5, 5],
    ]);
    x.status = 201;
    x.responseText = JSON.stringify({ uploadId: "u" });
    x.onload?.();
    await expect(h.promise).resolves.toEqual({ uploadId: "u" });
  });

  it("converte erro HTTP em ApiRequestError, com e sem JSON", async () => {
    const h = putRaw("/x", new Blob(["a"]), () => undefined);
    const x = FakeXhr.last;
    x.status = 413;
    x.responseText = JSON.stringify({ error: "too_large", message: "grande" });
    x.onload?.();
    await expect(h.promise).rejects.toMatchObject({ status: 413, code: "too_large", message: "grande" });
    const h2 = putRaw("/x", new Blob(["a"]), () => undefined);
    const y = FakeXhr.last;
    y.status = 502;
    y.responseText = "<html>";
    y.onload?.();
    await expect(h2.promise).rejects.toBeInstanceOf(ApiRequestError);
    await expect(h2.promise).rejects.toMatchObject({ code: "http_error" });
  });

  it("401 avisa que a sessão expirou", async () => {
    const heard = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, heard);
    const h = putRaw("/x", new Blob(["a"]), () => undefined);
    const x = FakeXhr.last;
    x.status = 401;
    x.responseText = JSON.stringify({ error: "unauthorized", message: "m" });
    x.onload?.();
    await expect(h.promise).rejects.toBeInstanceOf(ApiRequestError);
    expect(heard).toHaveBeenCalled();
    window.removeEventListener(SESSION_EXPIRED_EVENT, heard);
  });

  it("falha de rede e cancelamento", async () => {
    const h = putRaw("/x", new Blob(["a"]), () => undefined);
    FakeXhr.last.onerror?.();
    await expect(h.promise).rejects.toMatchObject({ code: "network_error" });
    const h2 = putRaw("/x", new Blob(["a"]), () => undefined);
    h2.abort();
    await expect(h2.promise).rejects.toBeInstanceOf(UploadAborted);
  });
});
