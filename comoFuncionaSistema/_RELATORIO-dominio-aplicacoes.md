# Relatório — Domínio de aplicações (21/10/2026)

Branch `worktree-agent-a64328f813237c255`, a partir de `origin/dev` (7d627a4). Sem push. A integração com a
API de DNS da Cloudflare ficou fora deste lote.

## O problema, com honestidade técnica

O endereço automático `https://<projeto>.<ip-com-hífens>.sslip.io` deixa o IP da VPS à vista em prints e
links, quebra se o IP mudar e depende de um serviço de terceiros. **Não é uma vulnerabilidade**: o IP de uma
VPS que hospeda sites sempre é descobrível por DNS. O ganho é de privacidade/aparência, estabilidade e
independência de terceiro. A documentação e a interface dizem isso sem alarmismo (aviso âmbar, não erro).

## O que mudou (pelo comportamento)

- **Aviso âmbar no passo 3** quando o endereço escolhido é sslip.io: "Este endereço contém o IP da VPS. Use
  para testar; para publicar, use o seu domínio ou subdomínio." (en equivalente). Tem ícone, título e texto
  (`role="note"`), o atalho "Usar meu domínio ou subdomínio" e o link "Configurar o domínio de aplicações"
  (abre em outra aba para não perder o assistente). Some com domínio próprio, `.localhost` e endereço sob a base.
- **Indicador discreto "contém o IP da VPS"** (ícone + texto curto, com título) nos endereços sslip.io já
  criados: lista de domínios do projeto e cabeçalho da página do projeto. Dashboard ficou de fora de propósito
  (a lista já é densa e o arquivo é tocado por outro executor).
- **Nova seção Configurações → Domínio de aplicações** (`/settings/apps-domain`): digitar a base mostra o
  registro curinga (A, e AAAA só se `PAAS_PUBLIC_IPV6` existir) com copiar; **Verificar DNS e salvar**;
  trocar; remover (avisa quantos projetos já usam a base e que continuam funcionando); selo Verificado / A
  conferir; limite do Let's Encrypt e link do guia (`links.ts`).
- **Endereço automático sob a base**: `<slug>-<5 caracteres>.<base>`; o sslip.io deixa de ser padrão quando há
  base verificada e vira o "Endereço de teste", com o aviso. Projetos existentes não mudam.
- Se a base for configurada em outra aba com o assistente aberto, ao voltar (evento `focus`) o endereço
  automático passa a ser o novo (a escolha de teste ou domínio próprio não é tocada).

## Decisões

