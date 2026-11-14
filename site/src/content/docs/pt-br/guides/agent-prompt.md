---
title: "Instruções para o seu agente de IA"
description: "Um bloco pronto para colar no Claude, ChatGPT, Cursor ou Copilot que trabalha em outro projeto: o que o painel espera do repositório e do compose (regras, portas, health check, e-mail, variáveis) e o que não fazer."
sidebar:
  label: "Instruções para o seu agente de IA"
---

Se um assistente de IA (Claude, ChatGPT, Cursor, Copilot...) está ajudando você a organizar o repositório de
um projeto que vai ser publicado no painel, cole o bloco abaixo na conversa, **dentro da pasta do projeto**, e
deixe-o trabalhar. Troque o que estiver entre `<...>`.

O bloco é a versão resumida de duas páginas. Quando o assistente (ou você) precisar do detalhe, vá a elas:

- [Preparar seu projeto](prepare-project.md): como o painel decide o que fazer, receitas prontas para copiar,
  variáveis, e-mail do projeto e o checklist.
- [Regras do compose](compose-rules.md): cada regra que barra ou avisa, o que passa e o que aceita override.

> [!TIP]
> A maioria dos assistentes consegue ler uma página da web. Além de colar o bloco, você pode passar o endereço
> desta página e das duas acima, para ele conferir o detalhe por conta própria.

## Como usar

1. Abra o assistente **dentro da pasta do projeto** (Claude Code, Cursor, Copilot no editor) ou anexe o
   repositório à conversa.
2. Copie o bloco abaixo e preencha os campos `<...>`: tipo do projeto, porta do app e banco.
3. Leia o que o assistente mudou antes de commitar. Ele não deve mexer em arquivos `.env` nem rodar nada no
   servidor.
4. Faça o push na branch que o painel publica, preencha as variáveis na tela **Variáveis** do painel e rode o
   deploy.

## O bloco

````text
Prepare este repositório para ser publicado no TWS Panel (PaaS auto-hospedado que roda tudo em containers
Docker, com HTTPS automático por um Caddy central). Faça só alterações no repositório; não rode nada em
servidor e não leia nem mostre o conteúdo de arquivos .env.

Meu projeto:
- Tipo: <site estático | app com Dockerfile | app com banco | Next.js (export ou servidor) | Laravel>.
- Porta do app: <3000>. Banco/cache: <PostgreSQL | MySQL | Redis | nenhum>. Envia e-mail: <sim | não>.
- Domínio de exemplo: example.com.

Como o painel decide o que fazer, na raiz do repositório, pela primeira regra que servir:
1. Se existir um arquivo compose, ele é adotado sem ser reescrito. Ordem: compose.paas.yml/.yaml,
   compose.prod.yml/.yaml, compose.production.yml, docker-compose.prod.yml/.yaml,
   docker-compose.production.yml, compose.yml/.yaml, docker-compose.yml/.yaml.
2. Dockerfile sem package.json: um container, porta do EXPOSE do último estágio.
3. package.json: se houver Dockerfile, o Dockerfile tem prioridade (mesmo em Vite ou Next export), com um aviso;
   package.json sem script "build" mas com Dockerfile também usa o Dockerfile. Sem Dockerfile: se tiver `next`
   sem output "export", é Next.js com servidor (o painel gera o Dockerfile). Com script "build": Vite, Next com
   output "export" ou out/dist/build com index.html é site estático (build num Node 22, pasta servida por nginx).
4. index.html na raiz sem build: site estático.
O tipo também pode ser escolhido à mão na tela de detecção (o painel confere se o código serve).

Portas e rede:
- O app escuta em 0.0.0.0 (não em localhost), na porta declarada em EXPOSE (Dockerfile) ou expose (compose).
  O painel usa a primeira porta de expose como "Porta do serviço"; sem expose nem ports, o palpite é 80.
  Avise-me para conferir a "Porta do serviço" na tela de detecção.
- Com mais de um serviço, use compose.prod.yml. Dê ao serviço do site um nome como web ou app. Não declare
  networks (a rede padrão já é interna) e nunca entre nas redes do painel (paas-*, tws-*, qualquer rede
  paas-mail*): o painel liga o serviço web ao proxy sozinho.
- Use "expose" em vez de "ports". NUNCA publique portas de banco (5432, 3306, 6379, 27017...), portas internas
  (9000 do PHP-FPM, 11211, 5672, 8025, 2375...), 80 nem 443. O HTTPS é feito pelo painel.
- Se o projeto traz o próprio proxy HTTPS (Caddy, Traefik), crie um compose.paas.yaml sem as portas 80/443 e
  com o proxy falando HTTP simples.

Health check e subida:
- Depois de subir, o painel confere se o site responde: cerca de 1 minuto para HTTP e até 90 segundos para
  HTTPS. Um 5xx na raiz reprova o deploy; um 4xx não. As migrações precisam terminar dentro desse prazo.
- Bancos com healthcheck, e o app com depends_on condition service_healthy. Migrações no command/entrypoint
  do app (por exemplo "php artisan migrate --force" ou "npm run migrate").

