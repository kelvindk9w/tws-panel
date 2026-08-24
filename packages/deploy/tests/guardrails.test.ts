/**
 * Testes dos guardrails de análise de compose (guardrails.ts): parsing das
 * formas curta/longa de portas, regras de banco exposto / serviço de dev /
 * credenciais fracas, e a heurística de alvo do proxy.
 *
 * Cada regra tem: caso que dispara, caso que NÃO dispara e edge case.
 */
import { describe, expect, it } from "vitest";
import { analyzeCompose, guessProxyTarget, servicesWithCustomNetworks } from "../src/guardrails.js";

function compose(body: string): string {
  return `services:\n${body}\n`;
}

describe("analyzeCompose — compose.db-port-exposed", () => {
  it("dispara quando a porta do PostgreSQL é publicada no host", () => {
    const warnings = analyzeCompose(
      compose('  db:\n    image: postgres:16\n    ports: ["5432:5432"]'),
      "compose.yml",
    );
    const hit = warnings.find((w) => w.id === "compose.db-port-exposed");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("critical");
    expect(hit?.service).toBe("db");
    expect(hit?.message).toContain("PostgreSQL");
  });

  it("detecta as demais portas de banco conhecidas", () => {
    const warnings = analyzeCompose(
      compose(
        [
          "  mysql:\n    image: mysql:8\n    ports: [\"3306:3306\"]",
          "  redis:\n    image: redis:7\n    ports: [\"6379:6379\"]",
          "  mongo:\n    image: mongo:7\n    ports: [\"27017:27017\"]",
        ].join("\n"),
      ),
      "compose.yml",
    );
    expect(warnings.filter((w) => w.id === "compose.db-port-exposed")).toHaveLength(3);
  });

  it("NÃO dispara quando o banco só usa expose (rede interna)", () => {
    const warnings = analyzeCompose(
      compose("  db:\n    image: postgres:16\n    expose: [\"5432\"]"),
      "compose.yml",
    );
    expect(warnings.filter((w) => w.id === "compose.db-port-exposed")).toHaveLength(0);
  });

  it("NÃO dispara quando a porta publicada é de aplicação (não-banco)", () => {
    const warnings = analyzeCompose(
      compose('  web:\n    image: nginx\n    ports: ["8080:80"]'),
      "compose.yml",
    );
    expect(warnings.filter((w) => w.id === "compose.db-port-exposed")).toHaveLength(0);
  });

  it("edge: publicar 15432:5432 no host ainda expõe o banco (container 5432)", () => {
    const warnings = analyzeCompose(
      compose('  db:\n    image: postgres:16\n    ports: ["15432:5432"]'),
      "compose.yml",
    );
    expect(warnings.some((w) => w.id === "compose.db-port-exposed")).toBe(true);
  });

  it("edge: forma longa (target/published) também é detectada", () => {
    const warnings = analyzeCompose(
      compose(
        "  db:\n    image: postgres:16\n    ports:\n      - target: 5432\n        published: 5432\n        protocol: tcp",
      ),
      "compose.yml",
    );
    expect(warnings.some((w) => w.id === "compose.db-port-exposed")).toBe(true);
  });

  it("edge: forma com IP do host (127.0.0.1:5432:5432) é detectada", () => {
    const warnings = analyzeCompose(
      compose('  db:\n    image: postgres:16\n    ports: ["127.0.0.1:5432:5432"]'),
      "compose.yml",
    );
    expect(warnings.some((w) => w.id === "compose.db-port-exposed")).toBe(true);
  });

  it("edge: sufixo de protocolo (/udp) é tolerado no parsing", () => {
    const warnings = analyzeCompose(
      compose('  svc:\n    image: app\n    ports: ["5353:5353/udp"]'),
      "compose.yml",
    );
    // 5353 não é porta de banco — só valida que o parse não quebra nem acusa falso positivo
    expect(warnings).toHaveLength(0);
  });
});

describe("analyzeCompose — compose.dev-service", () => {
  it("dispara para Mailhog em produção (caso real cachetaGrok)", () => {
    const warnings = analyzeCompose(
      compose('  mail:\n    image: mailhog/mailhog:latest\n    ports: ["8025:8025"]'),
      "compose.yml",
    );
    const hit = warnings.find((w) => w.id === "compose.dev-service");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("warning");
    expect(hit?.message).toContain("Mailhog");
  });

  it("reconhece mailpit, phpmyadmin, adminer e pgadmin", () => {
    for (const image of ["mailpit/mailpit", "phpmyadmin/phpmyadmin", "adminer", "dpage/pgadmin4"]) {
      const warnings = analyzeCompose(compose(`  dev:\n    image: ${image}`), "compose.yml");
      expect(warnings.some((w) => w.id === "compose.dev-service"), image).toBe(true);
    }
  });

  it("NÃO dispara para imagens de produção comuns", () => {
    const warnings = analyzeCompose(
      compose("  web:\n    image: nginx:1.27\n  db:\n    image: postgres:16"),
      "compose.yml",
    );
    expect(warnings.filter((w) => w.id === "compose.dev-service")).toHaveLength(0);
  });
});

