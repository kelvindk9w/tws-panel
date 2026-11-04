/**
 * reach-masks.test.ts — o que token limitado a projetos deixa de ver nas
 * respostas: conflitos de domínio/porta/nome viram "indisponível", portas só dos
 * projetos do alcance, aba de backup sem outros projetos. Sessão humana e token
 * de painel inteiro recebem tudo.
 */
import { describe, expect, it } from "vitest";
import type { PortUsageRow, PortsResponse, ProjectDomainPair, RestoreCheckView } from "@paas/core";
import { httpError } from "../src/services/http-error.js";
import {
  DOMAIN_UNAVAILABLE,
  NAME_UNAVAILABLE,
  PORT_UNAVAILABLE,
  maskOccupant,
  maskPairOccupants,
  maskPortsResponse,
  maskProjectBackupView,
  maskedForLimitedToken,
} from "../src/services/reach-masks.js";
import { limitedProjectIds, projectInReach } from "../src/services/request-reach.js";

const session = (reach: { kind: "panel" } | { kind: "projects"; ids: string[]; canCreate: boolean } | null) =>
  ({ session: reach ? { token: { id: "t", scope: "admin", reach } } : null }) as never;
const human = session(null);
const wide = session({ kind: "panel" });
const lim = session({ kind: "projects", ids: ["a1"], canCreate: false });

describe("request-reach", () => {
  it("humano e painel inteiro: sem limite; limitado: a lista", () => {
    expect(limitedProjectIds(human)).toBeNull();
    expect(limitedProjectIds(wide)).toBeNull();
    expect([...limitedProjectIds(lim)!]).toEqual(["a1"]);
    expect(projectInReach(human, "x")).toBe(true);
    expect(projectInReach(wide, "x")).toBe(true);
    expect(projectInReach(lim, "a1")).toBe(true);
    expect(projectInReach(lim, "b2")).toBe(false);
    expect(limitedProjectIds({ session: null } as never)).toBeNull();
  });
});

describe("recusas de conflito", () => {
  it("domínio e nome em uso: genéricos para limitado; intactos para os outros", () => {
    const domain = httpError(409, "domain_in_use", "O domínio loja.example.com já está em uso por outro projeto.");
    const folder = httpError(409, "slug_folder_exists", 'Já existe uma pasta "loja" na pasta de projetos (/srv/projetos).');
    for (const who of [human, wide]) {
      expect(maskedForLimitedToken(who, domain)).toBe(domain);
      expect(maskedForLimitedToken(who, folder)).toBe(folder);
    }
    const d = maskedForLimitedToken(lim, domain) as Error & { code: string; statusCode: number };
    expect([d.statusCode, d.code, d.message]).toEqual([409, "domain_unavailable", DOMAIN_UNAVAILABLE]);
    const f = maskedForLimitedToken(lim, folder) as Error & { code: string };
    expect([f.code, f.message]).toEqual(["name_unavailable", NAME_UNAVAILABLE]);
    expect(f.message).not.toContain("srv");
  });

  it("porta em uso (troca simples): genérica, sem dizer quem usa", () => {
    const e = httpError(409, "port_in_use", "A porta 8080 do servidor já é usada por outro-projeto (api). Escolha outra.");
    expect(maskedForLimitedToken(human, e)).toBe(e);
    const m = maskedForLimitedToken(lim, e) as Error & { code: string };
    expect([m.code, m.message]).toEqual(["port_unavailable", PORT_UNAVAILABLE]);
  });

  it("edição em lote: só as linhas de conflito com o servidor viram genéricas; o resumo é refeito", () => {
    const e = httpError(400, "invalid_ports", "2 portas com problema. A primeira: A porta 8080 do servidor já é usada por loja (web). Escolha outra.");
    e.details = {
      errors: [
        { index: 0, message: "A porta 8080 do servidor já é usada por loja (web). Escolha outra." },
        { index: 1, message: "A porta 9000 do servidor é reservada ao painel. Escolha outra." },
        { index: 2, message: "A porta 7000 do servidor também está na linha de web (→ 80)." },
        { index: 3, message: "A porta do servidor precisa ser de 1024 a 65535." },
      ],
    };
    expect(maskedForLimitedToken(human, e)).toBe(e);
    const m = maskedForLimitedToken(lim, e) as Error & { details: { errors: Array<{ index: number; message: string }> } };
    expect(m.details.errors.map((r) => r.message)).toEqual([PORT_UNAVAILABLE, PORT_UNAVAILABLE, PORT_UNAVAILABLE, "A porta do servidor precisa ser de 1024 a 65535."]);
    expect(m.message).toBe(`4 portas com problema. A primeira: ${PORT_UNAVAILABLE}`);
    expect(JSON.stringify(m.details)).not.toContain("loja");
  });

  it("erros de validação sem conflito passam como vieram (e erro sem código também)", () => {
    const only = httpError(400, "invalid_ports", "1 porta com problema. A primeira: x");
    only.details = { errors: [{ index: 0, message: "Informe a porta do servidor." }] };
    expect(maskedForLimitedToken(lim, only)).toBe(only);
    const noDetails = httpError(400, "invalid_ports", "sem detalhes");
    expect(maskedForLimitedToken(lim, noDetails)).toBe(noDetails);
    const other = httpError(404, "project_not_found", "Projeto não encontrado.");
    expect(maskedForLimitedToken(lim, other)).toBe(other);
    expect(maskedForLimitedToken(lim, new Error("x"))).toBeInstanceOf(Error);
    expect(maskedForLimitedToken(lim, null)).toBeNull();
  });
});

