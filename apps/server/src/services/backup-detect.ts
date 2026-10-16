/**
 * backup-detect.ts — o que entra no backup de um projeto (funções puras).
 *
 * Lê a saída do `docker inspect` e do `docker diff` dos containers do projeto
 * (quem roda os comandos é backup-docker.ts) e monta a lista da aba Backups:
 *  - bancos pela IMAGEM do serviço (postgres, mysql, mariadb, mongo; redis
 *    aparece desmarcado). Usuário e nome do banco vêm do ambiente do
 *    container; a senha nunca sai daqui — o dump roda DENTRO do container,
 *    que já tem as variáveis (POSTGRES_PASSWORD, MYSQL_ROOT_PASSWORD…);
 *  - volumes nomeados e pastas montadas, com o tamanho. A pasta de dados de
 *    um banco aparece como "coberta pelo dump". Vêm marcadas as que parecem
 *    guardar arquivos dos usuários (uploads, storage, media, dados…);
 *  - o aviso de arquivos gravados FORA de volume (somem a cada deploy).
 */
import type {
  BackupDatabaseEngine,
  DetectedDatabase,
  DetectedMount,
  ProjectBackupDetection,
  UnsavedWrites,
} from "@paas/core";

/** O pedaço do `docker inspect` que interessa aqui. */
export interface ContainerInspect {
  Name: string;
  Config: { Image: string; Env: string[] | null; Labels: Record<string, string> | null };
  Mounts: Array<{ Type: string; Name?: string; Source: string; Destination: string; RW?: boolean }>;
  /** tmpfs do compose (`tmpfs:`) não aparece em Mounts, só aqui. */
  HostConfig?: { Tmpfs?: Record<string, string> | null };
  State: { Running: boolean };
}

/** Todos os pontos de montagem do container: volumes, binds e tmpfs. */
export function mountPoints(c: ContainerInspect): string[] {
  return [...c.Mounts.map((m) => m.Destination), ...Object.keys(c.HostConfig?.Tmpfs ?? {})];
}

export function serviceOf(c: ContainerInspect): string {
  return c.Config.Labels?.["com.docker.compose.service"] ?? c.Name.replace(/^\//, "");
}

export function mountId(service: string, destination: string): string {
  return `mnt:${service}:${destination}`;
}

export function databaseId(service: string): string {
  return `db:${service}`;
}

/** Nome de arquivo seguro para um item dentro do .7z ("web__app_uploads"). */
export function itemFileName(service: string, destination: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return `${clean(service)}__${clean(destination) || "raiz"}`;
}

/** Banco pela imagem: o último trecho do nome (sem registro, organização e tag). */
export function engineFromImage(image: string): BackupDatabaseEngine | null {
  const name = image.toLowerCase().split("@")[0]!.split("/").pop()!.split(":")[0]!;
  if (/^(postgres|postgresql|postgis|timescaledb(-ha)?)$/.test(name)) return "postgres";
  if (name === "mysql" || name === "percona-server") return "mysql";
  if (name === "mariadb") return "mariadb";
  if (name === "mongo" || name === "mongodb" || name === "mongodb-community-server") return "mongo";
  if (name === "redis" || name === "valkey" || name === "redis-stack-server") return "redis";
  return null;
}

/** Pasta de dados de cada banco (coberta pelo dump). */
const DATA_DIRS: Record<BackupDatabaseEngine, RegExp> = {
  postgres: /^\/(var\/lib\/postgresql|bitnami\/postgresql|home\/postgres\/pgdata)(\/|$)/,
  mysql: /^\/(var\/lib\/mysql|bitnami\/mysql)(\/|$)/,
  mariadb: /^\/(var\/lib\/mysql|bitnami\/mariadb)(\/|$)/,
  mongo: /^\/(data\/db|data\/configdb|bitnami\/mongodb)(\/|$)/,
  redis: /^\/(data|bitnami\/redis)(\/|$)/,
};

const METHOD: Record<BackupDatabaseEngine, string> = {
  postgres: "Dump de cada banco com pg_dump (arquivo .sql), feito dentro do container.",
  mysql: "Dump com mysqldump (arquivo .sql), feito dentro do container.",
  mariadb: "Dump com mariadb-dump (arquivo .sql), feito dentro do container.",
  mongo: "mongodump --archive (arquivo .archive), feito dentro do container.",
  redis: "Cópia da pasta de dados (/data) depois de um SAVE.",
};

function envMap(c: ContainerInspect): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of c.Config.Env ?? []) {
    const i = pair.indexOf("=");
    if (i > 0) map.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return map;
}

