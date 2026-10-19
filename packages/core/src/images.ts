/**
 * images.ts — as imagens que o painel roda no servidor, fixadas por DIGEST.
 *
 * Uma tag (`alpine:3`) é só um nome local no daemon: um `docker compose up
 * --build` de um projeto com `image: alpine:3` a regrava, e o painel passaria
 * a rodar COMO ROOT (helper `--privileged --pid=host`) o binário do projeto
 * (achado A3). Referenciada por digest, a imagem não existe no daemon sob esse
 * nome a menos que tenha vindo do registro com aquele conteúdo.
 *
 * Atualizar = trocar tag E digest juntos
 * (`docker buildx imagetools inspect <tag> --format '{{.Manifest.Digest}}'`).
 */

/** Helper descartável do host bridge e do terminal (nsenter no PID 1). */
export const HOST_HELPER_IMAGE =
  "alpine:3@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6";
/** Caddy central. */
export const CADDY_IMAGE =
  "caddy:2-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f";
/** Servidor de e-mail (Stalwart, linha v0.11.x). */
export const STALWART_IMAGE_REF =
  "stalwartlabs/mail-server:v0.11.8@sha256:a5ce0615640b29a01c0a55b9fff6dd2c9dfa261ec87862c22e4db7e0254cdb1f";
/** Build de sites estáticos (Node). */
export const NODE_BUILD_IMAGE =
  "node:22@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8";
/** Servidor dos sites estáticos. */
export const STATIC_SERVER_IMAGE =
  "nginx:alpine@sha256:892bb2152464f0c5d8972593a5f5afaf8054552580b699d95f8ff4af08c2d33d";

/** Repositórios cujas tags nenhum projeto pode regravar (alpine, caddy, nginx, node, stalwart, roundcube, o próprio painel). */
export const PANEL_IMAGE_REPOSITORIES: readonly string[] = [
  "alpine",
  "caddy",
  "nginx",
  "node",
  "stalwartlabs/mail-server",
  "roundcube/roundcubemail",
  "tws-panel",
];
