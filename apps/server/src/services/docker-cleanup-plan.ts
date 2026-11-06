/**
 * docker-cleanup-plan.ts — o CÁLCULO da limpeza do Docker (funções puras, sem Docker nem disco).
 *
 * Recebe o que a API do Docker informa (imagens, cache de build, imagens usadas por containers) e devolve
 * o que sairia e o que fica protegido, com o motivo. É daqui que sai a lista imagem a imagem: a limpeza
 * nunca usa `image prune -a`, só remove o que esta lista aponta.
 *
 * Imagem protegida (nunca candidata), em ordem de prioridade:
 *  1. do painel: digest fixado em images.ts (e o do webmail, em @paas/mailer) ou repositório de PANEL_IMAGE_REPOSITORIES;
 *  2. usada por algum container (parado ou rodando);
 *  3. mais nova que a idade mínima.
 */
import {
  CADDY_IMAGE,
  HOST_HELPER_IMAGE,
  MAILPIT_IMAGE,
  NODE_BUILD_IMAGE,
  NODE_SERVER_IMAGES,
  PANEL_IMAGE_REPOSITORIES,
  STALWART_IMAGE_REF,
  STATIC_SERVER_IMAGE,
  type DockerCleanupDisk,
  type DockerCleanupImage,
  type DockerCleanupProtectedImage,
  type DockerCleanupScan,
} from "@paas/core";
import { ROUNDCUBE_IMAGE } from "@paas/mailer";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Imagem como a API do Docker (`GET /system/df`) devolve. */
export interface RawImage {
  Id: string;
  RepoTags?: string[] | null;
  RepoDigests?: string[] | null;
  /** Segundos desde a época. */
  Created: number;
  Size: number;
  SharedSize?: number;
  Containers?: number;
}

/** Registro do cache de build como a API do Docker devolve. */
export interface RawCacheRecord {
  ID: string;
  InUse?: boolean;
  Size: number;
  CreatedAt?: string;
  LastUsedAt?: string | null;
}

/** Os digests (sha256:…) das imagens fixadas em images.ts e do webmail. */
export function pinnedDigests(): Set<string> {
  const refs = [HOST_HELPER_IMAGE, CADDY_IMAGE, STALWART_IMAGE_REF, MAILPIT_IMAGE, NODE_BUILD_IMAGE, STATIC_SERVER_IMAGE, ...Object.values(NODE_SERVER_IMAGES), ROUNDCUBE_IMAGE];
  const out = new Set<string>();
  for (const ref of refs) {
    const at = ref.indexOf("@");
    if (at !== -1) out.add(ref.slice(at + 1));
  }
  return out;
}

/** Nome do repositório sem registro (`docker.io/`, `ghcr.io/`…) e sem tag/digest, em minúsculas. */
export function repositoryOf(ref: string): string {
  const noDigest = ref.split("@")[0] ?? ref;
  const lastSlash = noDigest.lastIndexOf("/");
  const colon = noDigest.lastIndexOf(":");
  const repo = colon > lastSlash ? noDigest.slice(0, colon) : noDigest;
  return repo.toLowerCase();
}

/** O repositório é um dos protegidos? Casa o nome inteiro ou o fim dele (`ghcr.io/dono/tws-panel` vale `tws-panel`). */
export function isPanelRepository(repo: string): boolean {
  const clean = repo.replace(/^docker\.io\//, "").replace(/^library\//, "");
  return PANEL_IMAGE_REPOSITORIES.some((p) => clean === p || clean.endsWith(`/${p}`));
}

const realTags = (img: RawImage): string[] => (img.RepoTags ?? []).filter((t) => t !== "<none>:<none>" && t !== "");

/** A imagem é do painel (fixada por digest ou de um repositório do painel)? */
export function isPanelImage(img: RawImage, pinned: ReadonlySet<string> = pinnedDigests()): boolean {
  if (pinned.has(img.Id)) return true;
  for (const d of img.RepoDigests ?? []) {
    const at = d.indexOf("@");
    if (at !== -1 && pinned.has(d.slice(at + 1))) return true;
    if (isPanelRepository(repositoryOf(d))) return true;
  }
  return realTags(img).some((t) => isPanelRepository(repositoryOf(t)));
}

/** Bytes que só esta imagem ocupa (o resto é camada dividida com outras imagens). */
export function uniqueBytes(img: RawImage): number {
  const shared = typeof img.SharedSize === "number" && img.SharedSize >= 0 ? img.SharedSize : 0;
  return Math.max(0, img.Size - shared);
}

export interface PlanInput {
  now: number;
  minAgeDays: number;
  images: RawImage[];
  cache: RawCacheRecord[];
  /** Ids das imagens que algum container (parado ou rodando) usa. */
  usedImageIds: ReadonlySet<string>;
  disk: DockerCleanupDisk | null;
}

const toView = (img: RawImage, now: number): DockerCleanupImage => ({
  id: img.Id,
  tags: realTags(img),
  bytes: uniqueBytes(img),
  createdAt: new Date(img.Created * 1000).toISOString(),
  ageDays: Math.max(0, Math.floor((now - img.Created * 1000) / DAY_MS)),
});

/** Monta o resultado da verificação. */
export function buildScan(input: PlanInput): DockerCleanupScan {
  const { now, minAgeDays } = input;
  const cutoff = now - minAgeDays * DAY_MS;
  const pinned = pinnedDigests();
  const candidates: DockerCleanupImage[] = [];
  const protectedList: DockerCleanupProtectedImage[] = [];
  for (const img of input.images) {
    const view = toView(img, now);
    if (isPanelImage(img, pinned)) protectedList.push({ ...view, reason: "panel" });
    else if ((img.Containers ?? 0) > 0 || input.usedImageIds.has(img.Id)) protectedList.push({ ...view, reason: "in_use" });
    else if (img.Created * 1000 > cutoff) protectedList.push({ ...view, reason: "recent" });
    else candidates.push(view);
  }
  candidates.sort((a, b) => b.bytes - a.bytes);
  protectedList.sort((a, b) => b.bytes - a.bytes);

  let cacheBytes = 0;
  let cacheEntries = 0;
  let cacheTotal = 0;
  for (const rec of input.cache) {
    cacheTotal += rec.Size;
    if (rec.InUse === true) continue;
    const stamp = Date.parse(rec.LastUsedAt && !rec.LastUsedAt.startsWith("0001") ? rec.LastUsedAt : (rec.CreatedAt ?? ""));
    if (!Number.isFinite(stamp) || stamp > cutoff) continue;
    cacheBytes += rec.Size;
    cacheEntries += 1;
  }
  const imagesBytes = candidates.reduce((n, c) => n + c.bytes, 0);
  const total = cacheBytes + imagesBytes;
  return {
    scannedAt: new Date(now).toISOString(),
    minAgeDays,
    buildCache: { bytes: cacheBytes, entries: cacheEntries, totalBytes: cacheTotal },
    images: { bytes: imagesBytes, candidates, protected: protectedList },
    totalBytes: total,
    totalPercentOfDisk: input.disk && input.disk.totalBytes > 0 ? Math.round((total / input.disk.totalBytes) * 1000) / 10 : null,
    disk: input.disk,
  };
}
