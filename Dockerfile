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
    PAAS_DATA_DIR=/data

RUN corepack enable \
    && groupadd --system tws && useradd --system --gid tws --home /app tws \
    && mkdir -p /data && chown -R tws:tws /data

# Copia o workspace inteiro já instalado e buildado do stage de build.
# (os pacotes @paas/* exportam TS e são executados via tsx — sem etapa de emit)
COPY --from=build --chown=tws:tws /app /app

VOLUME ["/data"]
EXPOSE 9000

# O painel precisa rodar como root para gerenciar o Docker do host via socket
# (hardening, Caddy, Stalwart). Mantemos o usuário tws criado para uso futuro.
USER root

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9000)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "--filter", "@paas/server", "start"]
