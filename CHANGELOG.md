# Changelog

Todas as mudanças relevantes do TWS Panel ficam registradas aqui.

*English readers: this changelog is written in Portuguese only.*

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa
[Versionamento Semântico](https://semver.org/lang/pt-BR/). Enquanto a versão for `0.x`, o projeto
está em beta e qualquer versão pode trazer mudanças incompatíveis.

## [Não lançado]

### Adicionado

**Instalação e acesso**

- Painel aberto por `https://<ip-com-hífens>.sslip.io`, com certificado HTTPS válido, sem túnel e
  sem escolher porta. O acesso só por túnel SSH continua disponível (`--acesso=tunel`).
- Pré-flight do instalador: confere sistema, memória, disco, Docker, portas e serviços antes de
  instalar, sem alterar nada, e pede confirmação se a VPS não estiver limpa.
- O instalador roda com o usuário comum e se reexecuta com `sudo` sozinho.
- Na instalação, escolha do usuário do terminal do painel e do modo de rodar o que precisa de root
  (`senha` ou `segundo-plano`); `--reconfigure-terminal` para trocar depois.
- Pasta dos projetos fora do container, em `/opt/tws-projects` por padrão (`--projects-dir`).
- Scripts de operação: `show-token.sh`, `reset-setup.sh`, `uninstall.sh`, `reset-2fa.sh`,
  `reativar-acesso-ip.sh` e `restaurar-painel.sh`.
- Aviso na tela quando uma versão nova do painel foi publicada.
- Roteiro "Deixe o painel pronto" no Dashboard e em Configurações → Primeiros passos, com seis
  passos e o estado de cada um conferido pelo painel.

**Segurança**

- Terminal web embutido (xterm.js, WebSocket e PTY) no wizard e fora dele, liberado só depois do
  setup token; as varreduras e as fases do hardening rodam dentro dele.
- Ponte com o host (nsenter, lista fechada de comandos) para varrer e endurecer a VPS de verdade.
- Fase 07 do hardening (endurecimento adicional) e teste de acesso com "desfazer agora".
- Fases de segurança acessíveis depois da instalação, em Segurança → Proteções.
- Verificação em duas etapas (TOTP) no login, com 10 códigos de recuperação.
- Travas do login com a verificação em duas etapas: bloqueio por conta no código de 6 dígitos
  (5 erros seguidos bloqueiam por 5 min, dobrando até 24 h, gravado em disco; o código de
  recuperação continua valendo), aviso na Auditoria, nos Alertas e nas notificações de segurança
  quando a senha certa chega sem o código certo, e limite de tentativas ao trocar a senha, ativar
  ou desativar a verificação e recomeçar o assistente. O limite por IP agrupa o IPv6 pelo bloco
  /64, a tela Segurança avisa quando o proxy da Cloudflare é detectado e
  `reset-2fa.sh --so-bloqueio` limpa só o bloqueio.
- Login com a verificação em duas etapas: ao errar o código do app, a tela mostra quantas
  tentativas restam antes do bloqueio e por quanto tempo o próximo bloqueio duraria (o menor entre o
  limite da conta e o do IP, sem dizer qual). Só aparece a quem já acertou a senha e não revela o
  nível de reincidência da conta.
- Configurações com Perfil, Segurança, Aparência e Integrações.

**Deploy e projetos**

- Site estático em HTML puro e pasta que já está no servidor como origem do código.
- Repositório privado com token somente leitura, guardado cifrado.
- Conectar a conta do GitHub e escolher o repositório numa lista.
- Endereço automático com HTTPS (`projeto.<ip>.sslip.io`) e guia de domínio próprio.
- Menu do projeto (Visão geral, Deploys, Domínios, Git, Variáveis, E-mail, Backups,
  Configurações), vários domínios por projeto e variáveis de ambiente cifradas.
- Compose de verdade: variáveis no `.env`, lista do que o compose exige, importação de `.env`,
  deploy barrado por variável faltando e retirada das portas 80/443 de apps comuns.
- Lista de todos os serviços do compose e "Por que falhou" no log do deploy.
- Páginas "site em configuração", "em manutenção" e "temporariamente indisponível".
- Botão Portas: portas do projeto e de todos os containers, trocar, publicar, remover e editar
  em lote.
- Aviso de "nova atualização do projeto": o painel compara a ponta da branch configurada, no
  repositório, com o commit que o último deploy publicou. O aviso aparece na aba Git, no topo da
  página do projeto e no Dashboard (indicador por projeto e lista dos projetos com atualização),
  sempre na branch de cada projeto. É só aviso: o deploy continua sendo um clique no botão Deploy,
  que ganhou uma explicação (busca o código novo da branch). Quando não dá para consultar o
  repositório, a tela diz "não deu para verificar" em vez de "atualizado".

**HTTPS e domínio do painel**

- Página Certificados: estado de cada endereço, causa provável da falha, "Tentar emitir agora" e
  certificado próprio (manual).
- Configurações → Domínio do painel, com desativar e reativar o acesso pelo IP.

**E-mail**

- Certificado de verdade para `mail.<domínio>`, emitido pelo Caddy e instalado no servidor de
  e-mail.
- PTR em três níveis, com instrução por provedor (Contabo, Hetzner, Vultr), e PTR único para o
  servidor inteiro.
- Enviar e-mail de teste a partir de qualquer caixa.
- E-mail do projeto com caixa própria, nome de exibição, senha gerada pelo painel e ligação com as
  variáveis do projeto.
- Nome de exibição (opcional) em toda caixa: ao criar na página do domínio, na aba Caixas do projeto
  e ao ativar o e-mail do projeto, e **Alterar nome de exibição** depois, sem mexer em senha, 2FA,
  senhas de app, apelidos nem mensagens. O nome aparece nas listas e vale no `From` do e-mail de
  teste e no webmail (identidade que já tem nome no webmail não é sobrescrita); na caixa de envio do
  projeto é o `MAIL_FROM_NAME` (vale no próximo deploy). O Sincronizar só traz o nome do servidor de
  e-mail para caixas novas: não sobrescreve um nome já conhecido nem desfaz um nome alterado depois.
  Nome de projeto com caracteres inválidos é limpo antes de ir para `MAIL_FROM_NAME`.
- Checklist de DNS com valores copiáveis.
- Webmail (Roundcube) em `https://mail.<domínio>/`.
- Página Envios: fila, histórico, volume, listas de bloqueio (agora conferidas todo dia) e nota de
  entregabilidade.
- Registro dos e-mails que o app de um projeto envia por SMTP: seção **Envios** em cada projeto e
  aba **Saídas** em E-mail → Envios, com estado (na fila, entregue, adiado, falhou, rejeitado),
  filtros, páginas e o motivo do erro em linguagem clara. Assunto e corpo ficam ocultos até clicar
  em **Exibir** (cada exibição é auditada), com retenção configurável (90 dias para os dados da
  mensagem, 14 dias para assunto e corpo), limites de tamanho, opção de não guardar assunto e corpo
  por projeto ou para todos, e conteúdo fora dos backups do painel. Assunto e corpo são guardados
  só das caixas de projeto (o que o app envia); webmail e caixas pessoais ficam apenas com de,
  para, hora, estado e erro.
- Entregabilidade: `Message-ID` e `Date` completados, relatórios DMARC entregues na `postmaster@`
  e saída só por IPv4.
- Saúde do envio de e-mail por domínio (ok, atenção, crítico): A, MX, SPF (limite de 10 consultas),
  DKIM (tamanho da chave), DMARC, PTR, porta 25, fila, TLS, listas de bloqueio e propagação, mais
  MTA-STS e TLS-RPT opcionais; botão "Verificar a saúde agora" e verificação diária. Nunca promete
  caixa de entrada.
- Passo a passo do DNS com registros em ordem, valores copiáveis, nuvem cinza do Cloudflare e aviso
  de PTR; guia "DNS e entregabilidade do e-mail" no site.
- Diagnóstico do atraso na fila do Stalwart com a causa em português (limite de taxa, greylisting,
  IP bloqueado e outras).
- E-mail de teste: passo a passo do "Mostrar original" no Gmail e teto de 60 testes por dia.
- Corrigido: o Stalwart só assinava com a chave DKIM nova depois de reiniciar; cadastrar um domínio
  (ou adotá-lo na Sincronização, quando a chave é criada na hora) agora reinicia o servidor de e-mail,
  numa fila única de reinícios. Se o reinício falha, o painel mostra DKIM em atenção ("reinício
  pendente") e avisa na resposta, em vez de DKIM ok.
- Diagnóstico do atraso: falhas de autenticação do Gmail (4.7.26, 4.7.27, 4.7.30, 4.7.32) deixam de
  ser tratadas como limite de taxa. SPF avaliado como receptor (qualificadores, redirect, macros).

**Notificações**

- Avisos por Telegram e por e-mail: segurança, deploy, certificados, lista de bloqueio, disco,
  backups e painel reiniciado.

**Backups**

- Backups do painel, do e-mail e dos projetos (bancos, volumes e pastas detectados), em `.7z`,
  com agenda e retenção.
- Cópia na VPS e no Cloudflare R2 ou outro armazenamento compatível com S3, conferida depois do
  envio.
- Criptografia opcional da cópia externa, kit de recuperação e lembrete trimestral da senha.
- Restauração por item, restauração do painel por SSH e "Restaurar de outro servidor".

**Documentação e comunidade**

- README, CONTRIBUTING, SECURITY e CODE_OF_CONDUCT em inglês (idioma principal), com o README e os
  textos de comunidade também em português do Brasil; `ROADMAP.md` com o que existe e o que vem.
- Guias traduzidos para o inglês e publicados num site (Starlight, em `site/`) com busca e dois
  idiomas, no GitHub Pages, a partir da branch `main`. `pnpm docs:links` confere os links internos.
- Modelos de issue em formulário (bug, sugestão, pergunta ou documentação) e modelo de pull request.

### Alterado

- O painel escuta só em `127.0.0.1`; quem atende de fora é o proxy, nas portas 80 e 443.
- O usuário do terminal não é mais colocado no grupo `docker`.
- A fase 00 do hardening não atualiza o Docker, para não derrubar o próprio painel.
- Os guardrails analisam o mesmo compose que o deploy usa.
- A documentação foi reorganizada: README curto e guias em `site/src/content/docs/`.

### Removido

- "Enviar do meu computador" (upload de pasta) no assistente de Novo Projeto: a origem do código
  passou a ser git, GitHub ou pasta do servidor.

### Corrigido

- Roteiro, passo "Backups fora da VPS", com um bucket que já guarda backups de outro painel: o aviso
  agora oferece restaurar o painel antigo OU fazer o primeiro backup à mão (que não é bloqueado) e avisa
  que, a partir do primeiro backup, a retenção apaga as cópias mais antigas da pasta (mantém só as
  mais novas), inclusive as do painel antigo: baixe-as antes ou use outro bucket/pasta. O passo 8 do
  "Como fazer" agora aponta o botão certo (cartão Painel, em Configurações → Backups).
- Confirmações que pedem uma palavra (restauração, recomeçar o assistente, desativar o acesso pelo IP):
  a palavra aparece em fonte de código, com dica de que é literal (e-mail não é o seu endereço), exemplo
  no campo e botão de copiar.

- Login por senha no SSH desligado de fato em imagens com `50-cloud-init.conf`; o desfazer da
  fase 02 nunca apaga o `sshd_config`.
- Repositório privado volta a clonar na VPS.
- A checagem de listas de bloqueio do e-mail passa a rodar.
- A restauração não confia nos caminhos gravados no manifesto do backup.

### Segurança

- Webmail (Roundcube) atualizado para a 1.7.5, que roda sobre o PHP 8.4.27: traz a correção das duas
  falhas críticas do PHP divulgadas em 21/10/2026 (CVE-2026-109618 e CVE-2026-109619) e outras
  correções do Roundcube. **Após atualizar o painel, o webmail é recriado automaticamente com a
  imagem corrigida** (ao subir o painel e ao sincronizar o e-mail), com um reinício breve;
  preferências, contatos, sessões e nomes de exibição ficam no volume e são mantidos. O painel confere
  que o webmail novo segue de pé alguns segundos antes de apagar o anterior; se a troca falhar ou o
  novo cair, o container anterior volta e o erro é mostrado. Sobras de uma troca interrompida são
  limpas na próxima sincronização.
  Para atualizar: `cd /opt/tws-panel && sudo git pull && sudo docker compose up -d --build`.
- Imagem base do Node do painel e dos builds de sites estáticos atualizada para a 22.23.4 (correções de
  segurança do Node de 21/10/2026), pnpm para a 10.34.7 e vitest para a 4.1.12 (só desenvolvimento).

## [0.1.0] - 2026-08-20

Primeira versão pública.

### Adicionado

- Wizard de configuração protegido por setup token: boas-vindas, saúde da máquina, segurança e
  conta de administrador.
- Wizard de segurança com Lynis e checagens próprias, hardening em fases idempotentes com backup
  de cada arquivo e rollback automático.
- Deploy por git, upload de diretório ou adoção de um compose existente, com detecção do tipo de
  projeto e Caddy central com SSL automático.
- Servidor de e-mail Stalwart com DKIM RSA 2048, checklist de DNS verificável, caixas com
  credenciais prontas e variáveis SMTP injetadas nos projetos.
- Guardrails de deploy (6 regras em 3 níveis) com override auditado.
- Monitoramento com baseline e diff, verificação de blacklist de e-mail, central de alertas e log
  de auditoria.
- Conta de administrador com senha argon2id, sessões revogáveis e limite de tentativas no login.
- Instalação 100% em Docker, testes com Vitest e CI no GitHub Actions com mínimos de cobertura.

[Não lançado]: https://github.com/kelvindk9w/tws-panel/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kelvindk9w/tws-panel/releases/tag/v0.1.0