Imagens e Dockerfile:
- Versão fixa na imagem base, processo sem root (USER; exceção: o Apache oficial do PHP, que atende como
  www-data), sem segredos em ENV/ARG. Todo Dockerfile com "COPY . ." precisa de um .dockerignore que exclua
  .env (e .git, node_modules, vendor); o painel já tira do build o .env que ele grava, mas o .dockerignore
  protege o build fora do painel.
- Não chame a imagem construída de node, nginx, alpine, caddy, stalwart, roundcube, tws-panel nem paas-* (com
  build:, não ponha image: node ao lado; use um nome seu, como example-app:1.0).
- Contexto de build e Dockerfile dentro do repositório (nada de context: .., caminho do servidor ou URL Git).
- Imagens de terceiros com versão fixa (nada de :latest) e sem ferramentas de desenvolvimento (phpMyAdmin,
  Adminer, Mailhog, Mailpit, pgAdmin) no arquivo de produção.

Volumes e o que é proibido:
- Dados em volumes nomeados declarados no fim do arquivo, sem name:, external nem driver. Uma pasta dentro do
  projeto (./uploads:/app/uploads) serve.
- Nunca monte pastas do servidor, "~", "/", o docker.sock, /var/lib/docker nem /run; nunca use privileged,
  cap_add, devices, sysctls, network_mode: host, pid: host nem external_links; evite container_name e hostname.
  Nenhum nome de container, serviço, volume ou rede começando com paas ou tws, e nenhuma label começando com
  paas. ou com.docker.compose. (a label tws.mail, abaixo, é a exceção que o painel lê).
- Não use campos do compose fora do comum; o painel bloqueia campos que não conhece (campos x-... são livres).

Variáveis e segredos:
- Segredos NUNCA nos arquivos: use ${VAR:?mensagem} para toda senha, chave e token (o deploy para e diz qual
  falta). Usuário do banco diferente da senha (use "app", não "postgres" nem "admin"). Nenhum valor como
  password, admin, root, 123456, changeme, nem com menos de 6 caracteres.
- Crie um .env.example com os nomes das variáveis e valores de mentira (ele alimenta as sugestões do painel),
  e garanta .env no .gitignore. Se o .env.example for o de desenvolvimento, crie também um .env.prod.example só
  com o que a produção usa: com ele, o painel sugere só esses nomes.
- Node com servidor, package.json sem script "build" e com Dockerfile: o painel usa o Dockerfile (porta do
  EXPOSE do último estágio).
- Next.js com servidor sem Dockerfile: o painel gera a imagem; coloque output: "standalone" no next.config,
  commite o lockfile e nunca ponha segredo em NEXT_PUBLIC_* (vai para o JavaScript do site).
- Build estático (Vite, Next export) só recebe as Variáveis marcadas "de build" no painel (ou valores públicos
  num .env.production versionado): VITE_*/NEXT_PUBLIC_* só com valores públicos, nunca segredo. NEXT_PUBLIC_*
  num Dockerfile pede o ARG correspondente. Para SPA com rotas no navegador, avise-me para ligar
  "Aplicação de página única".
- Laravel: compile os assets do Vite no Dockerfile e instale a extensão phpredis (ou use REDIS_CLIENT=predis).

E-mail (só se o app envia e-mail):
- Não acrescente servidor de e-mail nem container SMTP. Com a aba E-mail do projeto ativada, o painel entrega
  ao app SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM e MAIL_FROM_NAME a cada deploy. Prefira ler
  esses nomes. Se o app lê outros nomes (MAIL_HOST, MAIL_PASSWORD...), deixe-os obrigatórios no compose
  (MAIL_HOST: ${MAIL_HOST:?}) e liste-os para mim: eu os ligo aos valores do e-mail na tela do painel.
- Só os serviços que podem enviar e-mail (app, worker, scheduler) entram na rede de e-mail; bancos e caches
  ficam de fora de propósito e o app continua falando com eles pela rede do próprio projeto. Só se um serviço
  de imagem de banco de fato envia e-mail, acrescente nele a label tws.mail=true; tws.mail=false tira um
  serviço da rede de e-mail.

Entregue: os arquivos criados ou alterados; a lista das variáveis que preciso preencher na tela Variáveis do
painel (só os nomes, com uma frase sobre o que cada uma é) e os nomes de e-mail que preciso ligar, se houver;
e como gerar valores seguros (openssl rand -hex 24). Ao final, confira cada regra acima item por item e diga o
que não foi possível cumprir.
````

## O que o bloco deixa de fora de propósito

- **Ele não faz deploy.** O assistente só muda o repositório. O deploy, as variáveis e o domínio ficam com
  você no painel (ou com um assistente que você autorizou, abaixo).
- **Ele não vê segredos.** O bloco proíbe ler arquivos `.env`. Os valores vão direto para a aba **Variáveis**.
- **Ele não substitui as travas.** Mesmo que o assistente erre, o painel confere o compose antes do deploy e
  para com a explicação. Veja [Conferindo antes do deploy](compose-rules.md#conferindo-antes-do-deploy).

## Quando o assistente também opera o painel

Se um assistente vai usar o painel no seu lugar (consultar projetos e logs, fazer deploy), não entregue a sua
senha. Leia [Acesso por IA (tokens de API)](ai-access.md), para um token com escopo limitado, e
[Assistente de IA (MCP)](mcp.md), para a conexão com aprovação humana das ações sensíveis.
