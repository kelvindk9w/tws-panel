/**
 * Compose com a ESTRUTURA do cassino (validação real de 03/10/2026), sem
 * valores reais: db/redis com healthcheck, wallet (build) publicando 80/443 e
 * a porta administrativa em 127.0.0.1, web e caddy na rede do wallet.
 */
export const CASSINO_LIKE = `services:
  db:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: \${POSTGRES_USER:?defina}
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U "$\${POSTGRES_USER}"']
      interval: 2s
  redis:
    image: redis:8-alpine
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
  wallet:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - '80:80'
      - '443:443'
      - '127.0.0.1:8010:8010'
    env_file:
      - .env
    environment:
      PORT: '8009'
      HOST: '0.0.0.0'
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
  web:
    build:
      context: .
      dockerfile: services/web/Dockerfile
    network_mode: service:wallet
    environment:
      PORT: '3200'
    depends_on:
      wallet:
        condition: service_healthy
  caddy:
    image: caddy:2-alpine
    network_mode: service:wallet
    environment:
      SITE_HOST: \${SITE_HOST:?defina}
    depends_on:
      web:
        condition: service_started
      wallet:
        condition: service_started
`;
