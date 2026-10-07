# Relatório — webmail (03 e 04/10/2026)

Branch `feat/webmail`, criada a partir de `origin/dev`. Este repositório é público:
nada aqui tem IP real, senha, domínio real ou nome de cliente. `exemplo.com.br`,
`exemplo.test`, `203.0.113.x` e `198.51.100.x` são valores de exemplo.

## O pedido

O dono do produto pediu, em 04/10/2026, um **webmail**. As pessoas devem ler,
responder e enviar e-mails das caixas (contato@, suporte@…) pelo navegador, sem
configurar Outlook ou Gmail.

## O que passou a acontecer (pelo comportamento)

### Na página E-mail

- **Card "Webmail" novo.** Ele aparece quando há pelo menos um domínio de e-mail e
  mostra:
  - o estado: **desativado**, **ativo** ou **parado**;
  - uma orientação em português quando falta algo, como "O servidor de e-mail está
    parado" ou "Cadastre um domínio";
  - o botão verde **Ativar webmail**, que só fica disponível com o servidor de e-mail
    rodando;
  - o botão vermelho **Desativar**, que pede confirmação;
  - com o webmail ativo, um botão azul **Abrir webmail** para cada domínio, que abre
    `https://mail.<domínio>/` numa aba nova;
  - quando o certificado de verdade ainda não foi instalado, um aviso de que o webmail
    funciona e passa a conferir o certificado sozinho;
  - quantas conexões estão bloqueadas agora por excesso de senhas erradas;
  - uma nota para leigo: entrar com o endereço completo e a senha da caixa; a sessão
    termina depois de 10 minutos sem uso; 10 senhas erradas bloqueiam por 1 hora.
- **Em cada caixa** (aba Caixas da página do domínio e e-mail do projeto): com o
  webmail ativo, entra o botão azul **Abrir webmail**. Ele abre o webmail do domínio da
  caixa com o usuário já preenchido (`?_user=contato%40…`). A senha nunca vai na URL.

### No endereço `https://mail.<domínio>/`

- **Webmail desativado:** continua a página "Servidor de e-mail" de antes.
- **Webmail ativado:** abre a tela de login do webmail, em português.
  - A pessoa lê, responde e envia como a própria caixa.
  - Ela não consegue trocar o endereço de envio.
  - Ela não consegue apontar o webmail para outro servidor.
- **Webmail fora do ar:** aparece a página amigável "Webmail temporariamente
  indisponível", que se atualiza sozinha.
- **Quem errar a senha 10 vezes em 10 minutos:** recebe "Muitas tentativas de entrar"
  (HTTP 429) por 1 hora. O bloqueio fica registrado na Auditoria.
- **Certificado:** a emissão não muda. O bloco de `mail.<domínio>` continua no
  Caddyfile nos dois casos, e o painel continua copiando o certificado para o Stalwart.

### Por baixo

- **Container `paas-webmail`** (Roundcube 1.7.4):
  - fica na `paas-net` **sem porta publicada**, então só o Caddy o alcança;
  - os dados ficam no volume `paas_webmail_data` (SQLite com preferências, contatos e
    sessões; as mensagens continuam no Stalwart);
  - roda sem nenhuma capability do Linux, com `no-new-privileges` e limite de 256 MB.
- **Junto com o servidor de e-mail:**
  - parar o servidor de e-mail para o webmail;
  - iniciar o servidor sobe o webmail de novo, se ele estiver ativado;
  - a sincronização de hora em hora, e a que roda ao adicionar ou remover um domínio,
    regrava a configuração do webmail (nomes aceitos e conferência do certificado) sem
    reiniciar.
- **Auditoria:** registra `mail.webmail.enable`, `mail.webmail.disable` e
  `mail.webmail.block`.

## Decisões

### 1. Qual webmail: Roundcube 1.7.4

