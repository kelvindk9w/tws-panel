---
title: "Como escrever um compose que o painel aceita"
description: "O que cada trava de segurança do deploy barra, como escrever o compose e o Dockerfile para passar, como ler a mensagem de erro e o que mudar."
sidebar:
  label: "Regras do compose"
---

Antes de subir um projeto, o painel confere o compose contra uma lista do que um projeto hospedado pode pedir
ao Docker. O que está fora da lista é um **bloqueio** e o deploy para. Esta página mostra o que cada regra
barra, como escrever o projeto para passar e como ler a mensagem quando não passa.

> [!NOTE]
> **Idioma da interface.** Os nomes das regras (`host-mount`, `db-port-exposed`...) são iguais nos dois idiomas, mas o **título**, a **evidência** e a **sugestão de correção** de cada bloqueio vêm do servidor em português, mesmo com a interface em inglês. Esta página cita cada um como aparece.

> Leia também: [Deploy bloqueado por guardrail](troubleshooting.md#deploy-bloqueado-por-guardrail) para o override
> e a auditoria, e [Segurança](../reference/security.md) para saber por que as regras existem.

---

## Quando a conferência roda

O painel confere o projeto três vezes, e a mensagem muda de uma para a outra:

1. **Ao clicar em Deploy.** O painel lê o compose como está escrito e, se algo bloqueia, abre a janela
   **Deploy bloqueado pelos guardrails** antes de criar o job. É aqui que você vê o cartão completo de cada bloqueio.
2. **Depois de baixar o código.** A mesma conferência roda de novo sobre o código que foi de fato obtido (ele pode ter
   mudado desde a primeira, principalmente em projeto Git).
3. **No compose resolvido, logo antes do `docker compose up`.** O painel pede ao Docker o compose do jeito que ele
   vai rodar (`include`, `extends`, mesclas e `${VARIÁVEL}` já resolvidos) e confere esse. Pega o que a primeira
   conferência não conseguia ver, por exemplo uma pasta que só existe quando uma variável é preenchida. A falha aqui é
   um **deploy que falha** com a mensagem no log, não a janela do passo 1.

Só avisos (`warn`) e informações (`info`) nunca param um deploy.

## Como ler a mensagem

Cada bloqueio da janela tem este formato:

| Parte | Exemplo | O que diz |
|---|---|---|
| Etiqueta | `block` | `block` para o deploy; `warn` e `info` só avisam. |
| Título | `Pasta do servidor montada no container` | O tipo de problema. |
| `[regra]` | `[host-mount]` | O nome da regra. Procure-o na [tabela abaixo](#o-que-cada-regra-barra). |
| Evidência | `compose.yml: serviço "app" monta /srv/uploads de fora da pasta do projeto` | **Arquivo, serviço e o ponto exato do problema.** Aqui: o serviço `app` monta `/srv/uploads`. |
| 💡 | `Só é permitido montar pastas DENTRO do código do projeto (ex.: ./dados). Use um volume nomeado para o resto.` | O que mudar. |

As mesmas linhas vão para o log do deploy no formato `✖ BLOCK [regra] título — evidência`. **O log não repete a
sugestão 💡**; para vê-la, use a linha da regra na tabela abaixo.

As mensagens de resumo que você pode ver:

- `Deploy bloqueado: N violação(ões) de segurança (block). Corrija ou confirme o override explícito.`: a janela do
  passo 1. N é o número de bloqueios. Corrija ou, se a regra permitir, confirme o override.
- `guardrail_blocked: N bloqueio(s) de segurança no compose resolvido — deploy requer override explícito.`: passo 3, regra
  que o override pode liberar. As linhas dos bloqueios estão logo acima, no log, sob o título
  **Guardrails sobre o compose resolvido (docker compose config)**.
- `guardrail_blocked: N bloqueio(s) de isolamento do painel no compose resolvido — sem override possível.`: passo 3,
  regra que protege o painel. O log diz "Estes bloqueios protegem o próprio painel e não têm override".
  **O único caminho é mudar o compose.**
- `o docker compose não conseguiu interpretar o compose do projeto: ...`: o compose tem erro de sintaxe ou de
  referência. Não é guardrail: corrija o arquivo. O texto depois dos dois-pontos é a mensagem do próprio Docker.
- `faltam variáveis obrigatórias do compose: NOME, ...`: também não é guardrail. Preencha as variáveis na seção
  **Variáveis** do projeto e faça o deploy de novo.

> [!TIP]
> A maioria dos bloqueios se resolve seguindo a sugestão 💡. Antes de fazer override, leia
> [quais bloqueios aceitam](#quais-bloqueios-aceitam-override).

---

## O que cada regra barra

### Sempre bloqueiam, com override

| Regra | O que barra | Como escrever para passar |
|---|---|---|
| `db-port-exposed` | Publicar em `ports` uma porta de banco do container: 5432 (PostgreSQL), 3306 (MySQL/MariaDB), 6379 (Redis), 27017 (MongoDB), 1521 (Oracle), 1433 (SQL Server), 5984 (CouchDB), 9200 (Elasticsearch). Vale a porta do **container**: `"15432:5432"`, `"5432"` (porta aleatória no host) e `"127.0.0.1:5432:5432"` também bloqueiam. | Apague a linha de `ports`. Os outros serviços chegam ao banco pelo nome do serviço (`db:5432`) na rede interna do projeto. Para olhar de vez em quando, use túnel SSH. Sem mexer no repositório, **Visão geral → Containers → Portas** remove a publicação, e publicá-la de novo ali só em `127.0.0.1` vira aviso, não bloqueio. |
| `weak-credentials` | No `environment` de um serviço: variável cujo nome contém `PASSWORD`, `PASSWD`, `SECRET`, `TOKEN`, `API_KEY` ou `PRIVATE_KEY` com valor trivial (`password`, `admin`, `root`, `123456`, `postgres`, `mysql`, `redis`, `mongo`, `changeme`, `test`, `dev`...), com menos de 6 caracteres ou no formato `usuario:usuario`; e variável de usuário (`...USER`, `...USERNAME`, `...LOGIN`) com o mesmo valor de uma variável de senha do mesmo serviço. | Use um valor longo e aleatório e mantenha-o fora do repositório Git: `POSTGRES_PASSWORD: ${DB_PASSWORD}` com `DB_PASSWORD` preenchida nas **Variáveis** do projeto. Use um usuário diferente da senha (`app`, não `postgres`/`admin`). |
| `privileged-container` | `privileged: true`; `cap_add`; `devices` e `device_cgroup_rules`; `security_opt` diferente de `no-new-privileges`; `sysctls`; `provider`; e os campos `use_api_socket`, `gpus`, `runtime`, `cgroup_parent`, `storage_opt`, `credential_spec`, `deploy.resources.reservations.devices`; gancho `post_start`/`pre_stop` com `privileged`. | Remova o campo. Se o serviço precisa de algo específico, procure a opção mais estreita em vez de dar tudo. `security_opt: ["no-new-privileges:true"]` é aceito. |
| `host-namespace` | `pid`, `ipc`, `network_mode`, `cgroup`, `uts`, `userns_mode` que compartilham o namespace do servidor (`network_mode: host`, `pid: host`...) ou de outro container; `volumes_from: container:...`; `external_links`. | Remova o campo. `network_mode: service:outro` (com outro serviço **do mesmo compose**) é aceito, assim como `bridge`, `none` e os padrões. Para um serviço ser alcançado, use a rede do projeto e o nome do serviço. |
| `host-mount` | Bind (`/caminho:/caminho`) de pasta **fora** da pasta do código do projeto, `~/...`, ou tipo de montagem diferente de volume/bind/tmpfs; bind **dentro de outro bind gravável** (por exemplo `./:/app` mais `./dados:/data`); e contexto de build, Dockerfile, `env_file`, `secrets` e `configs` dentro de um bind gravável; `label_file`. | Use um volume nomeado (`dados:/data`, declarado no fim do arquivo) ou uma pasta dentro do projeto (`./uploads:/app/uploads`). No caso de bind dentro de bind, monte a pasta de cima como `:ro` (`.:/app:ro`) ou separe as pastas. |
| `shared-resource` | Volume ou rede que não é do projeto: `external: true`, `name:` diferente de `<projeto>_<chave>`, `driver` diferente de `local` (volume) ou `bridge`/`overlay` (rede), `driver_opts`. | Declare o volume ou a rede sem `external`, sem `name:` e sem `driver`. |
| `build-outside-src` | Em `build`: `context`, `dockerfile` ou `additional_contexts` fora da pasta do projeto ou URL/Git remoto; `cache_from`/`cache_to` com `type=local` (ou qualquer tipo diferente de `registry`/`inline`), com `src=`/`dest=` ou com chave repetida; `privileged`, `entitlements` ou `ssh`; `network` diferente de `default`/`none`/`bridge`. Também: `env_file`, `secrets` e `configs` com arquivo fora da pasta, ou `external`. | Mantenha o contexto, o Dockerfile e os arquivos que eles leem **dentro** do repositório. Para cache de build, use `type=registry` ou `type=inline`. |
| `unsupported-field` | Qualquer campo do compose que não esteja na lista aceita pelo painel, inclusive dentro de `build`, `deploy`, `logging` e no topo do arquivo. O topo aceita só `name`, `services`, `networks`, `volumes`, `secrets`, `configs` (e `x-...`). Também `logging` com driver de rede (`gelf`, `fluentd`...) ou `syslog-address`. | Remova o campo que a evidência cita. Campos `x-...` são sempre livres. Um campo novo do Compose precisa ser avaliado antes de ser aceito. |
| `invalid-compose` | O compose não é um YAML válido. | Corrija a sintaxe (indentação, `:` faltando). A 💡 só diz "Corrija a sintaxe do arquivo compose antes de deployar". |
| `proxy-port-conflict` | Publicar a porta 80 ou 443 do servidor. Em projeto comum é só **aviso** (o painel retira a publicação sozinho e o site responde pelo proxy). É **bloqueio** quando o projeto tem proxy HTTPS próprio (Caddy/Traefik). | Remova `80:80` e `443:443`. Com proxy próprio, crie um `compose.paas.yaml` no repositório (o painel dá prioridade a ele) sem essas portas e com o proxy falando HTTP puro. **Sem override neste caso.** |

### Sempre bloqueiam, sem override

Protegem o próprio painel. Confirmar o override na janela não adianta: o deploy falha no passo 3 com "sem override
possível". É preciso mudar o compose.

| Regra | O que barra | Como escrever para passar |
|---|---|---|
| `panel-resource` | Qualquer bind que **seja ou contenha** o socket do Docker (`/var/run/docker.sock`, em qualquer grafia, ou um link para ele), `/`, `/proc`, `/sys`, qualquer coisa em `/run` e `/var/run`, `/var/lib/docker`, o `/data` do painel, a pasta dos projetos (fora do seu próprio projeto) e a pasta de instalação do painel. Volumes e redes do espaço do painel (`paas_*`, `paas-*`, `tws-*`). | Não monte essas pastas. Um projeto que precisa conversar com o Docker não é um projeto para este painel. Renomeie qualquer volume ou rede que comece com `paas`/`tws`. |
| `network-hijack` | Ligar-se à mão às redes do painel (a do proxy, a de administração do e-mail, a de entrega do e-mail); declará-las com `driver`, `ipam` ou sem `external`; aliases a mais nelas. Só o serviço que atende o site é ligado à rede do proxy, e pelo painel. | Apague a entrada de `networks:` que aponta para essas redes. O painel liga o serviço web à rede do proxy sozinho. |
| `reserved-name` | `container_name`, `hostname`, nome de serviço (do serviço web) ou alias igual a um nome do painel (`tws-panel`, `paas-caddy`, `paas-stalwart`, `paas-webmail`), de outro projeto, ou começando com `paas-`/`tws-`/`paas_`/`tws_`; labels começando com `paas.` ou `com.docker.compose.`. Com e-mail habilitado, também nomes começando com `mail.` e os nomes dos hosts de e-mail. | Escolha outro nome, ou simplesmente remova `container_name`. Não defina labels `paas.*`. |
| `panel-image` | Imagem ou tag de build que seja `tws-panel` ou `paas-...` de outro projeto; e `build` que grave a tag de uma imagem que o painel roda (`alpine`, `caddy`, `nginx`, `node`, `stalwart`, `roundcube`). | Ao usar `build:`, não coloque `image: node:20` (nem esses nomes) ao lado: use um nome seu, como `image: example-app:1.0`, ou remova `image`. |

### Avisos e informações (nunca param o deploy)

| Regra | Nível | O que sinaliza | O que fazer |
|---|---|---|---|
| `dev-service-in-prod` | warn | Imagem de ferramenta de desenvolvimento: Mailhog, Mailpit, phpMyAdmin, Adminer, pgAdmin, MongoDB Compass, RedisInsight, Selenium, ou qualquer imagem com `debug` no nome. | Deixe só no compose de desenvolvimento. |
| `secret-in-code` | warn | Provável segredo comitado (chave AWS, chave privada PEM, tokens do GitHub, Slack, Google, Stripe, ou `...SECRET`/`TOKEN`/`API_KEY`/`PASSWORD = "valor longo e denso"`) em arquivos `.js`, `.ts`, `.py`, `.php`, `.json`, `.yml`, `.env*`, `.sql` e semelhantes. | Tire do código, **considere a credencial comprometida e troque-a**, e passe-a como variável do projeto. |
| `latest-tag` | info | Imagem sem versão ou com `:latest`. | Fixe a versão: `redis:7.2-alpine`. |

---

## Quais bloqueios aceitam override

- **A janela do passo 1** oferece **Entendo os riscos e quero fazer o deploy mesmo assim (override)** para todo
  bloqueio, exceto o de `proxy-port-conflict` com proxy próprio. O override é **auditado** (`guardrail.override`) e o
  log diz "Override explícito do operador".
- **As quatro regras sem override** (`panel-resource`, `network-hijack`, `reserved-name`, `panel-image`) são
  recusadas de novo no passo 3, mesmo que você tenha confirmado o override na janela. Não perca tempo com isso: mude o compose.
- Um bloqueio achado só no **passo 3** (compose resolvido) faz o deploy falhar sem janela. Veja
  [os limites abaixo](#limites-conhecidos-das-mensagens).

---

## Escrevendo o compose: antes e depois

Um compose com vários dos problemas acima (tudo aqui é exemplo: `example.com`, nada real):

```yaml
# antes: bloqueado
services:
  app:
    build: .
    image: node:20
    container_name: tws-panel
    privileged: true
    ports:
      - "443:443"
    volumes:
      - /srv/uploads:/app/uploads
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      DATABASE_URL: postgres://app:secret-pass@db:5432/app
  db:
    image: postgres
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: admin
```

O que o painel diz, na ordem do compose:

- `app` — `image: node:20` com `build:` → `panel-image` (sem override).
- `app` — `container_name: tws-panel` → `reserved-name` (sem override).
- `app` — `privileged: true` → `privileged-container`.
- `app` — publica `443` → `proxy-port-conflict` (aviso aqui; o painel retira).
- `app` — `/srv/uploads` → `host-mount`.
- `app` — `/var/run/docker.sock` → `panel-resource` (sem override).
- `db` — publica `5432` → `db-port-exposed`.
- `db` — `POSTGRES_PASSWORD: admin` → `weak-credentials`.
- `db` — `postgres` sem versão → `latest-tag` (info).

O mesmo projeto, escrito para passar:

```yaml
# depois: aceito
services:
  app:
    build: .
    image: example-app:1.0
    expose:
      - "3000"
    volumes:
      - ./uploads:/app/uploads
    environment:
      DATABASE_URL: postgres://app:${DB_PASSWORD}@db:5432/app
    depends_on:
      - db
  db:
    image: postgres:16-alpine
    volumes:
      - dbdata:/var/lib/postgresql/data
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${DB_PASSWORD}

volumes:
  dbdata:
```

Preencha `DB_PASSWORD` nas **Variáveis** do projeto (por exemplo o resultado de `openssl rand -hex 24`) antes do deploy.
O site é alcançado pelo domínio do projeto: você não publica `3000`, `80` nem `443`.

### Outro caso comum: a pasta inteira como bind

No desenvolvimento é comum escrever `.:/app`. Junto de um `Dockerfile` ou de um `env_file: .env` na raiz do
repositório, o painel bloqueia (`host-mount`, "Arquivo lido pelo painel dentro de uma pasta montada com escrita"),
porque o app poderia trocar essa pasta por um link para o servidor e o painel a leria durante o build.

```yaml
# antes: bloqueado
services:
  web:
    build: .
    env_file: .env
    volumes:
      - .:/app

# depois: aceito
services:
  web:
    build: .
    env_file: .env
    volumes:
      - .:/app:ro
      - ./storage:/app/storage   # só se o app precisar gravar aqui
```

Melhor ainda, em produção: não monte o código. O `build:` já o copia para a imagem (`COPY . .`), e o volume serve só
para dados (`dados:/app/storage`).

## Escrevendo o Dockerfile

O painel não lê as instruções do Dockerfile; ele confere a seção `build` do compose e os arquivos que o build
alcança. Para não ser barrado:

- Mantenha o **contexto de build e o Dockerfile dentro do repositório.** `context: ..`, `context: /srv/app` ou
  contexto `git@...` são bloqueios; um Dockerfile em subpasta (`dockerfile: docker/Dockerfile`) é aceito.
- `COPY`/`ADD` só alcançam o que está no contexto. Tudo que a imagem precisa (a aplicação, configuração) tem que estar no
  repositório, não numa pasta do servidor.
- Não peça ao build `privileged`, `ssh`, `entitlements` nem `network: host`.
- Não chame a imagem que você constrói de `node`, `nginx`, `alpine`, `caddy`, `stalwart`, `roundcube`, `tws-panel`
  nem `paas-...`. Use um nome seu.
- Não escreva a senha em `ENV` ou `ARG` nem num `.env` comitado: a varredura de `secret-in-code` olha `.env*`,
  `.yml`, `.json`, `.py`, `.js`... e a credencial ficaria no histórico da imagem. Use uma variável do projeto.
- Use versão fixa no `FROM` (`FROM node:20-alpine`); `latest-tag` é só informação, mas deixa o deploy repetível.

## Conferindo antes do deploy

1. Abra o projeto e veja a contagem de guardrails na página (**Guardrails (N)**) ou, na tela de criação,
   **Guardrails de segurança (N)**: vêm da mesma conferência, sem fazer deploy.
2. Corrija as linhas `block`. As linhas `warn` e `info` podem ficar.
3. Faça o deploy. Se falhar no passo 3, leia o log a partir de **Guardrails sobre o compose resolvido (docker compose config)**.

---

## Limites conhecidos das mensagens

- As linhas de log de um bloqueio trazem o título e a evidência, **sem** a sugestão 💡. Se você só tem o log,
  use a tabela acima.
- Um bloqueio achado só no compose resolvido (passo 3) **não** aparece na janela e a página do projeto não tem botão
  para fazer override dele, embora o resumo diga "deploy requer override explícito". O caminho prático é mudar o
  compose. Causa típica: uma `${VARIÁVEL}` que, preenchida, vira um caminho fora do projeto.
- A janela oferece o override para as quatro regras que nunca o aceitam; a recusa só vem depois, no log.
