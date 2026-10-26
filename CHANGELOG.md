# Changelog

Todas as mudanças relevantes do TWS Panel ficam registradas aqui.

*English readers: this changelog is written in Portuguese only.*

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa
[Versionamento Semântico](https://semver.org/lang/pt-BR/). Enquanto a versão for `0.x`, o projeto
está em beta e qualquer versão pode trazer mudanças incompatíveis.

## [Não lançado]

### Adicionado

**MCP, Fase 1 (assistente de IA)**

- Endereço `/mcp` (MCP por HTTP, JSON-RPC) para um assistente de IA consultar e operar o painel com um token.
  Vem **desligado**; ligar é em Configurações → Acesso por IA e pede senha (e 2FA). Desligado, o endereço
  responde 404 como se não existisse.
- Ferramentas: consultar projetos, deploys, logs, HTTPS e DNS; criar projeto, cadastrar domínio e definir
  variáveis; publicar, reiniciar e recriar; simular (e, se permitido, aplicar) fases de segurança. **Nenhuma
  ferramenta apaga.** Cada chamada passa pelas mesmas rotas, validações, travas, alcance e limites de taxa.
- Quatro opções por token, todas desligadas por padrão e só ligadas por uma pessoa com senha (e 2FA): aplicar
  segurança de verdade, ler valores de variáveis, dispensar a aprovação humana e consultar métricas.
- Aprovação humana de ações sensíveis (recriar projeto, aplicar segurança) na tela, com senha e 2FA: pedido
  de 10 minutos, de uma execução, preso ao token e aos argumentos. Token nenhum aprova.
- Validade do token: 1, 7, 15, 30 (padrão), 90, 180 ou 365 dias, ou **sem vencimento** (pede confirmação e
  mostra o risco). Substitui o máximo de 365 dias.
- Auditoria de cada chamada com o token e o nome do cliente; saídas com tokens do painel são mascaradas.
- `PAAS_MCP_SETUP_LEVEL` (`read`, `write` ou `admin`): o token de setup vale no `/mcp` durante a instalação.
- Guia no site (`guides/mcp`, em português e inglês).

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
- Acesso por IA (Configurações → Acesso por IA): tokens de API com escopo (leitura, escrita ou
  administração), validade (padrão 30 dias, de 1 hora a 1 ano) e revogação imediata, usados no
  cabeçalho `Authorization: Bearer`. O valor aparece uma vez; o disco guarda só o hash (SHA-256,
  arquivo 0600). Só a sessão humana cria, lista e revoga (com a senha e, havendo 2FA, o código); um
  token nunca administra tokens. Uma lista fixa de rotas fica fora do alcance de qualquer token, mesmo
  com escopo de administração (terminal, reinício do assistente, senha e 2FA, senhas de backup e de
  caixas, valores de variáveis, tokens do GitHub e de serviços, restaurar o painel). Trocar o repositório
  de um projeto e criar projeto exigem administração; escrita e administração equivalem, na prática, a
  acesso às variáveis dos projetos (um deploy roda o código com elas), e a tela e os guias dizem isso.
  Domínios, portas e webmail dos projetos também exigem administração, e o token só lê a
  varredura de segurança que já existe. Rota que ainda não foi classificada é negada. A Auditoria mostra `token:nome`;
  trocar a senha ou recomeçar o assistente revoga todos; Bearer inválido repetido bloqueia o IP.
  Detalhes em `comoFuncionaSistema/_RELATORIO-mcp-fase0.md`.
- Acesso por IA, alcance por projeto (fase 0b): além do escopo, o token ganha um alcance escolhido por
  quem o cria: o painel inteiro (como antes), só os projetos escolhidos, ou os escolhidos mais "pode
  criar projetos novos" (o projeto que o token criar entra sozinho na lista dele; se não der para
  registrar, o projeto é desfeito). Fora da lista o projeto não existe para o token: a listagem filtra
  e o pedido por número dá o mesmo 404 de projeto inexistente. Token limitado nunca alcança rotas do
  painel ou do servidor (domínio do painel, e-mail do servidor, backups do painel, segurança,
  usuários, avisos, integrações, configurações, containers, portas, terminal e outros tokens: 403). A
  tabela de rotas ganhou a dimensão de alcance, com teste que percorre todas as rotas reais. Recusas
  de domínio ou porta em uso por algo fora do alcance dizem só "indisponível". Token limitado só cria
  projeto de repositório Git e não troca a fonte. A tela ganhou o seletor de alcance, a linha de
  alcance em cada token e "Editar projetos" (aumentar pede a senha; diminuir não). Apagar um projeto o
  tira das listas; lista ilegível = token sem alcance; arquivo da fase 0 = painel inteiro. O id exato
  de um projeto passou a vencer o apelido (slug) na busca. Detalhes em
  `comoFuncionaSistema/_RELATORIO-mcp-fase0b.md`.
