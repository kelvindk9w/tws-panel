/**
 * dockerfile.ts — porta do EXPOSE da imagem FINAL (último estágio) e ARGs declarados.
 */
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dockerfileArgNames, dockerfileExposePort, readDockerfileText } from "../src/dockerfile.js";

describe("dockerfileExposePort — último estágio", () => {
  it("multi-stage: vale o EXPOSE do estágio final, não o do primeiro", () => {
    const content = [
      "FROM node:22 AS build",
      "EXPOSE 5173",
      "RUN npm run build",
      "FROM nginx:alpine",
      "COPY --from=build /app/dist /usr/share/nginx/html",
      "EXPOSE 80",
    ].join("\n");
    expect(dockerfileExposePort(content)).toBe(80);
  });

  it("estágio final sem EXPOSE, partindo de imagem externa: null (o EXPOSE do build não conta)", () => {
    const content = "FROM node:22 AS build\nEXPOSE 5173\nFROM nginx:alpine\nCOPY --from=build /a /b\n";
    expect(dockerfileExposePort(content)).toBeNull();
  });

  it("estágio final que parte de um estágio anterior herda o EXPOSE dele (cadeia)", () => {
    const content = "FROM node:22 AS base\nEXPOSE 3000\nFROM base AS deps\nRUN true\nFROM deps AS final\nCMD [\"node\"]\n";
    expect(dockerfileExposePort(content)).toBe(3000);
  });

  it("um estágio que parte de si mesmo não entra em laço", () => {
    expect(dockerfileExposePort("FROM loop AS loop\n")).toBeNull();
  });

  it("estágio único: primeira porta, com protocolo, várias por linha, caixa mista e comentário no meio", () => {
    expect(dockerfileExposePort("FROM alpine\nexpose 8080/tcp 9090\n")).toBe(8080);
    expect(dockerfileExposePort("FROM alpine\n# EXPOSE 1111\nEXPOSE 2222\n")).toBe(2222);
    expect(dockerfileExposePort("FROM alpine\nEXPOSE 53/udp\n")).toBe(53);
  });

  it("EXPOSE por variável, fora da faixa, sem FROM ou vazio: null", () => {
    expect(dockerfileExposePort("FROM alpine\nEXPOSE ${PORT}\n")).toBeNull();
    expect(dockerfileExposePort("FROM alpine\nEXPOSE 70000\n")).toBeNull();
    expect(dockerfileExposePort("EXPOSE 80\n")).toBeNull();
    expect(dockerfileExposePort("")).toBeNull();
  });

  it("instrução em várias linhas (\\) e opções do FROM (--platform) são entendidas", () => {
    const content = "FROM --platform=linux/amd64 node:22 AS web\nEXPOSE \\\n  4000\n";
    expect(dockerfileExposePort(content)).toBe(4000);
  });
});

describe("dockerfileArgNames", () => {
  it("lista os ARG de todos os estágios, com ou sem padrão, sem repetir", () => {
    const content = [
      "ARG BASE=22",
      "FROM node:${BASE} AS build",
      "ARG VITE_API_URL",
      'ARG VITE_TITLE="meu site"',
      "# ARG COMENTADO",
      "FROM nginx",
      "ARG VITE_API_URL",
      "ARG A B=2",
      "RUN echo ARG_NAO",
    ].join("\n");
    expect(dockerfileArgNames(content).sort()).toEqual(["A", "B", "BASE", "VITE_API_URL", "VITE_TITLE"]);
  });

  it("sem ARG: lista vazia", () => {
    expect(dockerfileArgNames("FROM alpine\nRUN true\n")).toEqual([]);
  });
});

describe("readDockerfileText", () => {
  it("lê um arquivo comum e recusa link simbólico e ausente", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paas-dockerfile-"));
    try {
      expect(await readDockerfileText(dir)).toBeNull();
      await writeFile(path.join(dir, "Dockerfile"), "FROM alpine\n");
      expect(await readDockerfileText(dir)).toBe("FROM alpine\n");
      await writeFile(path.join(dir, "real"), "FROM x\n");
      await symlink(path.join(dir, "real"), path.join(dir, "Outro"));
      expect(await readDockerfileText(dir, "Outro")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
