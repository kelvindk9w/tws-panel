---
title: "Como preparar seu projeto para o painel"
description: "O que seu repositório precisa ter para o painel publicá-lo: como ele decide o que fazer, receitas prontas (site estático, Dockerfile, app com banco), variáveis, regras que barram o deploy e um checklist."
sidebar:
  label: "Preparar seu projeto"
---

Este guia é para quem vai **publicar o próprio projeto** no painel: você, uma pessoa que ajuda você ou um
assistente de IA. Ele diz o que o painel espera encontrar no repositório, o que preparar para cada tipo de
projeto e traz arquivos prontos para copiar. Os exemplos usam `example.com` e senhas de exemplo óbvias: troque
pelos seus.

> [!NOTE]
> Esta página **orienta e aponta** para as outras. Os detalhes de cada tela estão em
> [Funcionalidades](features.md); a lista completa do que o deploy barra está em
> [Regras do compose](compose-rules.md); o passo a passo de criar o projeto na tela está em
> [Primeiro projeto](../getting-started/complete-guide.md#etapa-7).

---

## 1. Antes de começar

### O que você precisa ter

- **O código num repositório Git** (GitHub, GitLab ou outro que aceite `https://` ou SSH). Pode ser público. Se
  for **privado**, o painel precisa de uma credencial **somente de leitura**: um token com a permissão
  `Contents: Read` só para esse repositório, ou a sua conta do GitHub conectada em
  **Configurações → Integrações**. Na criação do projeto, o botão **Testar acesso** confere se o painel
  consegue ler, sem criar nada.
- **A branch** que vai para o ar (o padrão é `main`). O painel clona só essa branch. O código que não estiver
  nela não é publicado.
- **Um domínio**, se quiser o seu endereço. Sem domínio, o painel cria um endereço automático com HTTPS para
  testar. Com domínio, crie no seu provedor de DNS um registro **A** apontando para o IP da VPS, para o nome
  que você digitar e também para o par **com e sem `www`** (`@` e `www`; o par só existe para o domínio principal, como `example.com`: um subdomínio como `loja.example.com` não tem par). No Cloudflare, deixe a nuvem
  **cinza** (só DNS). Com a nuvem laranja o certificado não sai. A tela mostra os registros exatos. Mais em
  [Funcionalidades](features.md#deploy-de-projetos) e em
  [Solução de problemas](troubleshooting.md#o-site-abre-sem-www-mas-com-www-não-ou-o-contrário).

### O que o painel faz por você

- Baixa o código (`git clone`) e atualiza a cada deploy.
- Faz o build e sobe os containers (Docker).
- Emite e renova o certificado **HTTPS** sozinho (Caddy) e liga o domínio ao seu site, com suporte a
  WebSocket (marque a opção ao criar o projeto).
- Guarda as **variáveis** e as entrega ao projeto.
- Liga o **e-mail** do projeto, se você ativar (variáveis `SMTP_*` e `MAIL_*`).
- Faz **backups** e mostra os **logs** de cada serviço.

### O que o painel NÃO faz

- **Não usa PM2, nginx nem Apache do sistema.** Tudo roda em containers. Não instale nada na VPS por fora.
- **Não executa comandos avulsos** do seu projeto. Quem instala, compila e inicia é o `Dockerfile` ou o compose
  que **você** escreve. Não existe "rode `npm start` depois".
- **Não lê o `.env` do seu computador.** Se ele estiver no `.gitignore` (como deve estar), o painel nunca o vê.
  Você importa as variáveis pela tela **Variáveis** (veja a [seção 5](#5-variáveis-e-segredos)).
- **Não atualiza sozinho.** Depois de um `git push`, clique em **Deploy**. O painel só avisa que há commit novo.

---

## 2. Como o painel decide o que fazer

Ao detectar o projeto, o painel olha a **pasta principal** (a raiz do repositório) e usa a **primeira** regra
que servir:

1. **Compose.** Se existir um destes arquivos, nesta ordem, o painel adota o primeiro que achar:
   `compose.paas.yml`, `compose.paas.yaml`, `compose.prod.yml`, `compose.prod.yaml`,
   `compose.production.yml`, `docker-compose.prod.yml`, `docker-compose.prod.yaml`,
   `docker-compose.production.yml`, `compose.yml`, `compose.yaml`, `docker-compose.yml`,
   `docker-compose.yaml`. Ele **nunca reescreve** o seu arquivo.
2. **Dockerfile sem `package.json`.** Vira um container só. A porta vem da primeira linha `EXPOSE`.
3. **`package.json` com o script `build`.**
   - Se for **Vite**, **Next.js com `output: "export"`**, ou já existir `out/`, `dist/` ou `build/` com
     `index.html` no repositório, o painel roda o build e publica a pasta como **site estático**. Isso vale
     **mesmo que exista um `Dockerfile`**: o `Dockerfile` é ignorado.
   - Sem nenhuma dessas pistas e **com** `Dockerfile`: usa o `Dockerfile` (como no item 2).
   - Sem pistas e **sem** `Dockerfile`: assume que o build gera `dist/` (pode estar errado).
4. **`index.html` na raiz**, sem build: site estático publicado como está.

Se nada disso casar, a tela diz "O painel ainda não sabe publicar este código" e lista o que ele publica.

> [!WARNING]
> **Um `package.json` sem script `build` não conta como projeto Node.** Um servidor Node (Express, Fastify,
> NestJS...) com `Dockerfile` e `package.json` **sem** `build` cai em "desconhecido". Duas saídas: criar um
> `compose.prod.yml` (mesmo com um serviço só, é o caminho mais previsível, receita na
> [seção 3.4](#34-app-com-banco-composeprodyml)), ou ter um script `build` no `package.json`.

### Meu projeto é... o que preparar

| Meu projeto é... | Prepare no repositório | Receita |
|---|---|---|
| Página em HTML, CSS e JS sem build | `index.html` na raiz | [3.1](#31-site-estático-html-puro) |
| React, Vue ou Svelte com Vite | `package.json` com `build` que gera `dist/` e o `vite` nas dependências | [3.2](#32-site-estático-com-build-vite-react) |
| Next.js só com páginas estáticas | `next.config` com `output: "export"` | [4](#4-nextjs) |
| Next.js com servidor (API, SSR) | Nada: o painel gera o Dockerfile (ou use um `Dockerfile`/compose seu) | [4](#4-nextjs) e [guia de Next.js](nextjs.md) |
| App de um serviço só (Python, Go, Java...), sem banco e **sem** `package.json` | `Dockerfile` com `EXPOSE` e `.dockerignore` | [3.3](#33-app-com-dockerfile) |
| App **Node** de um serviço só, sem script `build` | `Dockerfile` + `compose.prod.yml` de um serviço | [3.3](#node-sem-script-build) |
| App **com banco**, cache ou mais de um serviço | `compose.prod.yml` | [3.4](#34-app-com-banco-composeprodyml) |
| Laravel (PHP) com MySQL ou PostgreSQL | `Dockerfile` + `compose.prod.yml` | [3.5](#35-laravel-php-com-mysql-e-redis) |
| WordPress, n8n, Metabase e semelhantes | `compose.prod.yml` com a imagem oficial | [3.4](#34-app-com-banco-composeprodyml) |

---

## 3. Receitas

> [!WARNING]
> **Todo `Dockerfile` que faz `COPY . .` precisa de um `.dockerignore` que exclua o `.env`.** Num projeto
> compose, o painel grava as suas Variáveis (senhas, chaves) num arquivo `.env` dentro da pasta do projeto antes
> do build. Sem o `.dockerignore`, o `COPY . .` copia esse arquivo para dentro da **imagem**, e quem tiver
> acesso à imagem lê os segredos. Cada receita abaixo traz o seu `.dockerignore`.

### 3.1 Site estático (HTML puro)

```text
meu-site/
├── index.html
├── style.css
└── img/logo.png
```

Só isso. O painel copia os arquivos para um servidor web (nginx) **sem arquivos ou pastas ocultos**: `.git`,
`.env` e semelhantes não vão para o ar (só `.well-known` é mantida, útil para verificações de domínio).

- Links entre páginas funcionam como arquivos: `sobre.html`, `contato/index.html`.
- O servidor não tem regra de "se não achar, mostre o `index.html`". Uma página que não existe devolve 404.

### 3.2 Site estático com build (Vite, React)

`package.json`:

```json
{
  "name": "meu-site",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "vite": "^5.4.0"
  }
}
```

O que o painel faz: roda `npm install` e `npm run build` num container Node 22 e publica a pasta `dist/`.
O gerenciador vem do campo `packageManager` do `package.json`; sem ele, do arquivo de trava
(`pnpm-lock.yaml`, `yarn.lock`), e por último é o `npm`.

Cuidados:

- **Versione o arquivo de trava** (`package-lock.json`, `pnpm-lock.yaml` ou `yarn.lock`) para o build ser o
  mesmo sempre.
- **Rotas do lado do navegador (React Router etc.)**: o servidor estático não redireciona caminhos
  desconhecidos para o `index.html`. Abrir `https://example.com/painel` direto dá 404. Use rotas com `#`
  (hash), páginas geradas de verdade, ou publique com um Dockerfile próprio (abaixo).
- **Variáveis do build (`VITE_...`)**: o painel **não** entrega suas Variáveis ao build estático. Valores
  públicos (como o endereço da sua API) vão num `.env.production` **versionado**. Nunca ponha segredo ali: ele
  vai para o navegador de quem visitar.

Se precisar de roteamento do lado do navegador, publique com um `compose.prod.yml` (ele tem prioridade sobre a
detecção de Vite) e um `Dockerfile` seu que serve o `dist/` com a regra "se não achar, mostre o `index.html`":

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
```

Este `Dockerfile` usa `npm ci`, que **exige o `package-lock.json`**. Com pnpm, troque as linhas de instalação por
`COPY package.json pnpm-lock.yaml ./` e `RUN corepack enable && pnpm install --frozen-lockfile`; com yarn, por
`COPY package.json yarn.lock ./` e `RUN corepack enable && yarn install --frozen-lockfile`.

`.dockerignore` (mantém o `.env.production`, que só tem valores públicos):

```text
node_modules
dist
.git
.env
.env.local
```

`nginx.conf`:

```nginx
server {
  listen 8080;
  root /usr/share/nginx/html;
  location / {
    try_files $uri /index.html;
  }
}
```

`compose.prod.yml`:

```yaml
services:
  web:
    build: .
    image: example-site:1.0
    expose:
      - "8080"
    restart: unless-stopped
```

Na tela de detecção, informe **Porta do serviço** = `8080` (com `expose` e sem `ports`, o palpite do painel é 80).

### 3.3 App com Dockerfile

Para um app de **um serviço só e sem banco**, **sem `package.json`** na raiz (Python, Go, Java, Ruby...). Exemplo
para Python com Flask e gunicorn (serve igual para qualquer linguagem: o que importa é o `EXPOSE` e escutar em
todos os endereços). Coloque `gunicorn` no `requirements.txt`:

```dockerfile
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# roda sem ser root
RUN useradd --create-home app
USER app

EXPOSE 8000
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "app:app"]
```

`.dockerignore` (evita copiar lixo e segredos para a imagem):

```text
.git
.env
.env.*
.venv
__pycache__
```

Regras para dar certo:

1. **Escreva `EXPOSE <porta>`** com a porta em que o app escuta. É dela que o painel tira a porta do proxy.
   Sem `EXPOSE`, a tela pede a porta e você preenche **Porta do serviço**.
2. **O app precisa escutar em `0.0.0.0`**, não em `127.0.0.1`/`localhost`. Em localhost, só o próprio
   container o alcança e o site dá erro 502.
3. **Rode sem ser root** (`USER app`, depois de criar o usuário, como no exemplo). Ajuda a segurança e o painel já corta privilégios
   extras do container.
4. **Não grave dados dentro do container.** Neste modo não há volume: o que o app escrever em disco **se
   perde a cada deploy**. Se precisa de arquivos persistentes ou de banco, use a [receita 3.4](#34-app-com-banco-composeprodyml).
5. As **Variáveis** do projeto chegam como variáveis de ambiente do container (em Python, `os.environ["NOME"]`; em Node, `process.env.NOME`). Não use
   `ARG`/`ENV` no Dockerfile para segredos: o painel não passa `--build-arg`, e o valor ficaria gravado na imagem.

<a id="node-sem-script-build"></a>

**App Node sem script `build`.** Um `package.json` sem `build` faz o painel responder "tipo desconhecido", mesmo
com `Dockerfile` (veja o aviso da [seção 2](#2-como-o-painel-decide-o-que-fazer)). O caminho mais simples é um
`compose.prod.yml` de **um serviço só**, que tem prioridade. O `Dockerfile`:

```dockerfile
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

# roda sem ser root
USER node

EXPOSE 3000
CMD ["node", "server.js"]
```

O `.dockerignore` é o de cima (troque `.venv` e `__pycache__` por `node_modules`). E o `compose.prod.yml`:

```yaml
services:
  app:
    build: .
    image: example-node:1.0
    restart: unless-stopped
    expose:
      - "3000"
```

Na tela de detecção, informe **Porta do serviço** = `3000`. Se o seu `package.json` já tem um script `build`
(Next.js, por exemplo), o `Dockerfile` sozinho basta, como na [seção 4](#4-nextjs).

### 3.4 App com banco: `compose.prod.yml`

Quando o projeto tem mais de um serviço (app, banco, cache), escreva um `compose.prod.yml` na raiz. Exemplo
completo para **Node + PostgreSQL + Redis**:

```yaml
services:
  app:
    build: .
    image: example-app:1.0
    restart: unless-stopped
    expose:
      - "3000"
    environment:
      NODE_ENV: production
      PORT: "3000"
      DATABASE_URL: postgres://app:${DB_PASSWORD:?defina DB_PASSWORD em Variáveis}@db:5432/app
      REDIS_URL: redis://cache:6379
      SESSION_SECRET: ${SESSION_SECRET:?defina SESSION_SECRET em Variáveis}
    volumes:
      - uploads:/app/uploads
    depends_on:
      db:
        condition: service_healthy
      cache:
        condition: service_started
    # migrações antes de iniciar; troque pelo comando da sua ferramenta
    command: ["sh", "-c", "npm run migrate && node server.js"]

  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${DB_PASSWORD:?defina DB_PASSWORD em Variáveis}
      POSTGRES_DB: app
    volumes:
      - dbdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 5s
      timeout: 3s
      retries: 10

  cache:
    image: redis:7.2-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - cachedata:/data

volumes:
  uploads:
  dbdata:
  cachedata:
```

O `Dockerfile` e o `.dockerignore` são os de Node da receita 3.3.

Por que está escrito assim (cada item evita um bloqueio ou um problema comum):

- **Rede interna.** Não declare `networks:`. O Compose já cria uma rede privada para o projeto, e os serviços
  se falam pelo **nome** (`db`, `cache`). O painel liga **só o serviço web** à rede do proxy sozinho.
- **`expose` em vez de `ports`.** `expose` só abre a porta para os outros containers. `ports` publicaria na
  VPS: o de banco (5432, 3306, 6379...) é **bloqueado**, e 80/443 o painel retira sozinho.
- **Qual serviço recebe o site.** O painel escolhe o serviço pelo nome (`web`, `app`, `frontend`, `site`...) ou
  pela imagem (`caddy`, `nginx`, `traefik`). Dê um desses nomes ao serviço do site. **Confira na tela de
  detecção o "Serviço web" e a "Porta do serviço"**: se o serviço só usa `expose`, o palpite pode sair 80
  e você corrige para a porta certa (3000 aqui).
- **Volumes nomeados** (`dbdata:`) guardam os dados e sobrevivem aos deploys. Não use `./pasta:/dados` para
  banco. Pastas **dentro do projeto** (`./uploads:/app/uploads`) são aceitas, mas volume nomeado é mais simples.
- **`healthcheck` + `depends_on: condition: service_healthy`** faz o app esperar o banco ficar pronto.
- **Migrações** no `command` (ou num `entrypoint`): o banco sobe vazio no primeiro deploy.
- **Senhas fora do arquivo**: `${DB_PASSWORD:?mensagem}` não tem valor no repositório e **barra o deploy com
  uma mensagem clara** se a variável não estiver preenchida. Gere valores longos (`openssl rand -hex 24`;
  hexadecimal evita caracteres que quebram a URL do banco).
- **Versões fixas** nas imagens (`postgres:16-alpine`). `:latest` ou sem versão só gera um aviso, mas deixa o
  deploy imprevisível.
- **O nome da imagem é seu** (`example-app:1.0`). Não use `image: node:22` junto de `build:` (nem `nginx`,
  `alpine`, `caddy`): é bloqueado.

Variações:

- **MySQL no lugar do PostgreSQL**: `image: mysql:8.4`, volume em `/var/lib/mysql`, variáveis
  `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD` e `MYSQL_ROOT_PASSWORD`, e healthcheck
  `["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -p\"$$MYSQL_ROOT_PASSWORD\" --silent"]` (o `$$` é a forma de o
  compose escrever `$`).
- **Produto pronto (WordPress, n8n, Metabase...)**: use a imagem oficial, o mesmo desenho (serviço web +
  banco + volumes nomeados) e as variáveis da documentação do produto.
- **Só aplicação mais um banco**: apague o serviço `cache`, o `REDIS_URL` e o volume `cachedata`.

### 3.5 Laravel (PHP) com MySQL e Redis

Quatro arquivos. O `Dockerfile` usa Apache com o PHP, apontando para `public/`, e compila os assets do Vite
(o Laravel padrão usa `@vite` nas views; sem a pasta `public/build` a página dá erro 500). Se o seu projeto não usa
Vite, apague o primeiro estágio e a linha que copia `public/build`:

```dockerfile
FROM node:22-alpine AS assets
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM composer:2 AS vendor
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-scripts --no-autoloader --prefer-dist
COPY . .
RUN composer dump-autoload --no-dev --optimize

FROM php:8.4-apache
RUN docker-php-ext-install pdo_mysql opcache \
 && pecl install redis-6.1.0 && docker-php-ext-enable redis \
 && a2enmod rewrite \
 && sed -ri 's!/var/www/html!/var/www/html/public!g' /etc/apache2/sites-available/*.conf /etc/apache2/apache2.conf /etc/apache2/conf-available/*.conf
WORKDIR /var/www/html
COPY --from=vendor /app ./
COPY --from=assets /app/public/build ./public/build
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 80
ENTRYPOINT ["entrypoint.sh"]
CMD ["apache2-foreground"]
```

Este `Dockerfile` é a exceção à regra de "rodar sem ser root" da receita 3.3: o Apache oficial começa como root
só para abrir a porta 80 e atende os pedidos como `www-data`. O painel ainda corta os privilégios extras do container.
Se um plugin do Vite lê arquivos de `vendor/` (Livewire, por exemplo), copie o `vendor` também para o estágio `assets`.

`.dockerignore` (sem ele, o `.env` com as senhas iria para dentro da imagem):

```text
.git
.env
.env.local
node_modules
vendor
storage/logs
```

O `.dockerignore` mantém o `.env.production`, onde ficam os valores públicos `VITE_*` que o build do Vite lê (o painel não entrega as Variáveis ao build). Nunca ponha segredo ali.

O estágio `assets` usa `npm ci`, que **exige o `package-lock.json`**: um Laravel novo só o tem depois do primeiro `npm install`, então rode-o e versione o arquivo. Com pnpm ou yarn, troque as linhas de instalação como no site estático com Vite (receita 3.2).

`docker/entrypoint.sh` (cria as pastas que o volume deixa vazias e roda as migrações):

```bash
#!/bin/sh
set -e
mkdir -p storage/framework/cache storage/framework/sessions storage/framework/views storage/logs bootstrap/cache
chown -R www-data:www-data storage bootstrap/cache
php artisan config:cache
php artisan migrate --force
exec "$@"
```

`compose.prod.yml`:

```yaml
services:
  web:
    build: .
    image: example-laravel:1.0
    restart: unless-stopped
    expose:
      - "80"
    environment:
      APP_ENV: production
      APP_DEBUG: "false"
      APP_URL: https://example.com
      APP_KEY: ${APP_KEY:?defina APP_KEY em Variáveis}
      DB_CONNECTION: mysql
      DB_HOST: db
      DB_PORT: "3306"
      DB_DATABASE: app
      DB_USERNAME: app
      DB_PASSWORD: ${DB_PASSWORD:?defina DB_PASSWORD em Variáveis}
      REDIS_CLIENT: phpredis
      REDIS_HOST: cache
      CACHE_STORE: redis
      SESSION_DRIVER: redis
    volumes:
      - storage:/var/www/html/storage
    depends_on:
      db:
        condition: service_healthy

  db:
    image: mysql:8.4
    restart: unless-stopped
    environment:
      MYSQL_DATABASE: app
      MYSQL_USER: app
      MYSQL_PASSWORD: ${DB_PASSWORD:?defina DB_PASSWORD em Variáveis}
      MYSQL_ROOT_PASSWORD: ${DB_ROOT_PASSWORD:?defina DB_ROOT_PASSWORD em Variáveis}
    volumes:
      - dbdata:/var/lib/mysql
    healthcheck:
      test: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -p\"$$MYSQL_ROOT_PASSWORD\" --silent"]
      interval: 5s
      timeout: 3s
      retries: 20

  cache:
    image: redis:7.2-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - cachedata:/data

volumes:
  storage:
  dbdata:
  cachedata:
```

Variáveis para preencher: `APP_KEY` (gere no seu computador com `php artisan key:generate --show`),
`DB_PASSWORD` e `DB_ROOT_PASSWORD` (valores diferentes, longos). Para e-mail, veja a
[seção 5](#e-mail-do-projeto).

Prefere o pacote `predis/predis`? Instale-o com o Composer, defina `REDIS_CLIENT: predis` e tire a instalação do `pecl` do `Dockerfile`.

Com PostgreSQL: `image: postgres:16-alpine`, `DB_CONNECTION: pgsql`, porta `5432`, a extensão `pdo_pgsql`
(`apt-get install -y libpq-dev` antes do `docker-php-ext-install`) e o healthcheck da receita 3.4.

---

## 4. Next.js

<a id="nextjs"></a>

> [!NOTE]
> **Estado atual:** o painel publica Next.js de **três formas**: (1) site estático com `output: "export"`;
> (2) **servidor automático**, em que ele detecta o Next.js com servidor e gera o `Dockerfile` por conta própria
> (nada é gravado no seu repositório); (3) `Dockerfile` ou compose seu, que tem prioridade sobre o automático.
> Quando usar cada uma, as variáveis `NEXT_PUBLIC_*` e a memória do build estão no
> [guia de Next.js](nextjs.md). As opções A e B abaixo continuam valendo para os caminhos 1 e 3.

**Opção A: site estático.** No `next.config.js` (ou `.mjs`, `.ts`):

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
};
export default nextConfig;
```

O painel reconhece `output: "export"`, roda o build e publica a pasta `out/`. Não há servidor: não use rotas de
API, `getServerSideProps` nem middleware.

**Opção B: com servidor (API, SSR).** Use o modo `standalone` e um `Dockerfile` seu. No `next.config`:

```js
const nextConfig = { output: "standalone" };
export default nextConfig;
```

`Dockerfile` (roda sem ser root; se o projeto não tem a pasta `public/`, apague a linha que a copia):

```dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
CMD ["node", "server.js"]
```

`.dockerignore` (sem ele, o `.env` com as senhas iria para dentro da imagem; o `.env.production`, só com valores públicos, fica):

```text
node_modules
.next
.git
.env
.env.local
```

`HOSTNAME=0.0.0.0` é obrigatório: sem ele o Next escuta só em localhost e o site dá 502. Com `package.json` que
tem `build` e **sem** `output: "export"` e sem `vite`, o painel usa este `Dockerfile` e lê a porta do `EXPOSE`.

Se o app usa banco, escreva um `compose.prod.yml` como o da [receita 3.4](#34-app-com-banco-composeprodyml)
com `build: .` no serviço do site. Cuidado com as variáveis `NEXT_PUBLIC_...`: o Next as **grava no código durante
o build**. No Dockerfile direto o painel não passa `--build-arg`; use `build.args` no compose (com
`${VAR}` vindo das Variáveis) ou deixe só valores públicos num `.env.production` versionado.

---

## 5. Variáveis e segredos

### Como funciona

1. No projeto, abra a aba **Variáveis**. A tela lista as variáveis que o compose pede (`${NOME}`) e sugere as
   do `.env.example` do repositório, sem valor.
2. Tem um `.env` no seu computador? Clique em **Importar arquivo .env**, revise e clique em
   **Salvar variáveis**. Nada vai para o servidor antes de salvar.
3. Faça o **Deploy**. As variáveis só valem no deploy seguinte.

### Regras de ouro

- **Nunca versione o `.env`** nem escreva senhas no código, no `Dockerfile` ou no compose. Ponha `.env` no
  `.gitignore`. Um segredo comitado deve ser considerado vazado: troque-o. O painel avisa quando acha algo
  parecido (`secret-in-code`).
- **Versione um `.env.example`** só com os **nomes** e valores de mentira (`DB_PASSWORD=troque-por-um-valor-longo`).
  É ele que alimenta as sugestões da tela.
- **Marque as obrigatórias com `${NOME:?mensagem}`.** Se faltar valor, o deploy para antes de subir e diz
  qual está faltando. Sem o `:?`, a variável vazia passa em silêncio e o app quebra depois.

### O que o painel grava, e onde

- As variáveis ficam **cifradas** no servidor do painel.
- No deploy, num projeto **compose**, o painel escreve um arquivo `.env` na pasta do projeto na VPS
  (permissão restrita, fora do Git) com o cabeçalho "Gerado pelo painel". É por ele que o compose resolve
  `${NOME}` e o `env_file: .env`. Se o **seu repositório já tem um `.env` versionado**, o painel **não o
  sobrescreve**: grava as variáveis à parte e avisa no log do deploy.
- Num projeto **Dockerfile**, elas viram variáveis de ambiente do container.
- Num **site estático**, não são usadas (não há servidor para lê-las).
- A pasta do projeto na VPS está descrita em
  [Onde ficam os arquivos dos seus projetos](operations.md#onde-ficam-os-arquivos-dos-seus-projetos).

### E-mail do projeto

Se o seu app envia e-mail, ative a aba **E-mail** do projeto (pede o [servidor de e-mail](email-deliverability.md)
configurado). A cada deploy o painel entrega ao app `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
`MAIL_FROM` e `MAIL_FROM_NAME` (o nome de exibição; se você não definir um, vale o nome do projeto).

O seu app lê **outros nomes** (`MAIL_HOST`, `SMTP_SENHA`, `EMAIL_DE`)? Em **Ligar às variáveis do projeto**,
escolha para cada nome do app o valor do e-mail que ele recebe. No compose, escreva o nome do app como
obrigatória (por exemplo `MAIL_HOST: ${MAIL_HOST:?}`): a ligação conta como preenchida. A ligação vence um valor
salvo com o mesmo nome em Variáveis.

---

## 6. Regras que barram o deploy

Antes de subir, o painel confere o compose. O que uma hospedagem não deveria pedir ao Docker é um **bloqueio**
e o deploy para, com a explicação na tela e no log. Resumo e como corrigir (a tabela completa, com todos os
campos e exemplos, está em [Regras do compose](compose-rules.md)):

| Se o seu compose... | Regra | Como corrigir |
|---|---|---|
| publica a porta de um banco (`"5432:5432"`, `"3306:3306"`, `"6379:6379"`...) | `db-port-exposed` | Apague a linha de `ports`. Os outros serviços chegam ao banco por `db:5432`. |
| tem `privileged: true`, `cap_add`, `devices`, `network_mode: host`, `pid: host`... | `privileged-container`, `host-namespace` | Remova o campo. Raramente um app web precisa disso. |
| monta `/var/run/docker.sock` ou outra pasta do servidor (`/srv/dados:/dados`, `~/x`) | `panel-resource`, `host-mount` | Não monte o socket do Docker (**sem override possível**). Para dados, use volume nomeado (`dados:/dados`) ou uma pasta dentro do projeto (`./dados:/dados`). |
| usa senha trivial (`password`, `admin`, `root`, `123456`, `changeme`...), com menos de 6 caracteres, ou usuário igual à senha | `weak-credentials` | Use `${DB_PASSWORD:?...}` e um valor longo e aleatório nas Variáveis. O usuário deve ser diferente da senha. |
| publica `80:80` ou `443:443` | `proxy-port-conflict` | Remova. O painel já cuida do HTTPS (só é bloqueio se o projeto traz um proxy HTTPS próprio). |
| usa `container_name`/`hostname` com nome do painel (`tws-panel`, `paas-caddy`...) ou começando com `paas-`/`tws-` (o mesmo vale para o nome do serviço web), `name:` de volume ou rede do painel, ou `image: node` junto de `build:` | `reserved-name`, `panel-resource`, `panel-image` | Escolha outro nome (ou remova `container_name`). Não use `name:` nos volumes e redes. |
| usa um campo que o painel não conhece | `unsupported-field` | Remova o campo citado na mensagem. |

Cada mensagem mostra o **arquivo, o serviço e o ponto exato**, mais uma sugestão. Para o que cada regra
aceita e rejeita, e a diferença entre o que pode e o que não pode receber **override**, leia
[Regras do compose](compose-rules.md). Veja também
[Deploy bloqueado por guardrail](troubleshooting.md#deploy-bloqueado-por-guardrail).

---

## 7. Checklist e "deu errado, e agora?"

### Antes do primeiro deploy

- [ ] O código está no Git e **na branch** que vou publicar (`git push` feito).
- [ ] Tem `compose.prod.yml`, `Dockerfile`, `package.json` com `build` ou `index.html` na raiz, conforme a
      [tabela](#meu-projeto-é-o-que-preparar).
- [ ] O app escuta em `0.0.0.0` na porta que declarei (`EXPOSE` ou `expose`).
- [ ] Nenhum banco publicado em `ports`; nada de `privileged`, `docker.sock` nem pasta do servidor montada.
- [ ] Nenhuma senha escrita nos arquivos. `.env` está no `.gitignore` e existe um `.env.example`.
- [ ] Dados importantes estão em **volumes nomeados**.
- [ ] Versões das imagens fixadas (`postgres:16-alpine`, não `latest`).
- [ ] Domínio: registros A (e `www`) apontando para a VPS, nuvem **cinza** no Cloudflare. (Dá para criar o
      projeto antes de o DNS propagar.)
- [ ] Repositório privado: o botão **Testar acesso** disse "Acesso confirmado".
- [ ] Na aba **Variáveis**, todas as obrigatórias preenchidas.
- [ ] Na criação, a lista **Guardrails de segurança** não mostra itens em vermelho (os amarelos e cinzas só avisam).
- [ ] Todo `Dockerfile` com `COPY . .` tem um `.dockerignore` que exclui o `.env`.

### Deu errado, e agora?

1. **Leia o log do deploy** (aba **Deploys**, abra o último). O deploy tem 5 etapas: ingestão do código,
   preparação, build e subida, proxy e health check. A etapa que falhou diz onde olhar. Quando um compose
   falha, o log traz um bloco **Por que falhou** com as últimas linhas do serviço doente.
2. **Veja a aba Logs** para o que o app escreveu depois de subir: o estado de cada serviço (rodando,
   saudável, reinícios) e as linhas de log, com os erros marcados. Detalhes em
   [Funcionalidades](features.md#deploy-de-projetos). Segredos aparecem escondidos só em melhor esforço: não
   faça o app escrever senhas no log.
3. **Mensagens comuns:**
   - `faltam variáveis obrigatórias do compose: NOME` : preencha em **Variáveis** e faça o deploy de novo.
   - `Deploy bloqueado: N violação(ões)` : corrija o que a janela mostra ([seção 6](#6-regras-que-barram-o-deploy)).
   - `Tipo de projeto desconhecido` : falta `compose`, `Dockerfile`, `package.json` com `build` ou `index.html`
     ([seção 2](#2-como-o-painel-decide-o-que-fazer)).
   - `Informe a porta exposta pelo container` : faltou `EXPOSE` no `Dockerfile`; informe **Porta do serviço**.
   - `health check falhou` : o app não respondeu a tempo (o painel espera cerca de 1 minuto pelo HTTP e até
     90 segundos pelo HTTPS). Veja a aba **Logs**. As causas mais comuns: o app escuta só em `localhost`, a porta
     do proxy está errada, ou as migrações demoram mais que o prazo. Resposta 4xx na raiz não reprova; 5xx, sim.
   - Certificado que não sai : quase sempre DNS errado ou nuvem laranja no Cloudflare
     ([Solução de problemas](troubleshooting.md#caddy-não-emite-certificado)).
4. **Não resolveu?** [Solução de problemas](troubleshooting.md) e [Ajuda e feedback](help.md).

---

## 8. Usando um assistente de IA

Se um assistente de IA (Claude, ChatGPT, Cursor, Copilot...) está ajudando você a organizar o repositório,
cole o texto abaixo na conversa, **dentro da pasta do projeto**, e deixe-o trabalhar. Troque o que estiver
entre `<...>`.

````text
Prepare este repositório para ser publicado no TWS Panel (PaaS auto-hospedado que roda tudo em containers
Docker, com HTTPS automático por um Caddy central). Faça só alterações no repositório; não rode nada em
servidor e não leia nem mostre o conteúdo de arquivos .env.

Como o painel decide o que fazer, na raiz do repositório, pela primeira regra que servir:
1. Se existir compose.paas.yml, compose.prod.yml, compose.production.yml, docker-compose.prod.yml,
   compose.yml ou docker-compose.yml (nesta ordem), ele é adotado sem ser reescrito.
2. Dockerfile sem package.json: um container, porta da primeira linha EXPOSE.
3. package.json: se tiver `next` sem output "export" e não houver Dockerfile, é Next.js com servidor (o painel
   gera o Dockerfile e roda o servidor). Com script "build": se for Vite, Next com output "export" ou já existir
   out/dist/build com index.html, é site estático (o build roda num Node 22 e a pasta vai para um nginx), mesmo havendo
   Dockerfile. Sem essas pistas e com Dockerfile, usa o Dockerfile.
4. index.html na raiz sem build: site estático.
Um package.json SEM script "build" não conta; para um servidor Node, crie um compose.prod.yml.

Regras obrigatórias:
- Tipo do projeto: <site estático | app com Dockerfile | app com banco | Next.js (export ou servidor) | Laravel>. Porta do app: <3000>.
  Banco/cache: <PostgreSQL | MySQL | Redis | nenhum>. Domínio de exemplo: example.com.
- O app escuta em 0.0.0.0 (não em localhost), na porta declarada em EXPOSE (Dockerfile) ou expose (compose).
- Dockerfile: versão fixa na imagem base, processo sem root (USER; exceção: o Apache oficial do PHP, que
  atende como www-data), sem segredos em ENV/ARG. Todo Dockerfile com "COPY . ." precisa de um .dockerignore
  que exclua .env (e .git, node_modules, vendor): o painel grava as Variáveis num .env na pasta do projeto e,
  sem isso, elas vão para dentro da imagem. Não chame a imagem construída de node, nginx, alpine, caddy nem tws-panel ou paas-*.
- Com mais de um serviço, use compose.prod.yml. Não declare networks (a rede padrão já é interna).
  Use "expose" em vez de "ports" e NUNCA publique portas de banco (5432, 3306, 6379, 27017...), 80 nem 443.
  Dê ao serviço do site um nome como web ou app.
- Dados em volumes nomeados declarados no fim do arquivo. Nunca monte pastas do servidor, "/", o docker.sock
  nem use privileged, cap_add, devices, network_mode: host nem pid: host; evite container_name.
- Bancos com healthcheck, e o app com depends_on condition service_healthy. Migrações no command/entrypoint
  do app (por exemplo "php artisan migrate --force" ou "npm run migrate").
- Segredos NUNCA no arquivo: use ${VAR:?mensagem} para toda senha, chave e token. Usuário do banco diferente
  da senha (use "app", não "postgres" nem "admin"). Nenhum valor como password, admin, root, 123456, changeme.
- Crie um .env.example com os nomes das variáveis e valores de mentira, e garanta .env no .gitignore.
- Imagens de terceiros com versão fixa (nada de :latest) e sem ferramentas de desenvolvimento (phpMyAdmin,
  Adminer, Mailhog, Mailpit) no arquivo de produção.
- Não use campos do compose fora do comum; o painel bloqueia campos que não conhece.
- Package.json sem script "build" + Dockerfile não é reconhecido: para Node com servidor, crie um
  compose.prod.yml mesmo com um serviço só.
- Next.js com servidor sem Dockerfile: o painel gera a imagem; coloque `output: "standalone"` no next.config, commite o lockfile e nunca ponha segredo em NEXT_PUBLIC_* (vai para o JavaScript do site).
- Build estático (Vite, Next export) NÃO recebe as Variáveis do painel: VITE_*/NEXT_PUBLIC_* só com valores
  públicos, num .env.production versionado.
- Laravel: compile os assets do Vite no Dockerfile e instale a extensão phpredis (ou use REDIS_CLIENT=predis).
- Se o serviço do site só tem "expose", avise-me para conferir "Porta do serviço" na tela de detecção
  (o palpite do painel é 80).

Entregue: os arquivos criados ou alterados, a lista das variáveis que preciso preencher na tela Variáveis do
painel (só os nomes, com uma frase sobre o que cada uma é), e como gerar valores seguros
(openssl rand -hex 24). Ao final, confira cada regra acima item por item e diga o que não foi possível cumprir.
````

Quem usa o painel com um assistente de IA no lugar de você também pode ler [Acesso por IA (tokens de API)](ai-access.md):
um token com escopo permite que o assistente consulte projetos e logs sem a sua senha.