| Critério | Roundcube | SnappyMail |
|---|---|---|
| Imagem Docker oficial e mantida | `roundcube/roundcubemail`, do próprio projeto; tags novas em 28/09/2026 | imagem do autor; última versão do projeto: 2.38.2, de **out/2024** |
| Ritmo de correções em 2026 | versão de segurança quase todo mês: 1.7.0 (10/05), 1.7.1 (24/05), 1.7.2 (05/07), 1.7.3 (09/08), 1.7.4 (06/09) | nenhuma versão desde out/2024 (a CVE-2024-45800, de mXSS, foi a última corrigida) |
| Banco | SQLite embutido (o padrão da imagem sem banco externo) | arquivos |
| Painel administrativo | **não existe**; o instalador vem desligado (`enable_installer=false`) e responde 404 | existe, na própria URL (`?admin`), e precisa ser protegido |
| Mesmo login no IMAP e no SMTP | sim (`smtp_user %u`, `smtp_pass %p`) | sim |
| IMAP/SMTP com SSL ou STARTTLS | sim, com opções de TLS por conexão | sim |
| Usuário preenchido pela URL | sim, `?_user=` (conferido no código: `get_input_string('_user', INPUT_GPC)`) | não encontrado |
| Português | `pt_BR` | sim |
| Tamanho | ~265 MB (variante Apache "nonroot") | menor |

**Escolha: Roundcube.** O ritmo de correção e o fato de não ter painel de administração
pesaram mais que o tamanho. O Roundcube tem histórico de XSS: em 2026, por exemplo, a
CVE-2026-54432 e a CVE-2026-54433, corrigidas na 1.7.2/1.6.17. Em 2025 houve também uma
execução remota de código depois do login, explorada na prática (CVE-2025-49113). A
defesa principal é manter a imagem atualizada. Por isso ela está fixada e a troca de
versão é um passo explícito.

**Imagem fixada (tag E digest):**
`roundcube/roundcubemail:1.7.4-apache-nonroot@sha256:533b48d35f8fef99f24ae6997a032a727888d6992bd55a1a0a24d1ea208dbf3f`

- O digest foi conferido com `docker pull` (RepoDigests).
- Variante **nonroot**: o Apache roda como `www-data` (uid 33), na porta 8000.
- A linha 1.7 é a atual. A 1.6 é LTS e também recebe correções; não foi usada para não
  precisar migrar logo.

Fontes:
- Versões do Roundcube: <https://roundcube.net/news/releases/> (1.7.4 e 1.6.19 em 06/09/2026, "security updates").
- Tags e digests da imagem: <https://hub.docker.com/v2/repositories/roundcube/roundcubemail/tags> (1.7.4-apache-nonroot, 28/09/2026).
- CVEs de 2026 (1.7.2/1.6.17): <https://forum.directadmin.com/goto/post?id=401090>, <https://vpncentral.com/?p=253375>.
- SnappyMail, versões: <https://github.com/the-djmaze/snappymail/releases> (2.38.2, 09/10/2024; CVE-2024-45800 na 2.38.0).
- Bloqueio automático do Stalwart: <https://www.stalw.art/docs/server/auto-ban> e o código da tag v0.11.8 (`crates/common/src/listener/blocked.rs`; `crates/jmap/src/api/management/settings.rs`).
- O resto foi lido de dentro da imagem: o entrypoint (inclusão de `/var/roundcube/config/*.php`, SQLite padrão), `config/defaults.inc.php` (`login_rate_limit`, `proxy_whitelist`, `trusted_host_patterns`, `session_*`) e `rcmail_output_html.php` (`_user` pela URL).

### 2. Como o webmail fala com o servidor de e-mail

- O webmail fala com o Stalwart pela rede interna, com **TLS implícito nos dois
  protocolos**: IMAP `ssl://<nome>:993` e SMTP `ssl://<nome>:465`. Nunca há conversa
  em texto puro, nem por um instante.
- **`<nome>`** é um alias do `paas-stalwart` na `paas-net`. A ordem de preferência é:
  1. o hostname do servidor, se o certificado dele já foi instalado no Stalwart;
  2. senão, outro `mail.<domínio>` com certificado instalado;
  3. senão, o hostname.
- **Com certificado instalado (o normal):** o webmail confere a cadeia **e** o nome
  (`verify_peer`, `verify_peer_name`, `peer_name`). O Let's Encrypt já está na lista de
  CAs da imagem.
