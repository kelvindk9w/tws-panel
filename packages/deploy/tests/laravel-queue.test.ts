import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  QUEUE_WORKER_RE,
  effectiveSetting,
  hasQueueWorker,
  laravelNotices,
  queueWithoutWorker,
  readLaravelDefaults,
  silentMailer,
  type LaravelFacts,
} from "../src/laravel-queue.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-laravel-queue-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const facts = (env: Record<string, string>, over: Partial<LaravelFacts> = {}): LaravelFacts => ({
  env,
  defaults: { queue: null, mail: null, log: null },
  hasWorker: false,
  ...over,
});

describe("QUEUE_WORKER_RE", () => {
  it.each(["php artisan queue:work --tries=3", "php artisan queue:listen", "php artisan horizon", "command: [\"php\",\"artisan\",\"queue:work\"]"])(
    "reconhece %s",
    (text) => expect(QUEUE_WORKER_RE.test(text)).toBe(true),
  );
  it.each(["php artisan queue:retry all", "php artisan serve", "queue:workers-docs"])("não reconhece %s", (text) =>
    expect(QUEUE_WORKER_RE.test(text)).toBe(false),
  );
});

describe("hasQueueWorker", () => {
  it("acha o worker no comando de um serviço do compose", async () => {
    await writeFile(path.join(dir, "docker-compose.yml"), "services:\n  worker:\n    image: app\n    command: php artisan queue:work --sleep=3\n");
    expect(await hasQueueWorker(dir, "docker-compose.yml")).toBe(true);
  });

  it("acha o worker em supervisor, Dockerfile e scripts de pastas conhecidas", async () => {
    await mkdir(path.join(dir, "docker"));
    await writeFile(path.join(dir, "docker", "supervisord.conf"), "[program:w]\ncommand=php artisan horizon\n");
    expect(await hasQueueWorker(dir, null)).toBe(true);
  });

  it("acha no Dockerfile da raiz e em start.sh", async () => {
    await writeFile(path.join(dir, "Dockerfile"), "FROM php\nCMD php artisan queue:listen\n");
    expect(await hasQueueWorker(dir, null)).toBe(true);
  });

  it("composer.json (script dev do esqueleto) NÃO conta", async () => {
    await writeFile(path.join(dir, "composer.json"), '{"scripts":{"dev":"php artisan queue:listen"}}');
    await writeFile(path.join(dir, "docker-compose.yml"), "services:\n  app:\n    image: app\n    command: php artisan serve\n");
    expect(await hasQueueWorker(dir, "docker-compose.yml")).toBe(false);
  });

  it("projeto vazio, arquivo grande demais e compose ausente", async () => {
    expect(await hasQueueWorker(dir, "nao-existe.yml")).toBe(false);
    await writeFile(path.join(dir, "start.sh"), "x".repeat(300 * 1024) + "\nphp artisan queue:work");
    expect(await hasQueueWorker(dir, null)).toBe(false);
  });

  it("não lê além do limite de arquivos", async () => {
    for (let i = 0; i < 70; i++) await writeFile(path.join(dir, `a${String(i).padStart(2, "0")}.sh`), "echo ok");
    await writeFile(path.join(dir, "zzz.sh"), "php artisan queue:work");
    expect(await hasQueueWorker(dir, null)).toBe(false);
  });
});

describe("readLaravelDefaults", () => {
  it("lê os padrões dos arquivos de configuração", async () => {
    await mkdir(path.join(dir, "config"));
    await writeFile(path.join(dir, "config", "queue.php"), "'default' => env('QUEUE_CONNECTION', 'database'),");
    await writeFile(path.join(dir, "config", "mail.php"), "'default' => env(\"MAIL_MAILER\", \"log\"),");
    await writeFile(path.join(dir, "config", "logging.php"), "'default' => env('LOG_CHANNEL', 'stack'),");
    expect(await readLaravelDefaults(dir)).toEqual({ queue: "database", mail: "log", log: "stack" });
  });

  it("arquivo ausente ou em outro formato: null (nada é afirmado)", async () => {
    await mkdir(path.join(dir, "config"));
    await writeFile(path.join(dir, "config", "queue.php"), "'default' => config_value(),");
    expect(await readLaravelDefaults(dir)).toEqual({ queue: null, mail: null, log: null });
  });
});

