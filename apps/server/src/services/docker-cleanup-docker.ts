/**
 * docker-cleanup-docker.ts — o que a limpeza do Docker pede à Docker Engine API (unix socket).
 *
 * Leitura: `GET /system/df` (imagens e cache de build), `GET /containers/json?all=1` (imagens em uso) e
 * `GET /images/{nome}/json` (para onde um nome aponta agora).
 * Escrita, só estas duas: `POST /build/prune` (cache de build antigo) e `DELETE /images/{nome}` (uma imagem, sem force).
 * Nenhuma chamada toca em volumes ou containers.
 *
 * O `/system/df` vai com `type=image&type=build-cache`: sem isso o Docker mede também o tamanho de cada volume
 * (percorre os arquivos dos bancos dos clientes a cada verificação). Docker antigo ignora o filtro e devolve tudo.
 */
import http from "node:http";
import { dockerGet } from "./docker-logs.js";
import type { RawCacheRecord, RawImage } from "./docker-cleanup-plan.js";

const DF_MAX_BYTES = 32 * 1024 * 1024;
const LIST_MAX_BYTES = 8 * 1024 * 1024;

/** O que o serviço precisa do Docker (separado para os testes não subirem Docker). */
export interface DockerCleanupApi {
  /** Imagens e cache de build; null = o Docker não respondeu direito. */
  df(): Promise<{ images: RawImage[]; cache: RawCacheRecord[] } | null>;
  /** Ids das imagens usadas por containers (parados inclusive); null = não respondeu. */
  usedImageIds(): Promise<Set<string> | null>;
  /** Apaga o cache de build parado há pelo menos `hours` horas; devolve os bytes liberados. */
  pruneBuildCache(hours: number): Promise<number>;
  /** Id (sha256:…) da imagem para onde o nome aponta agora; null = o nome não existe ou o Docker não respondeu. */
  imageIdOf(ref: string): Promise<string | null>;
  /** Remove um nome (repo:tag) ou um id de imagem, sem force. Docker recusa se um container usa. */
  removeImage(ref: string): Promise<{ ok: true } | { ok: false; message: string }>;
}

function send(socketPath: string, method: "POST" | "DELETE", path: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout na Docker API")));
    req.on("error", reject);
    req.end();
  });
}

const messageOf = (body: string): string => {
  try {
    const m = (JSON.parse(body) as { message?: unknown }).message;
    if (typeof m === "string") return m.slice(0, 200);
  } catch {
    // corpo que não é JSON
  }
  return body.slice(0, 200);
};

export function createDockerCleanupApi(socketPath: string): DockerCleanupApi {
  return {
    async df() {
      const r = await dockerGet(socketPath, "/system/df?type=image&type=build-cache", DF_MAX_BYTES, 60_000);
      if (!r.ok || r.status !== 200) return null;
      try {
        const doc = JSON.parse(r.body.toString("utf8")) as { Images?: RawImage[] | null; BuildCache?: RawCacheRecord[] | null };
        return { images: doc.Images ?? [], cache: doc.BuildCache ?? [] };
      } catch {
        return null;
      }
    },
    async usedImageIds() {
      const r = await dockerGet(socketPath, "/containers/json?all=1", LIST_MAX_BYTES, 15_000);
      if (!r.ok || r.status !== 200) return null;
      try {
        const list = JSON.parse(r.body.toString("utf8")) as Array<{ ImageID?: string }>;
        return new Set(list.map((c) => c.ImageID).filter((x): x is string => typeof x === "string"));
      } catch {
        return null;
      }
    },
    async pruneBuildCache(hours) {
      const filters = encodeURIComponent(JSON.stringify({ until: [`${hours}h`] }));
      const r = await send(socketPath, "POST", `/build/prune?all=true&filters=${filters}`, 10 * 60_000);
      if (r.status !== 200) throw new Error(messageOf(r.body) || `Docker respondeu ${r.status}`);
      try {
        const n = (JSON.parse(r.body) as { SpaceReclaimed?: unknown }).SpaceReclaimed;
        return typeof n === "number" && n > 0 ? n : 0;
      } catch {
        return 0;
      }
    },
    async imageIdOf(ref) {
      const r = await dockerGet(socketPath, `/images/${encodeURIComponent(ref)}/json`, LIST_MAX_BYTES, 15_000);
      if (!r.ok || r.status !== 200) return null;
      try {
        const id = (JSON.parse(r.body.toString("utf8")) as { Id?: unknown }).Id;
        return typeof id === "string" ? id : null;
      } catch {
        return null;
      }
    },
    async removeImage(ref) {
      try {
        const r = await send(socketPath, "DELETE", `/images/${encodeURIComponent(ref)}`, 120_000);
        if (r.status === 200) return { ok: true };
        return { ok: false, message: messageOf(r.body) || `Docker respondeu ${r.status}` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