/** Banco e usuário (nunca a senha) do ambiente do container. */
function identity(engine: BackupDatabaseEngine, env: Map<string, string>): { databaseName: string | null; user: string | null } {
  const get = (...keys: string[]) => keys.map((k) => env.get(k)).find((v) => v) ?? null;
  switch (engine) {
    case "postgres": {
      const user = get("POSTGRES_USER", "POSTGRESQL_USERNAME") ?? "postgres";
      return { databaseName: get("POSTGRES_DB", "POSTGRESQL_DATABASE") ?? user, user };
    }
    case "mysql":
    case "mariadb": {
      const root = get("MYSQL_ROOT_PASSWORD", "MARIADB_ROOT_PASSWORD", "MYSQL_ROOT_PASSWORD_FILE", "MARIADB_ROOT_PASSWORD_FILE");
      return {
        databaseName: get("MYSQL_DATABASE", "MARIADB_DATABASE"),
        user: root ? "root" : (get("MYSQL_USER", "MARIADB_USER") ?? "root"),
      };
    }
    case "mongo":
      return { databaseName: get("MONGO_INITDB_DATABASE"), user: get("MONGO_INITDB_ROOT_USERNAME") };
    default:
      return { databaseName: null, user: null };
  }
}

const CACHE_RE = /(cache|tmp|temp|\blogs?\b|node_modules|\.next|vendor|sessions?\b)/i;
const USER_FILES_RE =
  /(upload|storage|media|attach|anexo|arquivos|files|wp-content|dados|\bdata\b|userdata|documents?|documentos|imagens|images|avatars?|backups?)/i;

function mountReason(m: { destination: string; source: string; isFile: boolean }): { selected: boolean; reason: string } {
  const text = `${m.destination} ${m.source}`;
  if (m.isFile) return { selected: false, reason: "Arquivo único montado: geralmente configuração que vem do repositório." };
  if (CACHE_RE.test(m.destination)) return { selected: false, reason: "Parece cache ou arquivos temporários: dá para recriar." };
  if (USER_FILES_RE.test(text)) return { selected: true, reason: "Parece guardar arquivos dos usuários (uploads, storage, dados)." };
  return { selected: false, reason: "Marque se esta pasta guarda dados que não estão no GitHub." };
}

// ---------------------------------------------------------------------------
// docker diff → arquivos fora de volume
// ---------------------------------------------------------------------------

/** Caminhos que mudam sozinhos (temporário, cache, log, pid) e não são dados. */
const IGNORE_PREFIXES = ["/tmp", "/var/tmp", "/var/cache", "/var/log", "/run", "/var/run", "/proc", "/sys", "/dev", "/etc", "/var/lib/apt", "/var/lib/dpkg"];
/** Arquivos que o próprio Docker cria em todo container. */
const DOCKER_FILES = new Set([
  "/.dockerenv",
  "/usr/sbin/docker-init", // init: true
  "/sbin/docker-init",
  "/etc/hostname",
  "/etc/hosts",
  "/etc/resolv.conf",
]);
const IGNORE_PATTERNS = [
  /^\/root\/\./,
  /^\/home\/[^/]+\/\./,
  /\/(\.npm|\.cache|\.yarn|\.pnpm-store|__pycache__)(\/|$)/,
  /\/node_modules\/\.cache(\/|$)/,
  /\/\.next\/cache(\/|$)/,
  /\.(pid|sock|lock|pyc)$/,
];

