/**
 * next-build.ts — Dockerfile gerado, variáveis do build, argumentos do
 * `docker build` e explicação das falhas. Tudo como TEXTO: sem Docker.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NODE_SERVER_IMAGES } from "@paas/core";
import {
  BUILD_LOG_TAIL_CHARS,
  BUILD_VAR_MAX_CHARS,
  MAX_PUBLIC_VARS,
  TailBuffer,
  NEXT_DOCKERFILE_NAME,
  NEXT_DOCKERIGNORE,
  NEXT_HEAP_MAX_MB,
  NEXT_HEAP_MIN_MB,
  explainBuildFailure,
  nextBuildArgs,
  nextHeapMb,
  prepareNextBuild,
  projectBuildKey,
  renderNextDockerfile,
  renderSecretEnv,
  secretFingerprint,
  splitBuildVars,
  type NextDockerfileSpec,
} from "../src/next-build.js";

const KEY = "0123456789abcdef0123456789abcdef";
const SPEC: NextDockerfileSpec = {
  slug: "loja",
  cacheKey: KEY,
  nodeMajor: 22,
  packageManager: "pnpm",
  yarnBerry: false,
  lockfile: true,
  standalone: true,
  hasBuildScript: true,
  heapMb: 1536,
  publicNames: [],
  port: 3000,
};

const render = (over: Partial<NextDockerfileSpec> = {}) => renderNextDockerfile({ ...SPEC, ...over });
const stage = (text: string, name: "build" | "run") => {
  const [, build = "", run = ""] = text.split(/^FROM .* AS (?:build|run)$/m);
  return name === "build" ? build : run;
};

describe("renderNextDockerfile — estrutura", () => {
  it("multi-stage, com a imagem alpine do major fixada por digest nos dois estágios", () => {
    const d = render();
    expect(d.match(/^FROM .*$/gm)).toEqual([`FROM ${NODE_SERVER_IMAGES[22]} AS build`, `FROM ${NODE_SERVER_IMAGES[22]} AS run`]);
    expect(render({ nodeMajor: 20 })).toContain(`FROM ${NODE_SERVER_IMAGES[20]} AS build`);
    expect(render({ nodeMajor: 24 })).toContain(`FROM ${NODE_SERVER_IMAGES[24]} AS run`);
    for (const m of d.matchAll(/^FROM (\S+)/gm)) expect(m[1]).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("imagem final roda como usuário node (não-root) e nunca volta a root", () => {
    const d = render();
    const run = stage(d, "run");
    expect(run).toMatch(/^USER node$/m);
    expect(d).not.toMatch(/USER\s+(root|0)\b/);
    // USER vem depois dos RUN de preparo e antes do CMD
    expect(run.indexOf("USER node")).toBeGreaterThan(run.indexOf("RUN mkdir"));
    expect(run.indexOf("USER node")).toBeLessThan(run.indexOf("CMD"));
  });

  it("padrões de execução: porta 3000, HOSTNAME=0.0.0.0, NODE_ENV=production, telemetria desligada", () => {
    const run = stage(render(), "run");
    expect(run).toContain("ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000");
    expect(run).toContain("EXPOSE 3000");
    expect(stage(render(), "build")).toContain("NEXT_TELEMETRY_DISABLED=1");
  });

  it("a porta pedida aparece no ENV, no EXPOSE e no health check", () => {
    const run = stage(render({ port: 8080 }), "run");
    expect(run).toContain("PORT=8080");
    expect(run).toContain("EXPOSE 8080");
    expect(run).toContain("process.env.PORT||8080");
    expect(run).not.toContain("3000");
  });

  it("health check do container fala com 127.0.0.1 na porta e só reprova 5xx", () => {
    const run = stage(render(), "run");
    expect(run).toMatch(/HEALTHCHECK .*CMD \["node","-e","fetch\('http:\/\/127\.0\.0\.1:'/);
    expect(run).toContain("r.status<500");
    // 3xx conta como vivo e o redirecionamento NÃO é seguido (middleware para https://domínio sairia do container)
    expect(run).toContain("{redirect:'manual'}");
  });

  it("comentário de cabeçalho avisa que não é gravado no repositório", () => {
    expect(render().split("\n")[0]).toContain("NÃO é gravado no seu repositório");
  });
});

describe("renderNextDockerfile — standalone × next start", () => {
  it("standalone: copia .next/standalone, .next/static e public e roda node server.js", () => {
    const run = stage(render({ standalone: true }), "run");
    expect(run).toContain("COPY --from=build /app/.next/standalone ./");
    expect(run).toContain("COPY --from=build /app/.next/static ./.next/static");
    expect(run).toContain("COPY --from=build /app/public ./public");
    expect(run).toContain('CMD ["node","server.js"]');
    expect(run).not.toContain("next start");
  });

  it("standalone: o build confere server.js e falha com mensagem clara", () => {
    const build = stage(render({ standalone: true }), "build");
    expect(build).toContain("test -f .next/standalone/server.js");
    expect(build).toContain("exit 1");
  });

  it("sem standalone: copia o projeto construído e roda next start em 0.0.0.0", () => {
    const d = render({ standalone: false });
    const run = stage(d, "run");
    expect(run).toContain("COPY --from=build /app ./");
    expect(run).toContain('CMD ["node","node_modules/next/dist/bin/next","start","-H","0.0.0.0"]');
    expect(run).not.toContain("server.js");
    expect(stage(d, "build")).not.toContain("test -f .next/standalone");
  });

  it("public existe mesmo se o projeto não tiver a pasta (COPY não falha)", () => {
    expect(stage(render(), "build")).toContain("RUN mkdir -p public");
  });

  it("o código da imagem final é de root (somente leitura para o processo); só .next/cache é do usuário node", () => {
    for (const standalone of [true, false]) {
      const run = stage(render({ standalone }), "run");
      expect(run).not.toContain("--chown");
      expect(run).toContain("RUN mkdir -p .next/cache && chown -R node:node .next/cache");
      expect(run.match(/chown/g)).toHaveLength(1);
    }
  });

  it("o estágio de build deixa tudo legível ao usuário node (arquivo 0600 do repositório)", () => {
    expect(stage(render(), "build")).toContain("RUN chmod -R a+rX /app");
  });
});

describe("renderNextDockerfile — gerenciador de pacotes e lockfile", () => {
  it.each([
    [{ packageManager: "pnpm", lockfile: true }, "pnpm install --frozen-lockfile", "/pnpm-store", "corepack enable"],
    [{ packageManager: "pnpm", lockfile: false }, "pnpm install", "/pnpm-store", "corepack enable"],
    [{ packageManager: "yarn", lockfile: true, yarnBerry: false }, "yarn install --frozen-lockfile", "/yarn-cache", "corepack enable"],
    [{ packageManager: "yarn", lockfile: true, yarnBerry: true }, "yarn install --immutable", "/yarn-cache", "corepack enable"],
    [{ packageManager: "yarn", lockfile: false }, "yarn install", "/yarn-cache", "corepack enable"],
    [{ packageManager: "npm", lockfile: true }, "npm ci --no-audit --no-fund", "/root/.npm", null],
    [{ packageManager: "npm", lockfile: false }, "npm install --no-audit --no-fund", "/root/.npm", null],
  ] as const)("%j", (over, command, cacheTarget, corepack) => {
    const build = stage(render(over), "build");
    expect(build).toContain(`target=${cacheTarget} ${command}\n`);
    if (corepack) expect(build).toContain(`RUN ${corepack}`);
    else expect(build).not.toContain("corepack enable");
  });

  it("instalação sem lockfile NUNCA usa as flags de congelamento (e com lockfile sempre usa)", () => {
    expect(render({ packageManager: "npm", lockfile: false })).not.toContain("npm ci");
    expect(render({ packageManager: "pnpm", lockfile: false })).not.toContain("--frozen-lockfile");
    expect(render({ packageManager: "yarn", lockfile: false })).not.toMatch(/--frozen-lockfile|--immutable/);
  });

  it("o id do cache de dependências leva a chave aleatória do projeto: outro projeto não adivinha o id", () => {
    expect(render({ slug: "loja" })).toContain(`id=paas-loja-pnpm-${KEY},`);
    const outra = "fedcba9876543210fedcba9876543210";
    expect(render({ slug: "blog", packageManager: "npm", cacheKey: outra })).toContain(`id=paas-blog-npm-${outra},`);
    expect(render({ slug: "loja" })).not.toContain(outra);
    expect(render({ slug: "loja" })).not.toMatch(/id=paas-loja-pnpm,/);
  });

  it("o código inteiro é copiado ANTES da instalação (postinstall como prisma generate precisa dele)", () => {
    const build = stage(render(), "build");
    expect(build.indexOf("COPY . .")).toBeGreaterThan(-1);
    expect(build.indexOf("COPY . .")).toBeLessThan(build.indexOf("pnpm install"));
  });

  it.each([
    [{ packageManager: "npm", hasBuildScript: true }, "npm run build"],
    [{ packageManager: "pnpm", hasBuildScript: true }, "pnpm run build"],
    [{ packageManager: "yarn", hasBuildScript: true }, "yarn run build"],
    [{ packageManager: "pnpm", hasBuildScript: false }, "./node_modules/.bin/next build"],
  ] as const)("comando de build %j → %s", (over, cmd) => {
    expect(stage(render(over), "build")).toContain(`set +a && ${cmd}\n`);
  });
});

describe("renderNextDockerfile — variáveis e memória", () => {
  it("NEXT_PUBLIC_ viram ARG+ENV no estágio de build, depois da instalação e antes do next build", () => {
    const d = render({ publicNames: ["NEXT_PUBLIC_B", "NEXT_PUBLIC_A"] });
    const build = stage(d, "build");
    expect(build).toContain("ARG NEXT_PUBLIC_A\nENV NEXT_PUBLIC_A=$NEXT_PUBLIC_A\nARG NEXT_PUBLIC_B\nENV NEXT_PUBLIC_B=$NEXT_PUBLIC_B");
    expect(build.indexOf("pnpm install")).toBeLessThan(build.indexOf("ARG NEXT_PUBLIC_A"));
    expect(build.indexOf("ARG NEXT_PUBLIC_B")).toBeLessThan(build.indexOf("set +a && pnpm run build"));
  });

  it("NEXT_PUBLIC_ NÃO existem no estágio final (nem como ARG nem como ENV): só no bundle", () => {
    const run = stage(render({ publicNames: ["NEXT_PUBLIC_API"] }), "run");
    expect(run).not.toContain("NEXT_PUBLIC_API");
    expect(run).not.toContain("ARG ");
  });

  it("o segredo do build é montado só no RUN do next build (mount=secret), nunca copiado nem ARG", () => {
    const d = render();
    expect(d.match(/--mount=type=secret/g)).toHaveLength(1);
    expect(d).toContain("RUN --mount=type=secret,id=paasenv set -a && . /run/secrets/paasenv && set +a && ");
    expect(d).not.toMatch(/COPY .*paas\.next\.build\.env/);
    // a impressão vira ENV antes do next build (entra na chave de cache: segredo novo = build novo)
    expect(d).toContain("ARG PAAS_BUILD_ENV_HASH\nENV PAAS_BUILD_ENV_HASH=$PAAS_BUILD_ENV_HASH");
    expect(d.indexOf("ENV PAAS_BUILD_ENV_HASH")).toBeLessThan(d.indexOf("--mount=type=secret"));
    expect(stage(d, "run")).not.toContain("PAAS_BUILD_ENV_HASH");
  });

  it("limite de memória do build: NODE_OPTIONS só no estágio de build", () => {
    const d = render({ heapMb: 2048 });
    expect(stage(d, "build")).toContain("ENV NODE_OPTIONS=--max-old-space-size=2048");
    expect(stage(d, "run")).not.toContain("NODE_OPTIONS");
  });

  it("o Dockerfile nunca traz valor de variável: só nomes", () => {
    const d = render({ publicNames: ["NEXT_PUBLIC_API"] });
    expect(d).not.toMatch(/NEXT_PUBLIC_API=[^$]/);
  });
});

describe("renderNextDockerfile — entradas inválidas (injeção)", () => {
  it.each([
    ["slug com quebra de linha", { slug: "a\nUSER root" }],
    ["slug com maiúscula/ponto", { slug: "Loja.x" }],
    ["slug vazio", { slug: "" }],
    ["major sem imagem", { nodeMajor: 18 as unknown as 22 }],
    ["heap absurdo", { heapMb: 1e9 }],
    ["heap fracionário", { heapMb: 1024.5 }],
    ["heap pequeno demais", { heapMb: 10 }],
    ["chave de cache curta", { cacheKey: "abc" }],
    ["chave de cache com injeção", { cacheKey: "0123456789abcdef0123456789abcde\n" }],
    ["porta zero", { port: 0 }],
    ["porta grande", { port: 70000 }],
    ["porta fracionária", { port: 80.5 }],
    ["variável pública com espaço", { publicNames: ["NEXT_PUBLIC_A B"] }],
    ["variável que não é NEXT_PUBLIC_", { publicNames: ["SECRET"] }],
    ["variável com quebra de linha", { publicNames: ["NEXT_PUBLIC_A\nRUN evil"] }],
  ])("%s → lança", (_nome, over) => {
    expect(() => render(over as Partial<NextDockerfileSpec>)).toThrow();
  });
});

describe("splitBuildVars", () => {
  it("separa NEXT_PUBLIC_ (ARG), segredos (BuildKit) e as que ficam de fora", () => {
    const r = splitBuildVars({
      NEXT_PUBLIC_API_URL: "https://api.example.com",
      DATABASE_URL: "postgres://u:p@db/x",
      NODE_ENV: "development",
      PORT: "9999",
      HOSTNAME: "x",
      NODE_OPTIONS: "--inspect",
      PATH: "/evil",
      LD_PRELOAD: "/x.so",
      npm_config_registry: "http://evil",
      "COM ESPACO": "x",
      "1ABC": "x",
      NEXT_PUBLIC_: "vazio",
    });
    expect(r.publicVars).toEqual({ NEXT_PUBLIC_API_URL: "https://api.example.com" });
    expect(r.secretVars).toEqual({ DATABASE_URL: "postgres://u:p@db/x" });
    expect(r.skipped.sort()).toEqual(
      ["1ABC", "COM ESPACO", "HOSTNAME", "LD_PRELOAD", "NEXT_PUBLIC_", "NODE_ENV", "NODE_OPTIONS", "PATH", "PORT", "npm_config_registry"].sort(),
    );
  });

  it("NEXT_PUBLIC_ NUNCA vai ao segredo e segredo NUNCA vira ARG", () => {
    const r = splitBuildVars({ NEXT_PUBLIC_A: "1", SECRET_A: "2", NEXT_PUBLIC_B: "3" });
    expect(Object.keys(r.secretVars)).toEqual(["SECRET_A"]);
    expect(Object.keys(r.publicVars)).toEqual(["NEXT_PUBLIC_A", "NEXT_PUBLIC_B"]);
  });

  it("valor grande demais fica fora; no limite exato entra", () => {
    const r = splitBuildVars({
      GRANDE: "x".repeat(BUILD_VAR_MAX_CHARS + 1),
      NO_LIMITE: "x".repeat(BUILD_VAR_MAX_CHARS),
      NEXT_PUBLIC_GRANDE: "x".repeat(BUILD_VAR_MAX_CHARS + 1),
    });
    expect(Object.keys(r.secretVars)).toEqual(["NO_LIMITE"]);
    expect(r.skipped.sort()).toEqual(["GRANDE", "NEXT_PUBLIC_GRANDE"]);
  });

  it("mais de MAX_PUBLIC_VARS NEXT_PUBLIC_: o excedente fica de fora", () => {
    const vars = Object.fromEntries(Array.from({ length: MAX_PUBLIC_VARS + 3 }, (_, i) => [`NEXT_PUBLIC_V${String(i).padStart(3, "0")}`, "1"]));
    const r = splitBuildVars(vars);
    expect(Object.keys(r.publicVars)).toHaveLength(MAX_PUBLIC_VARS);
    expect(r.skipped).toHaveLength(3);
  });
});

describe("renderSecretEnv / secretFingerprint", () => {
  it("uma linha export por variável, com aspas simples escapadas e sem NUL", () => {
    expect(renderSecretEnv({ A: "um", B: "d'ois", C: "x\0y", D: 'a "b" $c `d` \\e', E: "linha1\nlinha2" })).toBe(
      "export A='um'\nexport B='d'\\''ois'\nexport C='xy'\nexport D='a \"b\" $c `d` \\e'\nexport E='linha1\nlinha2'\n",
    );
    expect(renderSecretEnv({})).toBe("");
  });

  it("o conteúdo gerado é seguro para `.` no shell: valor com $(…) e ; não executa nada", async () => {
    const { execFileSync } = await import("node:child_process");
    const content = renderSecretEnv({ X: "$(echo PWNED); echo PWNED2 `echo PWNED3`", Y: "a'b" });
    const out = execFileSync("sh", ["-c", `${content}printf '%s|%s' "$X" "$Y"`], { encoding: "utf8" });
    expect(out).toBe("$(echo PWNED); echo PWNED2 `echo PWNED3`|a'b");
  });

  it("a impressão é um HMAC com a chave do projeto: muda com o conteúdo e com a chave, tem 16 hex", () => {
    const a = secretFingerprint("export A='1'\n", KEY);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(secretFingerprint("export A='2'\n", KEY)).not.toBe(a);
    expect(secretFingerprint("export A='1'\n", KEY)).toBe(a);
    expect(secretFingerprint("export A='1'\n", "fedcba9876543210fedcba9876543210")).not.toBe(a);
    // não é o sha256 sem sal do conteúdo
    expect(a).not.toBe(createHash("sha256").update("export A='1'\n").digest("hex").slice(0, 16));
  });

  it("a chave do projeto nasce uma vez (0600, fora do código), persiste e é diferente em cada projeto", async () => {
    const um = await mkdtemp(path.join(tmpdir(), "paas-key-"));
    const dois = await mkdtemp(path.join(tmpdir(), "paas-key-"));
    try {
      const k1 = await projectBuildKey(um);
      expect(k1).toMatch(/^[0-9a-f]{32}$/);
      expect(await projectBuildKey(um)).toBe(k1);
      expect((await stat(path.join(um, "paas.next.cache-key"))).mode & 0o777).toBe(0o600);
      expect(await projectBuildKey(dois)).not.toBe(k1);
      // arquivo corrompido ou link: nasce outra, nunca segue o link
      await writeFile(path.join(um, "paas.next.cache-key"), "lixo");
      const k3 = await projectBuildKey(um);
      expect(k3).toMatch(/^[0-9a-f]{32}$/);
      expect(k3).not.toBe(k1);
      const alvo = path.join(dois, "alvo.txt");
      await writeFile(alvo, "intacto");
      await rm(path.join(um, "paas.next.cache-key"));
      await symlink(alvo, path.join(um, "paas.next.cache-key"));
      expect(await projectBuildKey(um)).toMatch(/^[0-9a-f]{32}$/);
      expect(await readFile(alvo, "utf8")).toBe("intacto");
    } finally {
      await rm(um, { recursive: true, force: true });
      await rm(dois, { recursive: true, force: true });
    }
  });
});

describe("nextHeapMb", () => {
  const GB = 1024 ** 3;
  it("60% da RAM entre o piso e o teto", () => {
    expect(nextHeapMb(1 * GB)).toBe(NEXT_HEAP_MIN_MB);
    expect(nextHeapMb(2 * GB)).toBe(1229);
    expect(nextHeapMb(4 * GB)).toBe(2458);
    expect(nextHeapMb(6 * GB)).toBe(3686);
    expect(nextHeapMb(8 * GB)).toBe(NEXT_HEAP_MAX_MB);
    expect(nextHeapMb(64 * GB)).toBe(NEXT_HEAP_MAX_MB);
  });
  it("valor absurdo cai no piso", () => {
    expect(nextHeapMb(Number.NaN)).toBe(NEXT_HEAP_MIN_MB);
    expect(nextHeapMb(-5)).toBe(NEXT_HEAP_MIN_MB);
    expect(nextHeapMb(0)).toBe(NEXT_HEAP_MIN_MB);
  });
});

describe("nextBuildArgs", () => {
  const base = {
    image: "paas-loja:latest",
    slug: "loja",
    dockerfile: "/work/paas.next.Dockerfile",
    secretFile: "/work/paas.next.build.env",
    context: "/work/src",
    publicVars: { NEXT_PUBLIC_API: "https://api.example.com" },
    fingerprint: "abcd",
  };
  it("argv completo: -f fora do contexto, rótulos do painel, segredo por arquivo, ARGs só públicos", () => {
    const a = nextBuildArgs(base);
    expect(a.slice(0, 7)).toEqual(["build", "--progress=plain", "-f", "/work/paas.next.Dockerfile", "-t", "paas-loja:latest", "--label"]);
    expect(a).toContain("paas.managed=true");
    expect(a).toContain("paas.project=loja");
    expect(a).toContain("id=paasenv,src=/work/paas.next.build.env");
    expect(a).toContain("NEXT_PUBLIC_API=https://api.example.com");
    expect(a).toContain("PAAS_BUILD_ENV_HASH=abcd");
    expect(a.at(-1)).toBe("/work/src");
    expect(a).not.toContain("--no-cache");
  });
});

describe("prepareNextBuild (arquivos reais em pasta temporária)", () => {
  let root: string;
  let workDir: string;
  let src: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "paas-next-build-"));
    workDir = path.join(root, "work");
    src = path.join(workDir, "src");
    await mkdir(src, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const input = (over: Record<string, unknown> = {}) => ({
    ...SPEC,
    workDir,
    src,
    image: "paas-loja:latest",
    vars: { NEXT_PUBLIC_API: "https://api.example.com", DATABASE_URL: "postgres://u:senha-super-secreta@db/x", NODE_ENV: "x" },
    totalMemBytes: 4 * 1024 ** 3,
    ...over,
  });

  it("grava Dockerfile e .dockerignore ao lado dele, fora do src, e o segredo com 0600", async () => {
    const p = await prepareNextBuild(input());
    expect(p.dockerfile).toBe(path.join(workDir, NEXT_DOCKERFILE_NAME));
    expect(await readFile(p.dockerfile, "utf8")).toContain("FROM node:22-alpine@sha256:");
    expect(await readFile(`${p.dockerfile}.dockerignore`, "utf8")).toBe(NEXT_DOCKERIGNORE);
    const secretFile = path.join(workDir, "paas.next.build.env");
    expect((await stat(secretFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(secretFile, "utf8")).toBe("export DATABASE_URL='postgres://u:senha-super-secreta@db/x'\n");
    // nada no src do usuário
    expect(existsSync(path.join(src, NEXT_DOCKERFILE_NAME))).toBe(false);
    expect(existsSync(path.join(src, "Dockerfile"))).toBe(false);
  });

  it("NEXT_PUBLIC_ vão como --build-arg e como ARG; o segredo NÃO aparece em argv, Dockerfile nem notas", async () => {
    const p = await prepareNextBuild(input());
    expect(p.args).toContain("NEXT_PUBLIC_API=https://api.example.com");
    expect(await readFile(p.dockerfile, "utf8")).toContain("ARG NEXT_PUBLIC_API");
    const tudo = [...p.args, await readFile(p.dockerfile, "utf8"), ...p.notes].join("\n");
    expect(tudo).not.toContain("senha-super-secreta");
    expect(tudo).not.toContain("postgres://");
  });

  it("notas listam só NOMES: heap, públicas, segredos e as de fora", async () => {
    const notes = (await prepareNextBuild(input())).notes.join("\n");
    expect(notes).toContain("Heap do next build: 2458 MB POR PROCESSO");
    expect(notes).toContain("não é um teto de memória total");
    expect(notes).toContain("NEXT_PUBLIC_ no build");
    expect(notes).toContain("NEXT_PUBLIC_API");
    expect(notes).toContain("por segredo do BuildKit");
    expect(notes).toContain("DATABASE_URL");
    expect(notes).toContain("Fora do build");
    expect(notes).toContain("NODE_ENV");
  });

  it("sem variáveis: segredo vazio, aviso de que não há NEXT_PUBLIC_", async () => {
    const p = await prepareNextBuild(input({ vars: {} }));
    expect(await readFile(path.join(workDir, "paas.next.build.env"), "utf8")).toBe("");
    expect(p.notes.join("\n")).toContain("Nenhuma NEXT_PUBLIC_");
    expect(p.notes.join("\n")).not.toContain("por segredo do BuildKit");
  });

  it("o cache usa a chave do projeto gravada na pasta de trabalho (id imprevisível) e é estável entre builds", async () => {
    const a = await prepareNextBuild(input());
    const key = (await readFile(path.join(workDir, "paas.next.cache-key"), "utf8")).trim();
    expect(await readFile(a.dockerfile, "utf8")).toContain(`id=paas-loja-pnpm-${key},`);
    const b = await prepareNextBuild(input());
    expect(await readFile(b.dockerfile, "utf8")).toContain(`id=paas-loja-pnpm-${key},`);
    expect(existsSync(path.join(src, "paas.next.cache-key"))).toBe(false);
  });

  it(".dockerignore nunca deixa .env nem .git entrarem no contexto do build", async () => {
    const lista = NEXT_DOCKERIGNORE.split("\n");
    for (const padrao of [".env", "**/.env", ".env.*", "**/.env.*", ".git", "**/.git", "node_modules", ".next"]) {
      expect(lista, padrao).toContain(padrao);
    }
    await prepareNextBuild(input());
    expect(await readFile(path.join(workDir, `${NEXT_DOCKERFILE_NAME}.dockerignore`), "utf8")).toContain("\n.env\n");
  });

  it("a impressão do segredo muda quando o valor muda (cache não fica velho)", async () => {
    const a = (await prepareNextBuild(input({ vars: { K: "1" } }))).args.find((x) => x.startsWith("PAAS_BUILD_ENV_HASH="));
    const b = (await prepareNextBuild(input({ vars: { K: "2" } }))).args.find((x) => x.startsWith("PAAS_BUILD_ENV_HASH="));
    expect(a).not.toBe(b);
  });

  it("cleanup apaga o segredo e pode ser chamado de novo", async () => {
    const p = await prepareNextBuild(input());
    const secretFile = path.join(workDir, "paas.next.build.env");
    expect(existsSync(secretFile)).toBe(true);
    await p.cleanup();
    expect(existsSync(secretFile)).toBe(false);
    await expect(p.cleanup()).resolves.toBeUndefined();
  });

  it("pasta de trabalho dentro do código do usuário: recusa e não grava nada", async () => {
    const inner = path.join(src, ".paas");
    await expect(prepareNextBuild(input({ workDir: inner }))).rejects.toThrow(/dentro do código do projeto/);
    expect(existsSync(inner)).toBe(false);
    await expect(prepareNextBuild(input({ workDir: src }))).rejects.toThrow(/dentro do código/);
  });

  it("link simbólico plantado no nome do Dockerfile é substituído, nunca seguido", async () => {
    const alvo = path.join(root, "alvo-do-usuario.txt");
    await writeFile(alvo, "intacto");
    await symlink(alvo, path.join(workDir, NEXT_DOCKERFILE_NAME));
    await symlink(alvo, path.join(workDir, "paas.next.build.env"));
    await prepareNextBuild(input());
    expect(await readFile(alvo, "utf8")).toBe("intacto");
  });

  it("slug inválido não grava nada", async () => {
    await expect(prepareNextBuild(input({ slug: "A/../b" }))).rejects.toThrow(/slug inválido/);
    expect(existsSync(path.join(workDir, "paas.next.build.env"))).toBe(false);
  });
});

