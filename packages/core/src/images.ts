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
/** Caixa de teste de e-mail (Mailpit, versão fixa): recebe o SMTP do projeto no lugar do servidor de e-mail real. */
export const MAILPIT_IMAGE =
  "axllent/mailpit:v1.32.0@sha256:0790692be935ea4420d085694f7985b1f692ca6a8771ab0e0bd8ba75ac180498";
/** Build de sites estáticos (Node). */
export const NODE_BUILD_IMAGE =
  "node:22@sha256:63538dfe497cc29dfafdda25ada09b46db68a3f4cc205abf1f5d6bf0913f3384";
/**
 * Servidor Node gerado pelo painel (tipo node-server, Next.js com servidor):
 * build e execução na MESMA imagem alpine do major pedido, fixada por digest.
 * Uma linha por major suportado; o painel nunca usa tag solta.
 * Atualizar = trocar tag E digest (`docker buildx imagetools inspect node:<major>-alpine`).
 */
export const NODE_SERVER_IMAGES = {
  20: "node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293",
  22: "node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914",
  24: "node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53",
} as const;

/** Node padrão (LTS) quando o projeto não pede versão. */
export const NODE_SERVER_DEFAULT_MAJOR = 22;
/** Majors aceitos, do mais antigo ao mais novo. */
export const NODE_SERVER_MAJORS = [20, 22, 24] as const;

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
  "axllent/mailpit",
  "tws-panel",
];
