import { describe, expect, it } from "vitest";
import { mailExclusionText, mailServiceDecision } from "../src/mail-network";

describe("mailServiceDecision", () => {
  it("app, worker e imagem desconhecida entram", () => {
    expect(mailServiceDecision({ image: "minha-app:1" })).toEqual({ include: true });
    expect(mailServiceDecision({})).toEqual({ include: true });
    expect(mailServiceDecision({ image: null, buildBase: "node:22" })).toEqual({ include: true });
  });

  it("banco e cache reconhecidos ficam de fora, com registro e tag", () => {
    for (const image of ["mysql:8", "postgres:16-alpine", "docker.io/library/redis:7", "ghcr.io/x/valkey", "mcr.microsoft.com/mssql/server:2022", "mariadb"]) {
      expect(mailServiceDecision({ image })).toMatchObject({ include: false, reason: "database-image", image });
    }
  });

  it("serviço com build cujo Dockerfile parte de um banco fica de fora", () => {
    const d = mailServiceDecision({ image: null, buildBase: "postgres:16" });
    expect(d).toEqual({ include: false, reason: "database-build", image: "postgres:16" });
    expect(mailExclusionText(d)).toBe("Dockerfile parte da imagem de banco/cache postgres:16");
  });

  it("label tws.mail=true mantém um banco; =false tira um app", () => {
    expect(mailServiceDecision({ image: "postgres:16", label: "true" })).toEqual({ include: true, forced: true });
    expect(mailServiceDecision({ image: null, buildBase: "redis:7", label: " TRUE " })).toEqual({ include: true, forced: true });
    expect(mailServiceDecision({ image: "app:1", label: "true" })).toEqual({ include: true });
    const off = mailServiceDecision({ image: "app:1", label: "False" });
    expect(off).toEqual({ include: false, reason: "label" });
    expect(mailExclusionText(off)).toBe("label tws.mail=false");
    expect(mailServiceDecision({ image: "postgres:16", label: "talvez" })).toMatchObject({ include: false });
    expect(mailExclusionText(mailServiceDecision({ image: "mysql:8" }))).toBe("imagem de banco/cache mysql:8");
  });
});