describe("par de domínio ocupado", () => {
  it("limitado só vê 'same_project' como é; o resto vira 'unavailable'", () => {
    expect(maskOccupant(human, "other_project")).toBe("other_project");
    expect(maskOccupant(lim, null)).toBeNull();
    expect(maskOccupant(lim, undefined)).toBeUndefined();
    expect(maskOccupant(lim, "same_project")).toBe("same_project");
    for (const o of ["panel", "mail", "other_project"] as const) expect(maskOccupant(lim, o)).toBe("unavailable");
  });

  it("linhas de pares", () => {
    const rows = [
      { domain: "a.com", pair: "www.a.com", occupiedBy: "other_project" },
      { domain: "b.com", pair: "www.b.com", occupiedBy: "same_project" },
      { domain: "c.com", pair: "www.c.com" },
      { domain: "d.com", pair: "www.d.com", occupiedBy: "panel" },
    ] as ProjectDomainPair[];
    expect(maskPairOccupants(human, rows)).toBe(rows);
    expect(maskPairOccupants(lim, rows).map((r) => r.occupiedBy)).toEqual(["unavailable", "same_project", undefined, "unavailable"]);
  });
});

describe("portas", () => {
  const row = (extra: Partial<PortUsageRow>): PortUsageRow => ({
    owner: "project",
    projectId: "a1",
    projectName: "Fazenda",
    container: null,
    service: "web",
    image: null,
    state: null,
    hostIp: null,
    hostPort: 8080,
    containerPort: 80,
    protocol: "tcp",
    source: "live",
    conflict: false,
    conflictWith: null,
    ...extra,
  });
  const response: PortsResponse = {
    docker: true,
    reserved: [80, 443, 2019],
    rows: [
      row({}),
      row({ projectId: "b2", projectName: "Loja", hostPort: 9090 }),
      row({ owner: "panel", projectId: null, projectName: null, hostPort: 443 }),
      row({ owner: "external", projectId: null, projectName: null, hostPort: 22 }),
      row({ conflict: true, conflictWith: "Loja (web)", hostPort: 9090 }),
    ],
  };

  it("humano e painel inteiro veem tudo", () => {
    expect(maskPortsResponse(human, response)).toBe(response);
    expect(maskPortsResponse(wide, response)).toBe(response);
  });

  it("limitado: só linhas dos projetos do alcance, conflito sem dizer com quem, sem portas reservadas", () => {
    const m = maskPortsResponse(lim, response);
    expect(m.reserved).toEqual([]);
    expect(m.rows.map((r) => r.hostPort)).toEqual([8080, 9090]);
    expect(m.rows[1]).toMatchObject({ conflict: true, conflictWith: PORT_UNAVAILABLE });
    expect(JSON.stringify(m)).not.toContain("Loja");
    expect(JSON.stringify(m)).not.toContain("b2");
    expect(m.docker).toBe(true);
  });
});

describe("aba de backup do projeto", () => {
  const view = (rc: Partial<RestoreCheckView>) =>
    ({
      restoreCheck: {
        settings: null,
        last: null,
        unavailableReason: null,
        unavailableCode: null,
        engine: "postgres",
        candidates: [
          { id: "a1", name: "Fazenda", engine: "postgres" },
          { id: "b2", name: "Loja", engine: "postgres" },
        ],
        notice: null,
        ...rc,
      },
      history: [],
    }) as never as { restoreCheck: RestoreCheckView; history: never[] };

  it("humano vê tudo; limitado perde candidatos fora do alcance", () => {
    const v = view({});
    expect(maskProjectBackupView(human, v)).toBe(v);
    expect(maskProjectBackupView(lim, v).restoreCheck.candidates.map((c) => c.id)).toEqual(["a1"]);
  });

  it("destino escolhido fora do alcance: configuração, último resultado e aviso somem; no alcance, ficam", () => {
    const settings = { enabled: true, destinationId: "b2", destinationName: "Loja", frequency: "weekly" } as never;
    const last = { status: "ok" } as never;
    const notice = { code: "destination_renamed", text: "x", at: "y" } as never;
    const out = maskProjectBackupView(lim, view({ settings, last, notice }));
    expect(out.restoreCheck).toMatchObject({ settings: null, last: null, notice: null });
    const inside = maskProjectBackupView(lim, view({ settings: { enabled: true, destinationId: "a1" } as never, last, notice }));
    expect(inside.restoreCheck.settings).not.toBeNull();
    expect(inside.restoreCheck.last).toBe(last);
    expect(inside.restoreCheck.notice).toBe(notice);
  });
});