- Acesso por IA, correções da revisão da fase 0b: nenhum token (nem de painel inteiro) pode pedir o
  override dos bloqueios de segurança do deploy (`guardrailOverride`; 403, só a pessoa na tela); projeto
  criado por token limitado nunca clona com a conta do GitHub conectada (só repositório público ou a
  credencial própria do projeto) e a pessoa libera por projeto, com senha e 2FA, na aba Git; um id que
  sobrou na lista de um token não alcança mais um projeto novo de mesmo apelido, e apagar projeto que
  não consegue limpar as listas dos tokens avisa em vez de calar; arquivo de token com "painel
  inteiro" e lista de projetos vira token sem alcance; o apelido de projeto criado por token limitado
  sempre leva sufixo aleatório (não denuncia nomes fora do alcance); editar o alcance de um token
  passou a ser atômico (projeto criado pelo token no meio da edição dá 409 e aparece marcado para
  reenviar); token limitado não apaga projeto até existir a confirmação humana da fase 3; "pode criar"
  só vale com o nível Administração (servidor e tela).
- Login com a verificação em duas etapas: ao errar o código do app, a tela mostra quantas
  tentativas restam antes do bloqueio e por quanto tempo o próximo bloqueio duraria (o menor entre o
  limite da conta e o do IP; quando o menor é o do IP, o texto é neutro). Só aparece a quem já
  acertou a senha, que pela duração mostrada pode deduzir qual limite é e o nível de reincidência
  (já era visível no 429); se o IP é o menor e a conta está perto do bloqueio, o aviso cita as duas. Com os dois bloqueios juntos a tela diz "aguarde ou tente de outro lugar". O passo "senha certa, falta o código" deixou de gastar tentativas do IP.
- Configurações com Perfil, Segurança, Aparência e Integrações.

**Deploy e projetos**

- **Next.js com servidor no ar sem Dockerfile.** Um projeto com a dependência `next` e sem `output: "export"`
  (e sem compose nem Dockerfile, que continuam com prioridade) vira o tipo novo **Next.js (servidor)**
  (`node-server`, pensado para outros servidores Node no futuro). O painel gera o Dockerfile fora do repositório
  do usuário e constrói a imagem em duas etapas: instalação congelada pelo lockfile (pnpm, yarn ou npm,
  `packageManager` antes do lockfile), `next build` e uma imagem final mínima do Node alpine (20, 22 ou 24,
  fixada por digest; `engines.node`, `.nvmrc` ou `.node-version`, com Node 22 por padrão) rodando como usuário
  comum, sem capabilities e sem porta publicada no servidor. Com `output: "standalone"` roda `node server.js`;
  sem, `next start`. O `next.config` é lido só como texto, nunca executado.
- Variáveis do Next.js: as `NEXT_PUBLIC_*` vão ao build como argumento (públicas por definição, e a tela avisa);
  as demais chegam ao `next build` por um segredo do BuildKit, que não entra em nenhuma camada da imagem; os
  logs mostram só nomes. `PORT` e `HOSTNAME` são do painel.
- Build em VPS pequena: heap do `next build` em 60% da RAM (768 a 4096 MB), cache de dependências por projeto,
  poda automática da imagem anterior e do cache com mais de 7 dias, e mensagem clara no log quando o build
  falta memória ou o lockfile não bate com o `package.json`.
