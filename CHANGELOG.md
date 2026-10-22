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
- Checklist de DNS com valores copiáveis.
- Webmail (Roundcube) em `https://mail.<domínio>/`.
- Página Envios: fila, histórico, volume, listas de bloqueio (agora conferidas todo dia) e nota de
  entregabilidade.
- Entregabilidade: `Message-ID` e `Date` completados, relatórios DMARC entregues na `postmaster@`
  e saída só por IPv4.

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
