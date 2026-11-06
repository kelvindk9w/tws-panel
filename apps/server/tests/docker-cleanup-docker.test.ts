/**
 * docker-cleanup-docker.test.ts — as chamadas da limpeza à Docker Engine API (servidor falso num socket unix):
 * só /system/df, /containers/json, /build/prune e DELETE /images/{nome}; nada de volumes ou containers.
 */
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDockerCleanupApi } from "../src/services/docker-cleanup-docker.js";
import { removeDir } from "./helpers/tmp.js";

let dir: string;
let server: http.Server;
let seen: string[];
let reply: (method: string, url: string) => { status: number; body: string };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-cleanup-sock-"));
  seen = [];
  reply = () => ({ status: 200, body: "{}" });
  server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const r = reply(req.method ?? "", req.url ?? "");
    res.writeHead(r.status);
    res.end(r.body);
  });
  await new Promise<void>((ok) => server.listen(path.join(dir, "d.sock"), ok));
});
afterEach(async () => {
  await new Promise((ok) => server.close(ok));
  await removeDir(dir);
});
const api = () => createDockerCleanupApi(path.join(dir, "d.sock"));

describe("leitura", () => {
  it("df devolve imagens e cache (listas nulas viram vazias)", async () => {
    reply = () => ({ status: 200, body: JSON.stringify({ Images: [{ Id: "sha256:a" }], BuildCache: null }) });
    expect(await api().df()).toEqual({ images: [{ Id: "sha256:a" }], cache: [] });
    // sem medir volumes: só imagens e cache de build
    expect(seen[0]).toBe("GET /system/df?type=image&type=build-cache");
    reply = () => ({ status: 200, body: "{}" });
    expect(await api().df()).toEqual({ images: [], cache: [] });
  });
  it("df: erro, corpo quebrado ou socket ausente = null", async () => {
    reply = () => ({ status: 500, body: "x" });
    expect(await api().df()).toBeNull();
    reply = () => ({ status: 200, body: "{quebrado" });
    expect(await api().df()).toBeNull();
    expect(await createDockerCleanupApi(path.join(dir, "nao-existe.sock")).df()).toBeNull();
  });
  it("usedImageIds junta as imagens de todos os containers", async () => {
    reply = () => ({ status: 200, body: JSON.stringify([{ ImageID: "sha256:a" }, { ImageID: "sha256:a" }, {}]) });
    expect([...(await api().usedImageIds())!]).toEqual(["sha256:a"]);
    expect(seen[0]).toBe("GET /containers/json?all=1");
    reply = () => ({ status: 200, body: "nope" });
    expect(await api().usedImageIds()).toBeNull();
    reply = () => ({ status: 500, body: "[]" });
    expect(await api().usedImageIds()).toBeNull();
  });
});

describe("para onde um nome aponta", () => {
  it("imageIdOf devolve o id; nome inexistente, erro ou corpo estranho = null", async () => {
    reply = () => ({ status: 200, body: JSON.stringify({ Id: "sha256:abc" }) });
    expect(await api().imageIdOf("paas-x:latest")).toBe("sha256:abc");
    expect(seen[0]).toBe("GET /images/paas-x%3Alatest/json");
    reply = () => ({ status: 404, body: "{}" });
    expect(await api().imageIdOf("x")).toBeNull();
    reply = () => ({ status: 200, body: "{}" });
    expect(await api().imageIdOf("x")).toBeNull();
    reply = () => ({ status: 200, body: "quebrado" });
    expect(await api().imageIdOf("x")).toBeNull();
    expect(await createDockerCleanupApi(path.join(dir, "nao-existe.sock")).imageIdOf("x")).toBeNull();
  });
});

describe("escrita", () => {
  it("pruneBuildCache pede só o cache parado há N horas e devolve o espaço liberado", async () => {
    reply = () => ({ status: 200, body: JSON.stringify({ SpaceReclaimed: 123 }) });
    expect(await api().pruneBuildCache(168)).toBe(123);
    const [m, url] = seen[0]!.split(" ") as [string, string];
    expect(m).toBe("POST");
    expect(url.startsWith("/build/prune?all=true&filters=")).toBe(true);
    expect(JSON.parse(decodeURIComponent(url.split("filters=")[1]!))).toEqual({ until: ["168h"] });
    reply = () => ({ status: 200, body: "{}" });
    expect(await api().pruneBuildCache(24)).toBe(0);
    reply = () => ({ status: 200, body: "quebrado" });
    expect(await api().pruneBuildCache(24)).toBe(0);
  });
  it("pruneBuildCache com erro do Docker lança a mensagem dele", async () => {
    reply = () => ({ status: 500, body: JSON.stringify({ message: "buildkit parado" }) });
    await expect(api().pruneBuildCache(24)).rejects.toThrow("buildkit parado");
    reply = () => ({ status: 500, body: "" });
    await expect(api().pruneBuildCache(24)).rejects.toThrow("500");
  });
  it("removeImage apaga um nome (sem force) e traduz a recusa do Docker", async () => {
    expect(await api().removeImage("repo/app:1")).toEqual({ ok: true });
    expect(seen[0]).toBe("DELETE /images/repo%2Fapp%3A1");
    reply = () => ({ status: 409, body: JSON.stringify({ message: "container usa a imagem" }) });
    expect(await api().removeImage("x")).toEqual({ ok: false, message: "container usa a imagem" });
    reply = () => ({ status: 404, body: "texto puro" });
    expect(await api().removeImage("x")).toEqual({ ok: false, message: "texto puro" });
    reply = () => ({ status: 500, body: "" });
    expect(await api().removeImage("x")).toEqual({ ok: false, message: "Docker respondeu 500" });
    expect(await createDockerCleanupApi(path.join(dir, "nao-existe.sock")).removeImage("x")).toMatchObject({ ok: false });
    expect(seen.every((s) => !s.includes("/volumes") && !s.includes("/containers/") || s.startsWith("GET /containers/json"))).toBe(true);
  });
});