- Segurança do servidor Next.js: arquivos do repositório lidos sem seguir link e com limite (nada do conteúdo aparece no log), `.env*` fora do contexto do build, cache de dependências com id imprevisível por projeto, código da imagem final somente leitura para o processo e HEALTHCHECK sem seguir redirecionamento. O container antigo fica parado até o novo passar no health check; se falhar, é religado. As imagens dos projetos ainda não são varridas por vulnerabilidades (só a do painel no CI).
- Guia novo de Next.js (estático, servidor automático ou Dockerfile próprio, e quando usar cada um).
- Site estático em HTML puro e pasta que já está no servidor como origem do código.
- Repositório privado com token somente leitura, guardado cifrado.
- Conectar a conta do GitHub e escolher o repositório numa lista.
- Endereço automático com HTTPS (`projeto.<ip>.sslip.io`) e guia de domínio próprio.
- Domínio com e sem www: o nome digitado é o principal e o par (`example.com` e
  `www.example.com`) é orientado junto, com tipo, nome (`@`/`www`), valor e botão de copiar, em
  português e inglês, e com o que acontece se só um apontar. O par redireciona (308) para o principal.
  **Verificar DNS** confere cada nome à parte (aponta, sem registro, outro lugar, Cloudflare laranja,
  DNS sem resposta) e o par que falha é só aviso. O Caddy só pede o certificado do par depois que o
  DNS dele aponta (conferido a cada 10 minutos), nunca toma o nome de outro projeto, do painel nem do servidor de e-mail, e
  o par pode ser desligado por domínio. Subdomínios como `app.example.com` não ganham par; sufixos
  como `.com.br`, `.dev.br`, `.sp.gov.br`, `.nom.br` e `br.com` seguem a Public Suffix List (PSL, cópia
  fixada em `packages/core/psl/`, versão 2026-10-22; atualizar: `node scripts/gen-public-suffixes.mjs`
  depois de trocar a cópia). Um nome digitado que é ele mesmo um sufixo público (`sp.gov.br`) recebe
  aviso e não ganha par. Nomes em Unicode (`exämple.com`, `example.公司.cn`) viram punycode (`xn--exmple-cua.com`): o servidor
  normaliza com a mesma função do guia em todo ponto de entrada (verificar DNS, criar projeto, adicionar
  domínio, trocar o principal, remover, porta, par/www), guarda sempre o punycode, e o guia, o
  Verificar DNS e os formulários já usam o nome em punycode, com uma legenda explicando a conversão (o
  Unicode não é exibido ao lado). Texto inválido (`ä<.com`, `a:80@x.com`, mais de 253 caracteres)
  continua recusado com 400. Registros gratuitos e hospedagens da seção
  privada da PSL (`eu.org`, `us.kg`, `github.io`…) não têm apex que o painel saiba dizer: nome completo
  no guia e sem par. Só um país novo, posterior à cópia da PSL, cai no critério antigo (nome completo
  no guia); a lista envelhece e precisa ser regenerada de tempos em tempos. Ideia futura (ROADMAP):
  carregar a lista sob demanda, pois ela soma cerca de 117 KB (37 KB gzip) ao bundle web.
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
- Aba **Logs** no projeto: mostra, pelo painel e sem SSH, o que os containers do projeto escrevem
  enquanto rodam (saída normal e de erro, cada linha com a hora e a marca de erro), útil, por
  exemplo, para conferir se o projeto voltou bem depois de reiniciar a VPS. No topo, o estado de
  cada serviço (rodando ou parado, saudável, reinícios, desde quando, código de saída). Escolha o
  serviço, de 100 a 2000 linhas (padrão 200) e o período (15 minutos, 1 hora, 24 horas); há filtro
  de texto na tela, atualização automática desligável (a cada 5, 10, 30 ou 60 segundos), rolagem
  que acompanha o fim e botão de copiar. Só lê containers do próprio projeto (o serviço escolhido
  precisa existir no projeto; id ou nome de container de outro projeto não funciona), com limite
  de linhas, de bytes, de tempo e de tamanho da resposta. Os valores das variáveis do projeto
  (8 caracteres ou mais), senhas em endereços de conexão, `Bearer`/`Basic` e campos como
  `password=` saem como `[oculto]`, em melhor esforço (não é garantia); se o painel não conseguir
  ler as variáveis para isso, nenhum log é mostrado. A rota nova (`GET /api/projects/:id/logs`) é de
  projeto com nível Leitura para tokens de API e respeita o alcance (projeto fora dele dá o mesmo
  404 de projeto inexistente). A leitura não entra na Auditoria. Revisão: a máscara tem padrões
  lineares e orçamento de tempo e tamanho (linha patológica não trava o painel), cobre também
  `Cookie`, `session=`, JWT, `secret_key=`, JSON escapado e forma de formulário, e cada pedido tem
  limite de containers lidos ao mesmo tempo (4), de bytes (40 MiB por pedido, reservados antes de ler) e prazo de leitura de 15 s (incluindo o `docker ps`; a máscara tem mais 0,25 s); no máximo 6 leituras
  de logs simultâneas (a seguinte recebe 429). Não mascara: valor antigo de variável trocada,
  maiúsculas diferentes e valores com menos de 8 caracteres.