- **Sem certificado instalado** (servidor recém-criado, emissão pendente):
  - a conexão é cifrada, mas sem conferir o nome (`verify_peer=false`,
    `allow_self_signed`);
  - motivo: o Stalwart ainda usa o autoassinado, e com a conferência ligada ninguém
    entraria;
  - risco: a conexão não sai da `paas-net`;
  - o card avisa a pessoa;
  - a sincronização seguinte troca para "conferir" sozinha, sem reiniciar.
- **Alternativa descartada:** aceitar sempre o certificado interno sem conferir. Ela
  deixaria a conferência desligada para sempre, sem necessidade.

### 3. Bloqueio de quem erra a senha

**Descoberta no Stalwart real.** O Stalwart v0.11.8 bloqueia **para sempre** o IP que
erra a senha 100 vezes num dia (`server.auto-ban.auth.rate`, padrão `100/1d`, gravado em
`server.blocked-ip.<ip>`). Todo login do webmail chega do IP do container. Então 100
senhas erradas de quaisquer visitantes num dia derrubariam o webmail de todo mundo.

O que o painel faz:

- **Isenta o IP do `paas-webmail` no Stalwart.**
  - Usa `server.allowed-ip.<ip>`, por `POST /api/settings` + `GET /api/reload`, sem
    reiniciar.
  - Desfaz um bloqueio que esse IP já tenha.
  - Troca a isenção quando o IP muda.
- **Bloqueia o IP real no Caddy.**
  - O Caddy é a borda, então enxerga o IP de verdade.
  - A cada minuto o painel lê as linhas "Failed login for … (X-Forwarded-For: <ip>)" do
    log do Roundcube.
  - Com 10 erros em 10 minutos, aquele IP recebe 429 por 1 hora.
- **Nunca bloqueia IP interno.** Se o Docker entregar ao Caddy o IP do gateway, bloquear
  seria bloquear todos.
- **Limite do próprio Roundcube:** 3 erros por minuto por caixa (`login_rate_limit`). Ele
  vale para caixas que já entraram no webmail alguma vez.
- **fail2ban (Fase 04): não incluí o jail.** O tráfego do webmail entra pela porta
  publicada do Caddy, que o Docker encaminha pela cadeia FORWARD/DOCKER-USER. A ação
  `nftables-multiport` do `jail.local` bane na INPUT e não bloquearia nada. Além disso, o
  log do container fica num arquivo do Docker cujo caminho muda com o ID. O bloqueio no
  Caddy cumpre o papel sem depender disso.

### 4. Painel administrativo, cadastro e plugins do webmail

- **Painel e cadastro:** o Roundcube não tem painel de administração nem cadastro.
  - O instalador fica desligado (404, conferido).
  - Arquivos internos (`config/`, `logs/`, `temp/`, `SQL/`, `composer.json`) também
    respondem 404, conferido.
- **Plugins:** só `archive` e `zipdownload` (desde 04/10/2026, também o `paas_identity`
  do painel; ver a seção "Nome de exibição das caixas"). Corretor ortográfico desligado
  (ele chamaria serviço externo).
- **Login e identidade:**
  - só o endereço completo é aceito no login (`login_username_filter=email`);
  - uma identidade por caixa, sem trocar o endereço (`identities_level=3`);
  - a versão não aparece na tela de login.
- **Sessão:**
  - termina com 10 minutos sem uso;
  - cookie `Secure`, `HttpOnly` e `SameSite=Strict` (conferido no cabeçalho);
  - `X-Frame-Options: deny`;
  - o cabeçalho `Host` só é aceito para os `mail.<domínio>` cadastrados;
  - a chave da sessão (AES-256) é gerada uma vez e guardada em `data/mail/webmail.json`
    (0600).
- **Cabeçalhos no Caddy:**
  - `Strict-Transport-Security max-age=31536000`, `X-Content-Type-Options nosniff`,
    `Referrer-Policy no-referrer` e `Permissions-Policy`;
  - os cabeçalhos `Server` e `X-Powered-By` do Apache são removidos;
  - sem CSP: o Roundcube 1.7 não envia uma e usa scripts inline, então uma CSP feita por
    fora quebraria a tela. Ele já bloqueia imagens remotas e limpa o HTML das mensagens.

### 5. Por onde entra a configuração

- O painel grava `/var/roundcube/config/paas.php` por `docker cp`, o mesmo caminho usado
  no Stalwart e no Caddy (sem bind mount de caminho do painel).