describe("explainBuildFailure", () => {
  const ctx = { heapMb: 1229, packageManager: "pnpm" as const };

  it.each([
    "<--- Last few GCs --->\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    "ERROR: process \"/bin/sh -c pnpm run build\" did not complete successfully: exit code: 137",
    " ⨯ Next.js build worker exited with code: null and signal: SIGKILL",
    "sh: line 1:    42 Killed                  next build",
    "ENOMEM: not enough memory",
    "failed to solve: signal: killed",
    "fork: Cannot allocate memory",
  ])("falta de memória: %s", (log) => {
    const r = explainBuildFailure(log, ctx);
    expect(r?.kind).toBe("oom");
    expect(r?.message).toContain("sem memória");
    expect(r?.message).toContain("1229 MB por processo");
    expect(r?.message).toContain("swap");
    expect(r?.message).toContain("experimental.cpus");
  });

  it.each([
    ' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date',
    "npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.",
    "error Your lockfile needs to be updated, but yarn was run with `--frozen-lockfile`.",
    "➤ YN0028: The lockfile would have been modified by this install, which is explicitly forbidden.",
  ])("lockfile fora de sincronia: %s", (log) => {
    const r = explainBuildFailure(log, { heapMb: 1, packageManager: "yarn" });
    expect(r?.kind).toBe("lockfile");
    expect(r?.message).toContain('"yarn install"');
  });

  it("standalone ausente", () => {
    const r = explainBuildFailure("[TWS Panel] ... o build nao gerou .next/standalone/server.js (em monorepo ...)", ctx);
    expect(r?.kind).toBe("standalone");
    expect(r?.message).toContain("Dockerfile seu");
  });

  it("o texto do próprio Dockerfile gerado é reconhecido (marcador compartilhado)", () => {
    const text = render({ standalone: true });
    expect(explainBuildFailure(text, ctx)?.kind).toBe("standalone");
  });

  it("falha sem padrão conhecido → null; só o fim do log (200 KB) é lido", () => {
    expect(explainBuildFailure("Module not found: Can't resolve './x'", ctx)).toBeNull();
    expect(explainBuildFailure("JavaScript heap out of memory" + "a".repeat(250_000), ctx)).toBeNull();
    expect(explainBuildFailure("a".repeat(250_000) + "JavaScript heap out of memory", ctx)?.kind).toBe("oom");
  });

  it("log hostil de vários MB é lido em tempo curto", () => {
    const t0 = performance.now();
    explainBuildFailure("K".repeat(8_000_000), ctx);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("TailBuffer", () => {
  it("guarda tudo enquanto cabe e só o fim quando passa do limite", () => {
    const t = new TailBuffer(10);
    t.push("abc");
    t.push("def");
    expect(t.toString()).toBe("abcdef");
    t.push("ghijkl");
    expect(t.toString()).toBe("cdefghijkl");
    for (let i = 0; i < 100; i++) t.push("0123456789");
    t.push("FIM");
    expect(t.toString()).toBe("3456789FIM");
    expect(t.toString().length).toBe(10);
  });

  it("padrão: 200 KB; milhares de pedaços não estouram a memória", () => {
    const t = new TailBuffer();
    for (let i = 0; i < 20_000; i++) t.push("linha de log do build ".repeat(10) + "\n");
    expect(t.toString().length).toBe(BUILD_LOG_TAIL_CHARS);
  });
});