**Monitoramento de recursos**

- O painel passou a **medir a VPS e os projetos a cada minuto**, sem programa extra: processador
  (inclusive o que o provedor toma, "steal", e a espera por disco), carga, memória disponível e swap,
  pressão de CPU, memória e disco (PSI, quando o kernel tem), mortes por falta de memória, disco e inodes,
  rede e tempo ligado; e, por container e por projeto, processador, memória (sem o cache de arquivo),
  leitura e escrita de disco, rede, reinícios e mortes por falta de memória. A leitura é feita direto nos
  arquivos do kernel (`/proc` e cgroup v2); sem essas montagens o painel roda em modo reduzido (host pelo
  que o container enxerga, containers pela API do Docker) e avisa na tela. O histórico fica em arquivos
  (um por dia), com três resoluções e retenção **configurável em Configurações → Recursos da VPS**: por
  minuto 48 horas (de 24 a 168), por hora 90 dias (de 7 a 365) e por dia 2 anos (de 90 dias a 5 anos). O dado por
  minuto fica fora do backup do painel; as médias de hora e de dia entram. O que não foi medido aparece
  como "sem dados", nunca como zero, e uma falha de coleta nunca derruba o painel. Quem não quer o
  monitoramento escreve `PAAS_METRICS=off` no `.env` (e recria o container): nada é coletado nem alertado.
- **Dashboard: faixa de semáforos** com processador, memória, disco, rede, projetos e proteções
  (certificados e backups), cada um com o valor de agora, o selo (texto e ícone, não só a cor) e a
  miniatura das últimas 24 horas. Memória mostra o que está **disponível**, não "% usada" (o Linux
  enche a RAM de cache de propósito); o disco mostra "enche em X a Y dias" quando há pelo menos 7 dias
  de histórico crescendo.
- Aba **Recursos** no projeto: processador, memória (com o limite, se houver), disco e rede da soma do
  projeto em 1 hora, 24 horas, 7 ou 30 dias, cada serviço com agora, média e pico, e a lista de reinícios
  e mortes por falta de memória com o horário e o atalho para os logs.
- **Alertas de recursos**, ligados por padrão (tipo de aviso novo "Recursos da VPS", e origem "recursos"
  nos Alertas), com histerese: memória apertada (pressão ≥ 20% por 5 min; volta com < 10% por 15 min),
  CPU no limite, CPU tomada pelo provedor (≥ 10% por 30 min; volta com < 5% por 60 min), disco lento,
  falta de inodes (≥ 90%; volta com < 85%), processo morto por falta de memória (na hora), container que
  reinicia mais de 3 vezes em 15 minutos e container não saudável por mais de 5 minutos. O aviso de disco
  cheio continua sendo o que já existia.
- Acesso por IA: nova opção **"Pode ver o monitoramento da VPS"** (só leitura, desligada por padrão, só em
  token limitado a projetos). Sem ela, token limitado não vê o consumo da VPS (403); com ela vê o resumo e
  as séries do host, e o resumo só lista os problemas dos projetos dele. Ligar pede a senha (e o código
  com 2FA), como aumentar o alcance; desligar não pede e vale na hora. Token de painel inteiro com
  leitura sempre vê. Rotas novas: `GET /api/metrics/summary`, `GET /api/metrics/host` (VPS),
  `GET /api/projects/:id/metrics` (projeto, respeita o alcance), `GET` e `PUT /api/metrics/settings`
  (a troca de retenção é só da pessoa, nunca de token, e vai para a Auditoria).
- **Atualização:** o `docker-compose.yml` ganhou duas montagens somente leitura (`/proc` e
  `/sys/fs/cgroup` do host). Quem já tem o painel instalado ganha as montagens quando o container é
  recriado, o que o comando de sempre já faz: `cd /opt/tws-panel && sudo git pull && sudo docker compose
  up -d --build`. Detalhes em `comoFuncionaSistema/metricas/` e em `SECURITY.md`.

**HTTPS e domínio do painel**

- Página Certificados: estado de cada endereço, causa provável da falha, "Tentar emitir agora" e
  certificado próprio (manual).
