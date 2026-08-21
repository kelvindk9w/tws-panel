# syntax=docker/dockerfile:1
# =============================================================================
# TWS Panel — imagem de produção (multi-stage)
#
# Stage 1 (build): pnpm install + build do monorepo (SPA do apps/web + typecheck)
# Stage 2 (runtime): Node 22 slim + tsx rodando apps/server, que serve a API
#                    e a SPA buildada. Estado persistido em /data (volume).
#
# O container precisa de:
#   - /var/run/docker.sock montado (gerenciar Docker/Caddy/Stalwart do host)
#   - volume paas_data em /data (setup-state, SQLite/JSONs)
#
# HARDENING DA PRÓPRIA IMAGEM (o painel precisa ser exemplo — ver
# docs/host-bridge.md e docker-compose.yml):
#   - usuário NÃO-ROOT (tws) + group_add do grupo do docker.sock no compose;
#   - cap_drop ALL, no-new-privileges e rootfs read-only no compose;
#   - Docker CLI + compose plugin instalados de binários estáticos oficiais
#     com verificação de sha256 (necessários p/ o socket e o host bridge).
# =============================================================================

# ---------- Stage 1: build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN corepack enable

# Manifests primeiro para aproveitar cache de camadas no install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/security/package.json packages/security/package.json
COPY packages/deploy/package.json packages/deploy/package.json
COPY packages/mailer/package.json packages/mailer/package.json
# Hook de ativação dos git hooks roda no `prepare` do install (não-op sem .git).
COPY scripts/setup-hooks.mjs scripts/setup-hooks.mjs

RUN pnpm install --frozen-lockfile

# Código-fonte e configs.
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
COPY scripts scripts

# Build completo: typecheck de todos os pacotes + SPA de produção (apps/web/dist).
RUN pnpm build

# ---------- Stage 2: runtime ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=9000 \
    PAAS_DATA_DIR=/data \
    # Corepack com cache compartilhado e legível por qualquer usuário: o pnpm
    # é preparado EM BUILD, então em runtime NADA precisa ser baixado ou
    # gravado fora de /data (requisito do rootfs read-only + usuário não-root).
    COREPACK_HOME=/opt/corepack

# Docker CLI + plugin compose: binários estáticos oficiais com sha256 fixado.
# Por quê: o painel fala com o daemon do host via /var/run/docker.sock
# (deploys, Caddy, Stalwart) e o HOST BRIDGE (packages/security) executa o
# scan/hardening na VPS real via helper descartável `docker run ... nsenter`.
ARG DOCKER_CLI_VERSION=27.5.1
ARG DOCKER_CLI_SHA256=4f798b3ee1e0140eab5bf30b0edc4e84f4cdb53255a429dc3bbae9524845d640
ARG COMPOSE_VERSION=2.32.4
ARG COMPOSE_SHA256=ed1917fb54db184192ea9d0717bcd59e3662ea79db48bff36d3475516c480a6b
ADD https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_CLI_VERSION}.tgz /tmp/docker.tgz
ADD https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-x86_64 \
    /usr/local/libexec/docker/cli-plugins/docker-compose
RUN echo "${DOCKER_CLI_SHA256}  /tmp/docker.tgz" | sha256sum -c - \
    && tar -xzf /tmp/docker.tgz -C /usr/local/bin --strip-components=1 docker/docker \
    && rm /tmp/docker.tgz \
    && echo "${COMPOSE_SHA256}  /usr/local/libexec/docker/cli-plugins/docker-compose" | sha256sum -c - \
    && chmod +x /usr/local/libexec/docker/cli-plugins/docker-compose

# pnpm preparado em build (sem download em runtime) + usuário não-root.
RUN corepack enable \
    && corepack prepare pnpm@10.31.0 --activate \
    && chmod -R a+rX /opt/corepack \
    && groupadd --system --gid 10001 tws && useradd --system --uid 10001 --gid tws --home /app tws \
    && mkdir -p /data && chown -R tws:tws /data

# Copia o workspace inteiro já instalado e buildado do stage de build.
# (os pacotes @paas/* exportam TS e são executados via tsx — sem etapa de emit)
COPY --from=build --chown=tws:tws /app /app

VOLUME ["/data"]
EXPOSE 9000

# Usuário NÃO-ROOT. O acesso ao docker.sock é concedido via group_add do GID
# do grupo docker do host no docker-compose.yml (DOCKER_GID, gravado no .env
# pelo install.sh). Sem nenhuma capability: o cliente Docker só precisa ler/
# escrever no socket — quem confere privilégios ao helper é o daemon.
USER tws

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9000)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "--filter", "@paas/server", "start"]