function under(p: string, base: string): boolean {
  return p === base || p.startsWith(base.endsWith("/") ? base : `${base}/`);
}

/**
 * Heurística: caminhos Adicionados/alterados no container (não apagados),
 * fora de volumes e fora dos óbvios temporários.
 *  - O que o Docker cria sozinho (docker-init, .dockerenv, hosts…) não conta.
 *  - Ponto de montagem e pasta pai de um ponto de montagem também não: o
 *    Docker cria a pasta para montar ali (inclusive um arquivo único).
 *  - Uma pasta que tem qualquer outro caminho do diff dentro só conta pelo
 *    que tem dentro: "C /usr/sbin" por causa do docker-init, "C /srv" por
 *    um arquivo apagado.
 */
export function unsavedWritesFromDiff(diff: string, mountDestinations: string[]): string[] {
  const all: Array<{ kind: string; path: string }> = [];
  for (const line of diff.split("\n")) {
    const m = /^([ACD]) (\/.*)$/.exec(line.trim());
    if (m) all.push({ kind: m[1]!, path: m[2]! });
  }
  const hasChild = (p: string) => all.some((o) => o.path !== p && o.path.startsWith(p === "/" ? "/" : `${p}/`));
  const paths: string[] = [];
  for (const { kind, path: p } of all) {
    if (kind === "D") continue;
    if (DOCKER_FILES.has(p)) continue;
    if (IGNORE_PREFIXES.some((base) => under(p, base))) continue;
    if (IGNORE_PATTERNS.some((re) => re.test(p))) continue;
    if (mountDestinations.some((d) => under(p, d) || under(d, p))) continue;
    if (hasChild(p)) continue;
    paths.push(p);
  }
  return [...new Set(paths)].sort();
}

// ---------------------------------------------------------------------------
// Montagem da detecção
// ---------------------------------------------------------------------------

export interface DetectionInput {
  containers: ContainerInspect[];
  /** Saída do `docker diff`, por serviço. */
  diffs: Record<string, string>;
  /** Tamanho em bytes por id de montagem. */
  sizes: Record<string, number | null>;
  /** Fontes de bind mount que são arquivos (não pastas). */
  files: Set<string>;
  sourceFolder: { path: string; sizeBytes: number | null } | null;
  now: Date;
}

export function buildDetection(input: DetectionInput): ProjectBackupDetection {
  const databases: DetectedDatabase[] = [];
  const mounts: DetectedMount[] = [];
  const unsavedWrites: UnsavedWrites[] = [];
  const seen = new Set<string>();
  for (const c of input.containers) {
    const service = serviceOf(c);
    if (seen.has(service)) continue; // réplicas do mesmo serviço
    seen.add(service);
    const engine = engineFromImage(c.Config.Image);
    if (engine) {
      databases.push({
        id: databaseId(service),
        service,
        engine,
        image: c.Config.Image,
        ...identity(engine, envMap(c)),
        defaultSelected: engine !== "redis",
        method: METHOD[engine],
      });
    }
    for (const mt of c.Mounts) {
      if (mt.Type !== "volume" && mt.Type !== "bind") continue;
      const id = mountId(service, mt.Destination);
      const source = mt.Type === "volume" ? (mt.Name ?? mt.Source) : mt.Source;
      const isFile = mt.Type === "bind" && input.files.has(mt.Source);
      const covered = engine !== null && DATA_DIRS[engine].test(mt.Destination);
      const { selected, reason } = covered
        ? { selected: false, reason: "Coberto pelo dump do banco." }
        : mountReason({ destination: mt.Destination, source, isFile });
      mounts.push({
        id,
        service,
        type: mt.Type,
        source,
        destination: mt.Destination,
        sizeBytes: input.sizes[id] ?? null,
        coveredByDump: covered,
        isFile,
        defaultSelected: selected,
        reason,
      });
    }
    const paths = unsavedWritesFromDiff(input.diffs[service] ?? "", mountPoints(c));
    if (paths.length > 0) unsavedWrites.push({ service, count: paths.length, samples: paths.slice(0, 5) });
  }
  return {
    detectedAt: input.now.toISOString(),
    databases,
    mounts,
    unsavedWrites,
    sourceFolder: input.sourceFolder,
    error:
      input.containers.length === 0
        ? "Nenhum container do projeto encontrado. Faça o deploy e confira de novo."
        : null,
  };
}