- Configurações → Domínio do painel, com desativar e reativar o acesso pelo IP.
- Alerta de certificado automático que não renovou. O Let's Encrypt não manda mais e-mail de
  vencimento, então o painel confere a cada 30 minutos e abre um alerta (com aviso no Telegram ou no
  e-mail, agrupado quando vários nomes falham juntos) quando o Caddy devia ter renovado e não
  renovou, quando o certificado está prestes a vencer ou venceu, e quando o log do Caddy mostra a
  emissão falhando repetidamente (3 rodadas em pelo menos 1 hora; crítico após 24 horas sem
  certificado, contadas desde o primeiro instante da falha, que o painel guarda em arquivo porque
  só lê as últimas 24 horas do log). Se o log do Caddy não puder ser lido ou vier vazio, o painel
  não conta isso como recuperação: o alerta fica como estava. Alertas de nomes que saíram da lista
  (projeto removido, certificado que virou manual) são resolvidos mesmo depois de reiniciar o
  painel. Os alertas de certificado manual com o título antigo ("vence em até 7/30 dias") são
  resolvidos na atualização, sem duplicar com o novo. A mensagem traz o nome, a causa traduzida e o que fazer. O alerta sai depois de duas
  conferências limpas e um alerta reconhecido não volta enquanto o problema durar.
- O aviso "vence em breve" agora é proporcional à validade do certificado (antes: 20 dias fixos
  para o automático e 30 para o manual), então vale para 90, 64, 45 e 6 dias: o Caddy renova com 1/3
  da validade, o painel avisa com 1/4 (nunca antes de o Caddy começar a renovar, mesmo com 12 horas de validade) e fica crítico com 1/12 (entre 6 horas e 7 dias). O manual
  avisa com 1/3 da validade, no máximo 30 dias. A página Certificados mostra a próxima renovação
  esperada (com a validade do certificado) e o estado do alerta.

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
- Saúde do e-mail em dois níveis: o card separa o que é do servidor (IP, DNS reverso, nome do HELO,
  porta 25, certificado, listas de bloqueio: valem para todos os projetos) do que é do domínio (A, MX,
  SPF, DKIM, DMARC, propagação, MTA-STS, TLS-RPT e a fila de envio, que só olha as mensagens enviadas
  por `@domínio`). A aba Remetente de cada projeto com e-mail mostra o pior nível entre domínio e
  servidor, com a contagem de cada um e um aviso vermelho para qualquer crítico do servidor, e os itens
  do domínio numa expansão. Cada item que não está em ordem, e cada bônus, tem um "O que fazer"
  expansível com passos curtos e valores copiáveis; o PTR traz o texto pronto para o suporte da
  hospedagem (com o IP e o nome da própria VPS) e, no 2º domínio de um servidor, manda conferir o item
  do HELO. O próximo passo do DMARC (quarentena, depois rejeitar) aparece como sugestão opcional, com o
  risco. O botão de verificar espera 15 s por domínio (ou o tempo que o servidor pedir) e o servidor
  aceita no máximo 10 verificações do botão por minuto; pedido a domínio não cadastrado não gasta vaga.
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
- Os certificados HTTPS e a conta do Let's Encrypt do Caddy (volume `paas_caddy_data`) entram na cópia
  externa **cifrada** do painel e voltam na restauração (pela tela e pelo `restaurar-painel.sh`),
  sem apagar nem sobrescrever o que o Caddy já tem (um certificado novo nunca é trocado por um velho),
  recusando backup com link ou arquivo especial, e com permissão só para o root; assim a VPS nova não gasta o limite
  de 50 certificados por semana do Let's Encrypt. A cópia da VPS (sem senha) e a externa sem cifra
  não levam essas chaves. O painel recarrega o Caddy depois de restaurar; o que já venceu o Caddy
  emite de novo.

**Domínios dos clientes (SaaS)**

- Domínios dinâmicos no projeto: o domínio próprio de cada cliente (`app.escola-cliente.com.br`) e os
  subdomínios de um sufixo seu (`cliente1.seu-saas.com.br`, um nível, um certificado por nome) são
  atendidos pelo mesmo projeto sem editar o projeto a cada cliente. O certificado HTTPS de cada nome é
  emitido sozinho no primeiro acesso (emissão sob demanda do Caddy), depois que o DNS aponta para a VPS.
  O estado "Aguardando DNS / emissão" aparece até lá.