- O entrypoint da imagem só inclui os arquivos que existem quando ele roda. Por isso a
  ordem é: criar o container, copiar a configuração, iniciar.
- Depois disso, trocar o arquivo vale em até **2 segundos**, sem reiniciar. É o tempo de
  revalidação do cache do PHP, conferido no container real.

## Como foi testado

### Testes automatizados (TDD)

Cada teste foi escrito antes do código e rodou falhando antes de passar.

- `packages/core/tests/webmail.test.ts`: link com usuário, sem senha e escapado.
- `packages/mailer/tests/webmail.test.ts`:
  - configuração gerada (servidor único, TLS conferido ou não, segurança, nomes,
    rejeição de entrada malformada);
  - leitor de senhas erradas (IP do X-Forwarded-For, IPv6, lixo ignorado);
  - IP público ou interno;
  - ciclo de vida do container com o Docker simulado: sem `-p`, sem capabilities, a
    configuração antes do start, recriação e falhas.
- `packages/mailer/tests/client-allowed-ip.test.ts`: isenção e remoção do IP na API do
  Stalwart.
- `packages/deploy/tests/caddy-webmail.test.ts`:
  - Caddyfile com e sem webmail, cabeçalhos, IPs bloqueados, certificado manual, nome
    que já é de um site, upstream inválido;
  - o motor repassando o webmail ao Caddy, e uma falha que não derruba os sites.
- `apps/server/tests/webmail-service.test.ts`:
  - ativar e desativar, servidor parado, sem domínio;
  - isenção do IP (sucesso, falha, IP que muda);
  - acompanhar o servidor e sincronizar;
  - bloqueio: 10 em 10 minutos, liberação depois de 1 hora, tentativas espalhadas, IP
    interno.
- `apps/server/tests/routes-webmail.test.ts`: rotas (estado, ativar, desativar), erros,
  Auditoria, recálculo do proxy e leitura a cada minuto.
- `apps/server/tests/routes-mail-webmail.test.ts`: ligação com o módulo de e-mail (proxy,
  rotas registradas, parar e iniciar junto).
- `apps/server/tests/mail-webmail-backend.test.ts`: escolha do nome e da conferência do
  certificado; isenção pelo MailService.
- `apps/server/tests/deploy-panel-route.test.ts`: o provedor do webmail chegando ao motor.
- `apps/web/tests/webmail.test.tsx`: o card (estados, ativar, erro, aviso do proxy,
  desativar com confirmação, servidor parado, certificado pendente, IPs bloqueados) e o
  botão "Abrir webmail" nas caixas.

`pnpm -r --workspace-concurrency=1 --no-bail run test:coverage`, antes e depois:

| Pacote | Antes | Depois | Cobertura (ramos) |
|---|---|---|---|
| packages/core | 50 | 54 | (sem cobertura configurada) |
| apps/web | 570 | 582 | 83,17% → 83,17% |
| packages/deploy | 394 | 404 | 96,5% → 96,5% (mínimo 95%) |
| packages/mailer | 205 | 237 | 98,77% → 98,97% (mínimo 98%); `webmail.ts` 100% |
| packages/security | 167 + 20 pulados; 2 arquivos falham | igual | — |
| apps/server | 1061; 1 arquivo falha | 1100; o mesmo arquivo falha | — |

As falhas são as mesmas antes e depois, pelo mesmo motivo:

- **security** (`phase01-script`, `phase02-07-scripts`): `docker pull ubuntu:24.04`
  falha com `docker-credential-desktop.exe: executable file not found`. É a credencial
  do Docker Desktop, ausente nesta máquina.
- **server** (`terminal-service-pty`): o teste do PTY real com `docker exec`, pela mesma
  causa.

### Validação real com Docker (WSL)

O teste rodou numa rede isolada (`webmail-teste-net`, sub-rede `10.250.77.0/24`), sem
tocar na `paas-net` nem no `paas-caddy`. No fim, containers, volumes e a rede foram
removidos.

**Montagem**, chamando o código do painel por `tsx`:

1. **Caddy real** (`caddy:2-alpine`) com o Caddyfile de `renderCaddyfile(...)`, com o
   webmail ativado. Só no teste entrou `{ local_certs }`, para usar a CA local do Caddy no
   lugar do Let's Encrypt. O Caddy emitiu o certificado de `mail.exemplo.test`;
   `caddy validate` aprovou o Caddyfile.
2. **Stalwart real** (`StalwartManager`), com o certificado lido do Caddy
   (`readCaddyCertificate`) e o alias `mail.exemplo.test`. Duas caixas criadas pela API.
3. **Webmail real** (`WebmailManager` + `renderRoundcubeConfig`, conferindo pelo nome) e
   isenção do IP dele no Stalwart (`exemptIp`).

**Resultados:**

| O que | Resultado |
|---|---|
| Portas publicadas do webmail | nenhuma (`PortBindings {}`); capabilities `["ALL"]` retiradas; usuário 33:33; Apache sobe normal |
| `/?_user=contato@exemplo.test` | campo usuário preenchido |
| Login com a conferência ligada e a CA de teste **não** confiável | recusado: `certificate verify failed` (a conferência vale de verdade) |
| A mesma coisa com a CA de teste confiável no container | `302 → /?_task=mail` (entrou, IMAP 993 com cadeia e nome conferidos) |
| Envio pelo webmail de contato@ para suporte@ | `sent_successfully` (SMTP 465 conferido); a mensagem chegou na caixa suporte@ (IMAP `SEARCH` → 1, `From: contato@exemplo.test`) |
| Nome fora do certificado, conferência ligada | recusado: `subjectAltName did not match` |
| Nome fora do certificado, conferência desligada (caso "sem certificado ainda") | entrou |
| Cabeçalhos | HSTS, `nosniff`, `no-referrer`, `Permissions-Policy`, `X-Frame-Options: deny`, cookie `secure; HttpOnly; SameSite=Strict`; sem `Server` nem `X-Powered-By` |
| `/installer/`, `config/config.inc.php`, `logs/`, `temp/`, `SQL/`, `composer.json` | 404 |
| Tela de login | português ("Usuário", "Senha", "Entrar"), sem versão |
| Identidade | sem campo para trocar o endereço |
| Bloqueio | `parseFailedLogins` leu do log real a senha errada e o IP; com ele no Caddyfile, a resposta foi `429 Muitas tentativas de entrar`; sem ele, voltou ao normal |
| Bloqueio automático do Stalwart (experimento com `auth.rate 3/1d`) | 3 senhas erradas → IP bloqueado (`server.blocked-ip.<ip>` no banco, até a senha certa era recusada); depois de `exemptIp` + reload: o bloqueio foi desfeito e 6 senhas erradas seguidas não bloquearam mais |

**O que não deu para validar localmente:**

- a emissão pelo Let's Encrypt (precisa de domínio público);
- o webmail na `paas-net` de verdade, com o painel em container (`WebmailService` com o
  Docker real);
- o IP real de um visitante da internet no X-Forwarded-For. No teste local ele chegou
  como o gateway da rede do Docker, IP interno que o painel nunca bloqueia, como
  esperado.

## Na VPS: passo a passo para validar

### Passo 1: atualizar o painel

No terminal da VPS (SSH):

```bash
cd /opt/tws-panel && sudo git pull && sudo git log --oneline -1 && sudo docker compose up -d --build
```

Confira na linha do `git log` que o commit é o desta entrega.

### Passo 2: ativar o webmail