1. **Salvar só com a verificação certa** (não há "salvar com aviso"). Uma base que não resolve geraria
   endereços que não abrem e tentativas de certificado inúteis (que gastam o limite do Let's Encrypt). Quem
   precisa esperar a propagação só repete o clique. A tela mostra o registro antes de verificar (pré-visualização
   no navegador; o servidor normaliza de verdade).
2. **Verificação por rótulo aleatório** (`paas-check-<12 caracteres>.<base>`): só um registro curinga passa; um
   registro só para o nome exato não. Reaproveita `checkPanelDomainDns` (público primeiro, sistema de reserva,
   IPv6, Cloudflare = não aponta) e acrescenta **prazo de 6 s por consulta** (resolvedor que trava vira "DNS não
   respondeu", falha segura).
3. **Reconferir a base atual**: resposta definitiva de que não aponta tira o "verificado" (a base deixa de ser
   oferecida); "DNS não respondeu" não tira. Verificar base nova que falha não mexe na salva.
4. **Restauração do painel**: `apps-domain.json` está no diretório de dados e volta com o backup. O arquivo
   guarda o IPv4 para o qual o DNS foi conferido; em VPS com IP diferente a base volta **A conferir** e deixa
   de ser oferecida até reconferir. Isso foi feito sem tocar `backup-service` (outro executor). Documentado na
   restauração.
5. **Página própria** em vez de dentro de Domínio do painel: a página existente tem testes com botões e rótulos
   que colidiriam ("Verificar DNS", "Domínio do painel").
6. **Um registro curinga, sem certificado curinga** e sem on-demand TLS. Verificado em `caddy.ts`: o Caddyfile é
   só blocos por host + o bloco `http://` (404 "domínio não configurado"). Não existe bloco global nem
   `on_demand_tls`. Um nome aleatório sob a base, sem projeto, só cai no `http://` e não recebe certificado.
   Travado por `packages/deploy/tests/caddy-apps-domain.test.ts` (teste de caracterização: já passava, protege
   contra mudança futura).
7. **Nomes**: só slug do projeto (30 caracteres, sem hífen nas pontas, sem prefixo `xn-`) + 5 caracteres de um
   alfabeto sem ambíguos; nunca IP. Confere colisão a cada candidato (projetos, aliases, painel, `mail.*`); 8
   tentativas com 5 caracteres, 8 com 8, depois erro claro.
8. **Limite da base**: mínimo de 3 rótulos (subdomínio dedicado, sem lista de sufixos públicos), no máximo 200
   caracteres.

## Segurança (fluxo de entrada)

Validação em `normalizeAppsDomainInput`, com teste adversarial por item (`apps-domain.test.ts`, 105 testes, e
`routes-apps-domain.test.ts`):

- Injeção/Caddyfile: `;`, `{`, `}`, quebra de linha (`\n`, `\r\n`), `\0`, tab, espaço, `\`, aspas, crase, vírgula,
  `@`, `?`, `#`, caminho. O resultado aceito sempre passa na mesma regex estrita do Caddyfile; a mensagem de
  erro nunca repete o texto digitado.
- Curinga: `*.base` digitado vira só a base; qualquer outro `*` (`*apps`, `a*`, `**.`, `apps.*.`, `*`) é recusado.
- Porta (`:8080`, `https://…:443/`), IP em qualquer forma (v4, v6, `[::1]`, numérico, hex, TLD numérico).
- IDN/largura total: convertidos por `domainToASCII` (punycode) e reconferidos; `xn--` inválido que já vem em ASCII (ex.: `xn--abc.`) passa pela regra de hostname e é aceito (inofensivo: só não resolve); só o que termina em hífen é recusado.
- Maiúsculas, ponto final, `https://`, barra final: normalizados. Rótulo > 63 e nome > 200: recusados.
- Reservados: `.localhost`, `.local`, `.internal`, `.lan`, `.home(.arpa)`, `.localdomain`, `.intranet`, `.corp`,
  `.private`, `.test`, `.invalid`, `.onion`, `.arpa`, `.example`; sslip.io, nip.io, xip.io, traefik.me,
  localtest.me, lvh.me, localhost.run.
- Colisão: endereço do painel (inclusive o domínio cadastrado ainda sem DNS), domínio de projeto (principal ou
  alias), `mail.<base>` (domínio de e-mail). Rotas: 400/409 com código estável; erro inesperado vira 500 sem
  detalhe interno. Todas as rotas exigem sessão (teste de 401).
- Também no Caddyfile (defesa em profundidade): curinga, porta, `;`, quebra de linha e `{http.request.host}` em
  domínio ou alias são descartados.

Lacunas conhecidas: o domínio **do painel** pode ser cadastrado igual à base de aplicações (não bloqueei no
sentido inverso para não mexer em `panel-domain`); é inofensivo (rota explícita ganha), mas fica como melhoria.

## Let's Encrypt

Documentado no guia (Parte 2) e em Solução de problemas: **50 certificados novos por semana por domínio
registrado** (o `example.com`, somando subdomínios) e 5 idênticos por semana (valores do que eu conhecia; vale
reconferir na documentação atual do Let's Encrypt antes de publicar). Quando a emissão falha, a página
Certificados já mostra a causa e o botão "Tentar emitir agora"; o painel não contorna o limite. Cada projeto
criado e depois abandonado no assistente não gasta certificado: o projeto nasce com um endereço provisório único
(`<projeto>-<sufixo>.localhost`, conferido como livre contra projetos, apelidos, painel e e-mail; o proxy o serve em HTTP
puro, sem certificado público e sem IP). Só ganha o endereço sob a base ao clicar em "Criar projeto", se a pessoa
escolher o automático; antes disso o servidor da sugestão é consultado de novo e, se a base mudou ou saiu, nada é
gravado sob ela (aviso e novo endereço; a base guardada é comparada com a atual, então trocar `apps.example.com`
por `example.com` também é pego). Um projeto que ficou com o provisório num painel público não abre no computador de
quem acessa: a Visão geral e a lista de projetos mostram um aviso âmbar com atalho para Domínios e não linkam o
endereço (helper `isProvisionalDomain`/`showsProvisionalNotice` em `packages/core`, com teste). Vale também para painel sem sslip.io (túnel SSH), sem exceção. Todo certificado é público (Certificate Transparency): o nome do projeto e o sufixo ficam
visíveis; o sufixo evita colisão, não esconde o endereço.

## Documentação

Site (en e pt-br, paridade de títulos e âncoras): Parte 2 (subseção "Domínio de aplicações", âncora
`dominio-de-aplicacoes`, passo 3 do primeiro projeto, checklist), Funcionalidades (nova seção), Solução de
problemas (verificação falha; limite do Let's Encrypt), Restauração em outro servidor (IP diferente: registro
curinga e "Verificar DNS de novo"). Mapa do sistema: `configuracoes/dominio-de-aplicacoes.json`, índices, e 27
mensagens novas em `_i18n-servidor-fase2.tsv`. Glossário implícito: "Domínio de aplicações / Apps domain",
"Endereço de teste / Test address".

## Verificação

`pnpm install --frozen-lockfile`, typecheck, `docs:build`, `check:build`, `docs:links` (60 URLs do site conferidas
contra o build), `docs:site-url` e `check-no-real-hosts`: tudo OK. Testes com cobertura (`--no-bail`, server com
`--maxWorkers=2`), todos passando e acima dos mínimos:

| Pacote | Arquivos / testes | Instruções | Ramos | Funções | Linhas |
|---|---|---|---|---|---|
| core | 13 / 119 | 99,64 | 98,75 | 100 | 100 |
| web | 66 / 1072 | 92,04 | 86,40 | 90,35 | 93,36 |
| deploy | 47 / 840 | 98,52 | 95,72 | 99,05 | 99,26 |
| mailer | 17 / 362 | 99,90 | 98,45 | 100 | 100 |
| security | 12 / 215 | 99,33 | 97,33 | 100 | 100 |
| server | 132 / 2129 (2 ignorados) | 97,73 | 93,36 | 98,15 | 98,88 |

Testes novos: servidor (validação adversarial, verificação com resolvedor falso: ok, curinga ausente, nome exato
só, Cloudflare, IP errado/misto, IPv6, timeout/travamento, fallback, rótulo aleatório; sugestão: colisão, nomes
hostis; persistência e IP diferente; rotas; integração com `DeployService` e arquivos reais), Caddy, web
(aviso só para sslip, três modos do passo 3, atualização ao voltar à aba, configuração, verificação, estados de
erro, en/pt, indicador). Capturas Playwright da configuração (vite com API simulada, 390 px pt-BR e 1440 px en):
sem rolagem lateral; as imagens ficaram só na pasta temporária da sessão. O passo 3 foi validado apenas por testes
de componente.

## O que NÃO foi testado

- **DNS real e emissão real no Let's Encrypt**: tudo com resolvedor falso e Caddyfile renderizado, sem Caddy
  subindo. Falta, numa VPS: criar o curinga, verificar, criar um projeto e ver o certificado sair.
- Comportamento real do proxy da Cloudflare com curinga.
- Restauração de ponta a ponta em VPS com IP diferente (coberta por teste de serviço, não por backup real).
- Capturas do passo 3 e em outras combinações de largura/idioma.

## Melhorias futuras

Migrar projetos existentes de sslip.io para a base; integração com a API de DNS da Cloudflare (criar o curinga
sozinho); bloquear o domínio do painel igual à base; indicador também no Dashboard.