- O Caddy só emite para nome autorizado: ele pergunta ao painel (`ask`) por uma porta interna, separada
  da API, que não é publicada, recusa quem não vem da rede do Docker, falha fechada e não grava o nome
  em log. Só valem nomes cadastrados no projeto (ou um nível abaixo de um sufixo dele, se a opção
  "aceitar qualquer subdomínio" estiver ligada, desligada por padrão).
- Tetos ajustáveis em Configurações → Domínios dinâmicos: **500 nomes por projeto** (10 a 5000), **20
  emissões novas por hora** (1 a 100) e **40 emissões novas por semana por domínio** (1 a 49, abaixo dos 50
  certificados por domínio registrado a cada 7 dias do Let's Encrypt), contra abuso e contra o limite do
  Let's Encrypt. Renovação não gasta a cota; um certificado visto vencido volta a gastar.
- Antes de gastar uma emissão nova, o painel confere se o DNS do nome (A/AAAA, seguindo CNAME) aponta para
  a própria VPS. Nome que não aponta é recusado sem consumir a cota dos outros clientes. O painel descobre o
  IP da VPS sozinho: `PAAS_PUBLIC_IP` / `PAAS_PUBLIC_IPV6` do `.env` (o `docker-compose.yml` agora repassa as
  duas, e o `install.sh` grava o IP que detecta), o IP de qualquer endereço `1-2-3-4.sslip.io` do painel ou o
  IP informado em Configurações → Domínios dinâmicos (vale na hora, sem consulta a serviço externo). Sem
  nenhum IP conhecido nada novo é autorizado e a tela avisa em destaque: "IP público da VPS desconhecido:
  nenhum certificado novo será emitido".
- **Atualização:** o `docker-compose.yml` passou a repassar `PAAS_PUBLIC_IP`, `PAAS_PUBLIC_IPV6` e
  `PAAS_ASK_PORT` ao painel (vazias por padrão). A atualização de sempre basta: `cd /opt/tws-panel && sudo git
  pull && sudo docker compose up -d --build`. Se o painel usa um domínio seu (não `1-2-3-4.sslip.io`) e o
  `.env` ainda não tem o IP, a tela de Configurações → Domínios dinâmicos avisa e o IP é informado ali uma
  vez (ou `PAAS_PUBLIC_IP=<ip>` no `.env` seguido de `sudo docker compose up -d`).
- Um sufixo não pode cobrir o site fixo nem o nome dinâmico de OUTRO projeto, nem ser o domínio de aplicações ou
  ficar abaixo dele. O painel, o webmail e o e-mail podem ficar sob o sufixo (o nome exato vence o curinga e o
  `ask` os recusa como reservados), e um sufixo acima do domínio de aplicações vale. O nome exato de um projeto
  sempre vence o curinga de outro. Nomes de
  hospedagem compartilhada ou gratuita (`github.io`, `sslip.io`, `eu.org`...) são recusados e `.example`/`.alt`
  geram aviso.
- A consulta do Caddy ao painel (`ask`) exige um segredo na URL (gerado na primeira subida, em `data/`,
  comparado em tempo constante). Projeto apagado deixa de ser autorizado na hora. O teto de nomes vale mesmo
  com muitos acessos simultâneos num sufixo aberto.
- Arquivo de estado ilegível: o Caddyfile mantém a última lista boa (os clientes não saem do ar), o painel
  cria um alerta crítico, a renovação de quem já tinha certificado continua autorizada e nada novo é
  autorizado até restaurar o arquivo. Nome ou sufixo antigo que uma regra mais dura passou a recusar é
  descartado na leitura (com alerta), sem derrubar o arquivo inteiro.
- O teto semanal por domínio sobrevive ao reinício (`data/dynamic-domains.usage.json`). Com o sufixo aberto,
  poucas consultas de DNS de nomes não cadastrados rodam ao mesmo tempo (as demais recebem "ocupado").
- Alertas de certificado dos nomes de clientes vêm agrupados por projeto (um alerta com a contagem), não um
  por nome. O token de um projeto só não vê o contador de emissões do servidor.
- Tela do projeto: lista com busca, filtro por situação e páginas (centenas de nomes), cadastro, remoção,
  sufixos e aviso quando o proxy ainda não alcança o painel.
- Token de API de alcance **"só os domínios dos projetos escolhidos"** (níveis Leitura e Escrita): o app do
  cliente cadastra e remove os domínios do próprio projeto pela API e mais nada; fora da lista é o mesmo
  404 do projeto inexistente. Sufixos e tetos só a pessoa altera.
- Os nomes dinâmicos aparecem em Certificados e alimentam os alertas de renovação; a lista entra no backup
  do painel (os certificados já iam na cópia externa cifrada pelo volume do Caddy).
- Caddyfile sem reescrita por domínio: um bloco curinga por sufixo cobre todos os nomes dele sem recarregar
  o proxy; nomes avulsos novos recarregam em lote.
- Guia do site "Domínios dos seus clientes (SaaS)" (português e inglês): DNS passo a passo (CNAME e A),
  Cloudflare em somente DNS (nuvem cinza), o limite de 50 certificados por domínio a cada 7 dias, API e
  limitações. O painel não usa a API da Cloudflare.

**Documentação e comunidade**

- README, CONTRIBUTING, SECURITY e CODE_OF_CONDUCT em inglês (idioma principal), com o README e os
  textos de comunidade também em português do Brasil; `ROADMAP.md` com o que existe e o que vem.
- Guias traduzidos para o inglês e publicados num site (Starlight, em `site/`) com busca e dois
  idiomas, no GitHub Pages, a partir da branch `main`. `pnpm docs:links` confere os links internos.
- Guia "Como preparar seu projeto" (site, em português e inglês): como o painel decide o que fazer com o
  repositório, receitas prontas (site estático, Dockerfile, app com banco, Laravel, Next.js), variáveis,
  regras que barram o deploy, checklist e um texto pronto para um assistente de IA.
- Modelos de issue em formulário (bug, sugestão, pergunta ou documentação) e modelo de pull request.

### Alterado

- DNS reverso (PTR) ausente ou incompatível passou de crítico (vermelho) para atenção importante
  (laranja): com SPF, DKIM e DMARC passando o Gmail aceitou sem ele, mas Microsoft, Yahoo e
  servidores corporativos podem atrasar ou recusar. O vermelho fica para porta 25 bloqueada e falha
  de autenticação.

- O painel escuta só em `127.0.0.1`; quem atende de fora é o proxy, nas portas 80 e 443.
- O usuário do terminal não é mais colocado no grupo `docker`.
- A fase 00 do hardening não atualiza o Docker, para não derrubar o próprio painel.
- Os guardrails analisam o mesmo compose que o deploy usa.
- A documentação foi reorganizada: README curto e guias em `site/src/content/docs/`.

### Removido

- "Enviar do meu computador" (upload de pasta) no assistente de Novo Projeto: a origem do código
  passou a ser git, GitHub ou pasta do servidor.

### Corrigido

- Envios do projeto: o status de um envio não fica mais em "na fila" depois que o e-mail já foi
  entregue. A causa provável é que o painel só lia o registro de entrega do Stalwart a cada 5 min:
  abrir a lista nesse intervalo mostrava "na fila". Agora abrir a lista pede a leitura (no
  máximo uma por minuto, mesmo quando falha, e sem atrasar a tela). A cada 5 min, resultados
  de entrega já guardados são reaplicados aos envios pendentes ou "sem confirmação" (vale
  também para envios de antes desta correção; reaplicar não conta o mesmo adiamento duas vezes
  nem regrava o registro). Envio sem nenhum resultado em 6 horas passa a "sem confirmação", e
  o filtro "Na fila" acompanha o que a tela mostra. Aviso do envio e resultado de entrega
  passam a ser gravados um de cada vez (não se pisam mais, nos dois sentidos).
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

- Emissão sob demanda de certificados (domínios dos clientes): o Caddy só emite para nome que o painel
  autoriza. A consulta (`ask`) usa uma porta interna fora do Fastify, que recusa origem fora da rede
  privada, não grava o nome em log e nega tudo se o estado não pôde ser lido (falha fechada). Tetos de
  500 nomes por projeto e 20 emissões novas por hora (ajustáveis) e no máximo 3 tentativas novas por nome
  e por hora protegem contra quem aponta nomes inventados para a VPS. O novo alcance de token
  "domínios do projeto" só tem Leitura/Escrita, só alcança 4 rotas e nunca altera sufixos nem tetos;
  recusas de nome em uso falam só "indisponível" a um token limitado.
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