1. No menu, clique em **E-mail**.
2. O servidor de e-mail precisa estar **rodando** (selo verde no card "Servidor de
   e-mail").
3. No card **Webmail**, clique em **Ativar webmail** (verde).
4. **A primeira vez demora:** o painel baixa a imagem do Roundcube (~265 MB). Em seguida
   o selo fica **ativo** e aparece um botão **Abrir webmail** para cada domínio.

Confira no terminal:

```bash
sudo docker ps --filter name=paas-webmail --format '{{.Names}} {{.Status}} {{.Ports}}'
```

Deve aparecer `paas-webmail Up …` com a coluna de portas **vazia**.

### Passo 3: abrir e entrar

1. Clique em **Abrir webmail** ao lado de `mail.<seu-domínio>`.
2. O navegador abre `https://mail.<seu-domínio>/`, com cadeado e a tela de login em
   português.
3. Entre com o endereço completo de uma caixa (ex.: `contato@<seu-domínio>`) e a senha
   dela. Se esqueceu a senha, troque em E-mail → domínio → Caixas → **Trocar senha**.
4. Envie um e-mail para um endereço seu (Gmail, por exemplo) e responda de lá: a
   resposta deve aparecer na Caixa de entrada do webmail.
5. Na aba Caixas, o botão **Abrir webmail** de cada caixa já abre com o usuário
   preenchido.

### Passo 4: conferir a segurança

```bash
curl -sI https://mail.<seu-domínio>/ | grep -iE "strict-transport|x-frame|referrer|set-cookie"
curl -s -o /dev/null -w "%{http_code}\n" https://mail.<seu-domínio>/installer/
```

O primeiro deve mostrar HSTS, `x-frame-options: deny`, `referrer-policy: no-referrer` e
o cookie com `secure; HttpOnly; SameSite=Strict`. O segundo deve responder `404`.

Bloqueio por senha errada (opcional):

1. Do seu celular **fora do Wi-Fi**, para não bloquear o IP do escritório, erre a senha
   10 vezes.
2. Em até 1 minuto, a página vira "Muitas tentativas de entrar".
3. A Auditoria mostra `mail.webmail.block`.
4. O IP é liberado sozinho depois de 1 hora, ou ao reiniciar o painel.

### Passo 5: desativar (se quiser voltar atrás)

1. No card **Webmail**, clique em **Desativar** e depois em **Confirmar**.
2. `https://mail.<seu-domínio>/` volta a mostrar a página "Servidor de e-mail".
3. O e-mail continua funcionando normalmente: projetos, Outlook e celular não são
   afetados.

## Dúvidas para o dono do produto

1. **Sessão de 10 minutos sem uso.** Com a aba aberta, o Roundcube mantém a sessão viva
   sozinho; ela só cai se a pessoa fechar a aba, ou deixar o computador dormir, por mais
   de 10 minutos. Prefere 30 minutos?
2. **Bloqueio de 10 erros em 10 minutos, por 1 hora.** O limite está bom? Os bloqueios
   ficam só na memória: reiniciar o painel libera todos. Quer que sobrevivam ao
   reinício?
3. **Atualização do Roundcube.** Hoje a troca de versão é manual: tag e digest em
   `packages/mailer/src/webmail.ts`, e um PR. Quer um aviso no painel quando sair versão
   de segurança?
4. **Endereço.** O webmail abre na raiz de `mail.<domínio>`. Se preferir outro nome,
   como `webmail.<domínio>`, seria um registro DNS a mais por domínio e mais um
   certificado.

---

## Nome de exibição das caixas (04/10/2026)

Branch `feat/variaveis-senha-webmail-nome`, criada a partir de `origin/dev`.

### O pedido

Na validação na VPS, um e-mail enviado pelo webmail a partir da caixa do projeto saiu
com `From: contato@<domínio>`, sem nome. O dono do produto pediu que a caixa do projeto
já entre no webmail com o nome de exibição configurado no e-mail do projeto (ex.:
"Contato - Loja"). A pessoa continua podendo mudar o nome no Roundcube.

### O que passou a acontecer (pelo comportamento)

- **Primeiro login de uma caixa de projeto no webmail:** a identidade já nasce com o
  nome de exibição do e-mail do projeto. O campo "De" do compose mostra
  `Contato - Loja <contato@…>`, e quem recebe vê o nome.
- **Caixa que já tinha entrado antes, ainda sem nome** (o caso da VPS): no próximo
  login, o nome é preenchido.
- **Caixa que já tem nome**, seja escolhido pela pessoa (Configurações → Identidades),
  seja posto pelo painel antes: o painel **nunca** sobrescreve. Se o dono mudar o nome
  de exibição do projeto depois, a pessoa troca no Roundcube.
- **Caixas que não são de projeto** (criadas na página do domínio): nada muda, o nome
  fica vazio como antes.
- **Salvar ou desativar o e-mail do projeto:** o painel atualiza a lista de nomes do
  webmail em segundo plano, sem atrasar a resposta. Se o Docker falhar, fica no log, e
  a sincronização de hora em hora tenta de novo.

### Como funciona

- **Forma suportada pelo Roundcube 1.7.4**, conferida no código da imagem fixada:
  - `rcube_user::create` chama o hook **`user_create`** com `user_name` vazio e usa o
    valor que voltar como nome da identidade criada;
  - `index.php` chama o hook **`login_after`** depois de cada login com sucesso;
  - `rcube_user::update_identity` grava com parâmetro, sem montar SQL com o nome.
- **Arquivo de nomes:** o painel grava `/var/roundcube/config/paas-identities.json`,
  com `{endereço: nome}`.
  - O endereço vai em minúsculas.
  - O nome fica numa linha só, sem caractere de controle, com até 100 caracteres.
  - Não é `*.php`, então o entrypoint da imagem não o inclui na configuração.
  - Os nomes vêm do e-mail de cada projeto. Registro antigo sem nome guardado fica de
    fora.
- **Plugin `paas_identity`:** plugin próprio, pequeno, gerado pelo painel.
  - Ele carrega só na tela de login.
  - Ele só **lê** o arquivo indicado em `$config['paas_identities_file']`.
  - Ele só mexe no nome da identidade da caixa que entrou.
  - No `user_create`, preenche o nome da identidade nova.
  - No `login_after`, preenche a identidade padrão **só se o nome estiver vazio**.
  - Ele entra na lista de plugins da configuração gerada.
- **Onde o plugin fica:**
  - na fonte da imagem (`/usr/src/roundcubemail/plugins/`), que o entrypoint copia para
    a pasta servida no primeiro start e atualiza nos seguintes;
  - se o container já subiu, também na pasta servida (`/var/www/html/plugins/`), para
    valer na hora, sem reiniciar.
- **Por que não gravar na pasta servida antes do primeiro start:** o entrypoint só copia
  a fonte para lá se a pasta estiver vazia. Com qualquer arquivo dentro, ele espera 10 s
  e mostra um aviso.
- **Ordem:** o plugin é copiado antes da configuração que o liga. Num painel que se
  atualiza com o webmail rodando, nenhuma requisição pede um plugin que ainda não existe.

### Decisões

- **Não sobrescrever nome existente.** O Roundcube não guarda se o nome veio do painel
  ou da pessoa. Para nunca apagar a escolha dela, o painel só preenche nome vazio. O
  custo: trocar o nome de exibição do projeto depois não muda o nome de quem já tem um.
- **Arquivo JSON lido pelo plugin, em vez de gerar PHP com os nomes.** O nome é texto
  digitado pelo dono e nunca vira código. O JSON escapa tudo, e o banco grava com
  parâmetro.
- **Plugin mínimo, sem acesso a nada além do JSON.** Os testes conferem que o código
  dele não escreve arquivo, não executa comando, não lê a requisição e não inclui outro
  arquivo.

### Como foi testado

**Testes automatizados (TDD):** cada teste foi escrito antes do código e rodou falhando
antes de passar.

- `packages/mailer/tests/webmail.test.ts`:
  - configuração com o plugin na lista e o caminho do arquivo;
  - arquivo de nomes (minúsculas, ordem fixa, limpeza do nome, endereço inválido e nome
    vazio fora);
  - conteúdo do plugin (classe, tarefa, hooks, "só preenche vazio", nada além de ler o
    JSON);
  - entrega pelo Docker simulado: plugin na fonte antes do primeiro start, na pasta
    servida depois, antes da configuração, e as falhas.
- `apps/server/tests/mail-webmail-backend.test.ts`: os nomes de cada caixa de projeto,
  com o registro antigo sem nome de fora.
- `apps/server/tests/webmail-service.test.ts`: o arquivo de nomes vai junto com a
  configuração, e a sincronização leva o nome novo.
- `apps/server/tests/routes-mail-webmail.test.ts`: salvar ou desativar o e-mail do
  projeto atualiza o webmail em segundo plano; uma falha não atrapalha salvar.

`pnpm -r --workspace-concurrency=1 --no-bail run test:coverage`, antes e depois da
branch, que também inclui a senha visível nas Variáveis:

| Pacote | Antes | Depois | Cobertura (ramos) |
|---|---|---|---|
| packages/core | 54 | 54 | (sem cobertura configurada) |
| apps/web | 623 | 627 | 84,06% → 84,06% |
| packages/deploy | 417 | 417 | 96,64% → 96,64% (mínimo 95%) |
| packages/mailer | 327 | 339 | 99,38% → 99,39% (mínimo 98%) |
| packages/security | 187 | 187 | 97,26% |
| apps/server | 1202 | 1215 | 94,87% → 94,94% |

Nesta rodada, nenhum arquivo falhou, nem os que baixam `ubuntu:24.04`, que antes
falhavam por falta da credencial do Docker Desktop.

**Validação real com Docker (WSL):**

- Rede isolada `webmail-nome-net` (`10.250.78.0/24`).
- Stalwart real, com duas caixas: `contato@exemplo.test` e `suporte@exemplo.test`.
- Roundcube real, subido pelo `WebmailManager` do painel, com o arquivo de
  `renderWebmailIdentities`.
- Login de verdade pelo formulário (token e cookies), feito de dentro da rede.
- No fim, containers, volumes e a rede foram removidos (conferido).

| O que | Resultado |
|---|---|
| `php -l` no plugin | sem erro de sintaxe |
| Primeiro start | sem o aviso "is not empty"; o plugin está na fonte e na pasta servida |
| A. Primeiro login de contato@ (nome no arquivo) | "De": `Contato - Loja <contato@exemplo.test>` |
| B. Primeiro login de suporte@ (sem nome no arquivo) | identidade sem nome, como antes |
| O painel passa a ter "Suporte - Loja" e muda contato@ para "Outro Nome" (container rodando) | arquivo trocado na hora, sem reiniciar |
| B2. suporte@ entra de novo (já tinha entrado, nome vazio) | nome preenchido: `Suporte - Loja` |
| C. contato@ entra de novo (já tinha nome) | continua `Contato - Loja` (não sobrescreve) |
| C. Envio pelo webmail de contato@ para suporte@ | `sent_successfully`; no IMAP de suporte@, `From: Contato - Loja <contato@exemplo.test>` |
| D. A pessoa troca o nome de suporte@ para "Maria do Suporte" e entra de novo | continua `Maria do Suporte` |
| Erros do PHP no log do webmail | nenhum |

**O que não deu para validar localmente:** a atualização a partir do webmail que já está
na VPS. É o mesmo caminho da segunda entrega da validação (container rodando: plugin na
pasta servida e configuração trocada sem reiniciar), mas com a caixa criada pela versão
anterior.

### Na VPS: passo a passo para validar

1. No terminal da VPS (SSH), atualize o painel:

   ```bash
   cd /opt/tws-panel && sudo git pull && sudo git log --oneline -1 && sudo docker compose up -d --build
   ```

2. Espere até 1 minuto (a primeira sincronização do e-mail). Ou, no painel, abra
   **Projetos → o projeto → E-mail** e clique em **Salvar** sem mudar nada.
3. Confira que o plugin e os nomes chegaram:

   ```bash
   sudo docker exec paas-webmail cat /var/roundcube/config/paas-identities.json
   sudo docker exec paas-webmail ls /var/www/html/plugins/paas_identity/
   ```

   O primeiro comando deve mostrar o endereço da caixa do projeto com o nome de
   exibição. O segundo deve listar `paas_identity.php`.
4. Abra o webmail, **saia** (se estiver logado) e entre de novo com a caixa do projeto.
5. Clique em **Escrever**: o campo "De" deve mostrar `Nome <endereço>`.
6. Envie um e-mail para um endereço seu (Gmail, por exemplo). Ele deve chegar com o
   nome.
7. Se a caixa já tinha um nome escolhido em Configurações → Identidades, ele continua.
   Isso é de propósito. Para usar o nome do painel, apague o nome lá e entre de novo, ou
   digite o nome que preferir.

### Dúvida para o dono do produto

- **Trocar o nome do projeto depois.** Hoje, se a caixa já tem nome no webmail, o nome
  novo do painel não chega lá, para não apagar o que a pessoa escolheu. Prefere que o
  painel sobrescreva quando o nome atual for o que ele mesmo pôs antes? Daria para
  guardar o último nome entregue e comparar.