describe("analyzeCompose — compose.weak-credentials", () => {
  it("dispara para senha trivial (POSTGRES_PASSWORD=cacheta, caso real)", () => {
    const warnings = analyzeCompose(
      compose("  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: cacheta"),
      "compose.yml",
    );
    const hit = warnings.find((w) => w.id === "compose.weak-credentials");
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("POSTGRES_PASSWORD");
  });

  it("dispara para valor muito curto (< 6 chars) em chave sensível", () => {
    const warnings = analyzeCompose(
      compose('  app:\n    image: app\n    environment: ["API_KEY=abc12"]'),
      "compose.yml",
    );
    expect(warnings.some((w) => w.id === "compose.weak-credentials")).toBe(true);
  });

  it("dispara para par usuário:senha iguais num único valor", () => {
    const warnings = analyzeCompose(
      compose("  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: cacheta:cacheta"),
      "compose.yml",
    );
    expect(warnings.some((w) => w.id === "compose.weak-credentials")).toBe(true);
  });

  it("NÃO dispara para senha forte", () => {
    const warnings = analyzeCompose(
      compose("  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: x9$Kv2mQpL8wZrT4uYbN7sA"),
      "compose.yml",
    );
    expect(warnings.filter((w) => w.id === "compose.weak-credentials")).toHaveLength(0);
  });

  it("NÃO dispara para valor fraco em chave não-sensível", () => {
    const warnings = analyzeCompose(
      compose("  app:\n    image: app\n    environment:\n      LOG_LEVEL: dev"),
      "compose.yml",
    );
    expect(warnings.filter((w) => w.id === "compose.weak-credentials")).toHaveLength(0);
  });

  it("edge: variável sem valor (null) não dispara", () => {
    const warnings = analyzeCompose(
      compose('  app:\n    image: app\n    environment: ["APP_SECRET"]'),
      "compose.yml",
    );
    expect(warnings.filter((w) => w.id === "compose.weak-credentials")).toHaveLength(0);
  });

  it("edge: suporta environment como mapa e como lista", () => {
    const asMap = analyzeCompose(
      compose("  a:\n    image: x\n    environment:\n      DB_PASSWORD: \"123456\""),
      "compose.yml",
    );
    const asList = analyzeCompose(
      compose('  a:\n    image: x\n    environment: ["DB_PASSWORD=123456"]'),
      "compose.yml",
    );
    expect(asMap.some((w) => w.id === "compose.weak-credentials")).toBe(true);
    expect(asList.some((w) => w.id === "compose.weak-credentials")).toBe(true);
  });

  it("edge: valor null explícito no mapa de environment não dispara", () => {
    const warnings = analyzeCompose(
      compose("  a:\n    image: x\n    environment:\n      DB_PASSWORD:"),
      "compose.yml",
    );
    expect(warnings.filter((w) => w.id === "compose.weak-credentials")).toHaveLength(0);
  });

  it("edge: serviço sem image é analisado normalmente (sem dev-service)", () => {
    const warnings = analyzeCompose(
      compose('  app:\n    ports: ["8080:8080"]'),
      "compose.yml",
    );
    expect(warnings.filter((w) => w.id === "compose.dev-service")).toHaveLength(0);
  });
});

describe("analyzeCompose — compose.privileged-container (convergência com rules.ts)", () => {
  // Bug: guardrails.ts (preview do wizard/detecção) não tinha a regra de
  // container privilegiado que rules.ts (bloqueio real do deploy) já tem.
  // Resultado: um compose com `privileged: true` passava limpo na tela de
  // detecção e só era barrado depois, no deploy — surpresa desagradável.
  // A regra deve vir da MESMA lógica de rules.ts (sem duplicar), reutilizada
  // aqui como um aviso "critical" no preview.
  it("dispara quando um serviço define privileged: true", () => {
    const warnings = analyzeCompose(
      compose("  app:\n    image: app\n    privileged: true"),
      "compose.yml",
    );
    const hit = warnings.find((w) => w.id === "compose.privileged-container");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("critical");
    expect(hit?.service).toBe("app");
  });

  it("dispara quando um serviço monta /var/run/docker.sock", () => {
    const warnings = analyzeCompose(
      compose(
        '  app:\n    image: app\n    volumes:\n      - "/var/run/docker.sock:/var/run/docker.sock"',
      ),
      "compose.yml",
    );
    const hit = warnings.find((w) => w.id === "compose.privileged-container");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("critical");
  });

  it("NÃO dispara para um serviço comum, sem privileged nem docker.sock", () => {
    const warnings = analyzeCompose(
      compose('  app:\n    image: app\n    volumes:\n      - "app-data:/data"'),
      "compose.yml",
    );
    expect(warnings.filter((w) => w.id === "compose.privileged-container")).toHaveLength(0);
  });

  it("edge: privileged: false não dispara", () => {
    const warnings = analyzeCompose(
      compose("  app:\n    image: app\n    privileged: false"),
      "compose.yml",
    );
    expect(warnings.filter((w) => w.id === "compose.privileged-container")).toHaveLength(0);
  });
});