// ---------------------------------------------------------------------------
// Dump e restauração (rodam DENTRO do container do banco, com `sh -c`)
// ---------------------------------------------------------------------------

/**
 * Credenciais lidas das variáveis do próprio container. Elas nunca passam
 * pelo painel nem pela linha de comando do `docker exec`.
 */
const PG_ENV = [
  'U="${POSTGRES_USER:-${POSTGRESQL_USERNAME:-postgres}}"',
  'if [ -z "${PGPASSWORD:-}" ]; then',
  '  if [ -n "${POSTGRES_PASSWORD:-}" ]; then PGPASSWORD="$POSTGRES_PASSWORD";',
  '  elif [ -n "${POSTGRES_PASSWORD_FILE:-}" ] && [ -r "$POSTGRES_PASSWORD_FILE" ]; then PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")";',
  '  elif [ -n "${POSTGRESQL_PASSWORD:-}" ]; then PGPASSWORD="$POSTGRESQL_PASSWORD"; fi',
  "fi",
  "export PGPASSWORD",
].join("\n");

const MY_ENV = [
  "if command -v mariadb-dump >/dev/null 2>&1; then DUMP=mariadb-dump; CLI=mariadb; else DUMP=mysqldump; CLI=mysql; fi",
  'ROOTPW="${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}"',
  'if [ -z "$ROOTPW" ] && [ -n "${MYSQL_ROOT_PASSWORD_FILE:-}" ] && [ -r "$MYSQL_ROOT_PASSWORD_FILE" ]; then ROOTPW="$(cat "$MYSQL_ROOT_PASSWORD_FILE")"; fi',
  'if [ -z "$ROOTPW" ] && [ -n "${MARIADB_ROOT_PASSWORD_FILE:-}" ] && [ -r "$MARIADB_ROOT_PASSWORD_FILE" ]; then ROOTPW="$(cat "$MARIADB_ROOT_PASSWORD_FILE")"; fi',
  'if [ -n "$ROOTPW" ]; then U=root; MYSQL_PWD="$ROOTPW"; EXTRA="--events";',
  'elif [ -n "${MYSQL_ALLOW_EMPTY_PASSWORD:-}${MARIADB_ALLOW_EMPTY_ROOT_PASSWORD:-}" ]; then U=root; MYSQL_PWD=""; EXTRA="--events";',
  'else U="${MYSQL_USER:-${MARIADB_USER:-root}}"; MYSQL_PWD="${MYSQL_PASSWORD:-${MARIADB_PASSWORD:-}}"; EXTRA=""; fi',
  "export MYSQL_PWD",
].join("\n");

/**
 * Credenciais do MongoDB para `tool` (mongodump ou mongorestore), em "$@".
 * A senha NÃO vai na linha de comando (ela apareceria no `ps` do container):
 * as database-tools 100.3+ leem `password` de um YAML passado em --config.
 * O arquivo é criado com umask 077 (0600) no /tmp do container do banco e
 * apagado ao sair, com sucesso, erro ou sinal.
 * Fallback: database-tools antigas (sem --config no --help, como nas imagens
 * mongo até 4.2) recebem --password como antes; o relatório documenta isso.
 */