describe("queueWithoutWorker", () => {
  it("explícito e diferente de sync, sem worker: avisa", () => {
    expect(queueWithoutWorker(facts({ QUEUE_CONNECTION: "redis" }))).toBe(true);
    expect(queueWithoutWorker(facts({ QUEUE_CONNECTION: " Database " }))).toBe(true);
  });
  it("com worker, sync ou null: não avisa", () => {
    expect(queueWithoutWorker(facts({ QUEUE_CONNECTION: "redis" }, { hasWorker: true }))).toBe(false);
    expect(queueWithoutWorker(facts({ QUEUE_CONNECTION: "sync" }))).toBe(false);
    expect(queueWithoutWorker(facts({ QUEUE_CONNECTION: "null" }))).toBe(false);
  });
  it("sem a variável: vale o padrão do projeto, só se for conhecido", () => {
    const db = { queue: "database", mail: null, log: null };
    expect(queueWithoutWorker(facts({}, { defaults: db }))).toBe(true);
    expect(queueWithoutWorker(facts({}, { defaults: { ...db, queue: "sync" } }))).toBe(false);
    expect(queueWithoutWorker(facts({}))).toBe(false);
    expect(queueWithoutWorker(facts({ QUEUE_CONNECTION: "  " }, { defaults: db }))).toBe(true);
  });
});

describe("silentMailer", () => {
  it("log e array, explícitos ou pelo padrão do projeto", () => {
    expect(silentMailer(facts({ MAIL_MAILER: "log" }))).toBe("log");
    expect(silentMailer(facts({ MAIL_MAILER: "ARRAY" }))).toBe("array");
    expect(silentMailer(facts({}, { defaults: { queue: null, mail: "log", log: null } }))).toBe("log");
  });
  it("smtp, desconhecido e variável vence o padrão", () => {
    expect(silentMailer(facts({ MAIL_MAILER: "smtp" }))).toBeNull();
    expect(silentMailer(facts({}))).toBeNull();
    expect(silentMailer(facts({ MAIL_MAILER: "smtp" }, { defaults: { queue: null, mail: "log", log: null } }))).toBeNull();
  });
});

describe("effectiveSetting", () => {
  it("variável, senão padrão", () => {
    expect(effectiveSetting(facts({ A: "x" }), "A", "y")).toBe("x");
    expect(effectiveSetting(facts({}), "A", "y")).toBe("y");
  });
});

describe("laravelNotices", () => {
  it("fila sem worker é aviso; LOG_CHANNEL é só informação", () => {
    expect(laravelNotices(facts({ QUEUE_CONNECTION: "database" }))).toEqual([
      { code: "queue_no_worker", severity: "warning" },
      { code: "log_channel_stderr", severity: "info" },
    ]);
  });
  it("LOG_CHANNEL ou LOG_STACK definido, ou padrão que já vai para stderr: sem sugestão", () => {
    expect(laravelNotices(facts({ LOG_CHANNEL: "stderr" }))).toEqual([]);
    expect(laravelNotices(facts({ LOG_STACK: "single,stderr" }))).toEqual([]);
    expect(laravelNotices(facts({}, { defaults: { queue: null, mail: null, log: "stderr" } }))).toEqual([]);
    expect(laravelNotices(facts({}, { defaults: { queue: null, mail: null, log: "errorlog" } }))).toEqual([]);
  });
  it("sem nada a dizer sobre a fila", () => {
    expect(laravelNotices(facts({ QUEUE_CONNECTION: "sync", LOG_CHANNEL: "stack" }))).toEqual([]);
  });
});