describe("analyzeCompose — casos gerais", () => {
  it("compose sem serviços gera info compose.no-services", () => {
    const warnings = analyzeCompose("services: {}\n", "compose.yml");
    expect(warnings).toEqual([
      expect.objectContaining({ id: "compose.no-services", severity: "info" }),
    ]);
  });

  it("arquivo sem a chave services também gera compose.no-services", () => {
    const warnings = analyzeCompose("name: projeto-sem-services\n", "compose.yml");
    expect(warnings).toEqual([
      expect.objectContaining({ id: "compose.no-services", severity: "info" }),
    ]);
  });

  it("YAML inválido lança erro (o chamador converte em warning crítico)", () => {
    expect(() => analyzeCompose("services: [unclosed\n", "compose.yml")).toThrow();
  });
});

describe("guessProxyTarget", () => {
  it("prioriza serviço com nome de proxy web (nginx) e sua porta web", () => {
    const target = guessProxyTarget(
      compose('  worker:\n    image: app\n  nginx:\n    image: nginx\n    ports: ["8080:80"]'),
    );
    expect(target.service).toBe("nginx");
    expect(target.port).toBe(80);
  });

  it("reconhece imagem de proxy (caddy/traefik) mesmo com nome genérico", () => {
    const target = guessProxyTarget(
      compose('  entrada:\n    image: caddy:2\n    ports: ["443:443"]\n  app:\n    image: app'),
    );
    expect(target.service).toBe("entrada");
    expect(target.port).toBe(443);
  });

  it("sem proxy nomeado, usa quem publica porta web", () => {
    const target = guessProxyTarget(
      compose('  api:\n    image: app\n    ports: ["3000:3000"]\n  db:\n    image: postgres:16'),
    );
    expect(target.service).toBe("api");
    expect(target.port).toBe(3000);
  });

  it("fallback: primeiro serviço com expose", () => {
    const target = guessProxyTarget(
      compose('  api:\n    image: app\n    expose: ["9000"]\n  db:\n    image: postgres:16'),
    );
    expect(target.service).toBe("api");
    expect(target.port).toBe(9000);
  });

  it("sem pista nenhuma: porta null e nota de configuração manual", () => {
    const target = guessProxyTarget(compose("  db:\n    image: postgres:16"));
    expect(target.port).toBeNull();
    expect(target.notes.join(" ")).toContain("manualmente");
  });

  it("edge: YAML inválido retorna nulos sem lançar", () => {
    const target = guessProxyTarget("services: [unclosed\n");
    expect(target).toEqual({ service: null, port: null, notes: [] });
  });

  it("edge: compose vazio retorna nulos", () => {
    const target = guessProxyTarget("services: {}\n");
    expect(target).toEqual({ service: null, port: null, notes: [] });
  });

  it("edge: sem a chave services retorna nulos", () => {
    const target = guessProxyTarget("name: vazio\n");
    expect(target).toEqual({ service: null, port: null, notes: [] });
  });

  it("proxy nomeado sem ports: assume porta 80 com nota explicativa", () => {
    const target = guessProxyTarget(compose("  caddy:\n    image: caddy:2"));
    expect(target.service).toBe("caddy");
    expect(target.port).toBe(80);
    expect(target.notes.join(" ")).toContain("entrada web");
  });

  it("proxy nomeado com porta não-web publicada: usa a primeira porta", () => {
    const target = guessProxyTarget(
      compose('  caddy:\n    image: caddy:2\n    ports: ["2019:2019"]'),
    );
    expect(target.service).toBe("caddy");
    expect(target.port).toBe(2019);
  });

  it("serviço nulo (chave sem corpo) é ignorado na busca pela porta web", () => {
    const target = guessProxyTarget(
      compose('  legado:\n  api:\n    image: app\n    ports: ["3000:3000"]'),
    );
    expect(target.service).toBe("api");
    expect(target.port).toBe(3000);
  });

  it("serviço sem image não é confundido com proxy na prioridade 1", () => {
    const target = guessProxyTarget(
      compose('  entrada:\n    ports: ["9000:9000"]\n  worker:\n    image: app'),
    );
    // "entrada" não é nome de proxy e não tem image → regra 1 não casa; 9000 não
    // é porta web (regra 2) e não há expose (regra 3) → fallback manual
    expect(target.service).toBe("entrada");
    expect(target.port).toBeNull();
  });
});

describe("servicesWithCustomNetworks", () => {
  it("lista apenas serviços que definem networks próprias", () => {
    const names = servicesWithCustomNetworks(
      compose("  app:\n    image: x\n    networks: [front]\n  db:\n    image: postgres:16"),
    );
    expect(names).toEqual(["app"]);
  });

  it("YAML inválido → lista vazia sem lançar", () => {
    expect(servicesWithCustomNetworks("services: [unclosed\n")).toEqual([]);
  });

  it("sem a chave services → lista vazia", () => {
    expect(servicesWithCustomNetworks("name: vazio\n")).toEqual([]);
  });

  it("serviço nulo (chave sem corpo) é ignorado", () => {
    expect(
      servicesWithCustomNetworks(compose("  legado:\n  app:\n    image: x\n    networks: [front]")),
    ).toEqual(["app"]);
  });
});