function mongoEnv(tool: "mongodump" | "mongorestore"): string {
  return [
    'MU="${MONGO_INITDB_ROOT_USERNAME:-}"',
    'MP="${MONGO_INITDB_ROOT_PASSWORD:-}"',
    'if [ -z "$MP" ] && [ -n "${MONGO_INITDB_ROOT_PASSWORD_FILE:-}" ] && [ -r "$MONGO_INITDB_ROOT_PASSWORD_FILE" ]; then MP="$(cat "$MONGO_INITDB_ROOT_PASSWORD_FILE")"; fi',
    "set --",
    'if [ -n "$MU" ]; then',
    `  if ${tool} --help 2>&1 | grep -q -- "--config"; then`,
    '    MCFG="$(umask 077 && mktemp "${TMPDIR:-/tmp}/tws-mongo.XXXXXX")" || exit 1',
    `    trap 'rm -f "$MCFG"' EXIT`,
    `    trap 'rm -f "$MCFG"; exit 143' HUP INT TERM`,
    `    printf "password: '%s'\\n" "$(printf %s "$MP" | sed "s/'/''/g")" > "$MCFG"`,
    '    set -- --username "$MU" --authenticationDatabase admin --config "$MCFG"',
    "  else",
    '    set -- --username "$MU" --password "$MP" --authenticationDatabase admin',
    "  fi",
    "fi",
  ].join("\n");
}

export interface DumpStep {
  /** list: lista os bancos (um por linha); globals: papéis do Postgres; db: um banco ($1 = nome); all: tudo num arquivo. */
  id: "list" | "globals" | "db" | "all";
  script: string;
  /** Extensão do arquivo gerado. */
  ext: ".sql" | ".archive" | null;
}

export function dumpPlan(engine: BackupDatabaseEngine): DumpStep[] {
  switch (engine) {
    case "postgres":
      return [
        {
          id: "list",
          script: `${PG_ENV}\npsql -U "$U" -d template1 -AtX -c "select datname from pg_database where not datistemplate and datallowconn order by 1"`,
          ext: null,
        },
        { id: "globals", script: `${PG_ENV}\npg_dumpall -U "$U" --globals-only`, ext: ".sql" },
        { id: "db", script: `${PG_ENV}\npg_dump -U "$U" -d "$1" --clean --if-exists`, ext: ".sql" },
      ];
    case "mysql":
    case "mariadb":
      return [
        {
          id: "all",
          script: [
            MY_ENV,
            `DBS=$($CLI -u"$U" -N -B -e 'SHOW DATABASES' | grep -Ev '^(information_schema|performance_schema|mysql|sys)$')`,
            '[ -n "$DBS" ] || { echo "nenhum banco para copiar" >&2; exit 3; }',
            '$DUMP -u"$U" --single-transaction --routines --triggers $EXTRA --add-drop-database --databases $DBS',
          ].join("\n"),
          ext: ".sql",
        },
      ];
    case "mongo":
      return [{ id: "all", script: `${mongoEnv("mongodump")}\nmongodump --archive --quiet "$@"`, ext: ".archive" }];
    default:
      return [];
  }
}

/** Restauração de um dump (lido do stdin). Postgres: $1 = nome do banco. */
export function restoreScript(engine: BackupDatabaseEngine): string {
  switch (engine) {
    case "postgres":
      return [
        PG_ENV,
        `EXISTS=$(psql -U "$U" -d template1 -AtX -c "select 1 from pg_database where datname = '$(printf %s "$1" | sed "s/'/''/g")'")`,
        '[ "$EXISTS" = "1" ] || createdb -U "$U" "$1"',
        'psql -U "$U" -d "$1" -X -q',
      ].join("\n");
    case "mysql":
    case "mariadb":
      return `${MY_ENV}\n$CLI -u"$U"`;
    case "mongo":
      return `${mongoEnv("mongorestore")}\nmongorestore --archive --drop --quiet "$@"`;
    default:
      return "";
  }
}

/** Papéis do Postgres (o "já existe" de um papel é esperado e ignorado). */
export const PG_GLOBALS_RESTORE = `${PG_ENV}\npsql -U "$U" -d template1 -X -q`;

/** Antes de copiar o /data do Redis: grava o que está na memória. */
// A senha vai pela variável REDISCLI_AUTH (redis-cli 6+), nunca por -a.
export const REDIS_SAVE = 'if [ -n "${REDIS_PASSWORD:-}" ]; then export REDISCLI_AUTH="$REDIS_PASSWORD"; fi\nredis-cli --no-auth-warning SAVE';
