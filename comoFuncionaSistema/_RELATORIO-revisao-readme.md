# Relatório: revisão editorial do README e dos textos de comunidade

Escopo: README.md, README.pt-BR.md, CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md, ROADMAP.md,
CHANGELOG.md, `.github/ISSUE_TEMPLATE/*`, `.github/PULL_REQUEST_TEMPLATE.md` e
`docs/community/pt-BR/*`. Nenhum arquivo de `apps/web`, `site/src/content/docs` ou código do painel
foi tocado. Base: `origin/dev` (avancei o worktree por fast-forward; a única diferença era o
contato do CODE_OF_CONDUCT).

## O que mudou e por quê

### Paridade EN / pt-BR

- **Instalação.** O README em inglês trazia um comando único; o pt-BR trazia três blocos (criar
  usuário, gerar chave SSH, instalar), com um aviso sobre `ssh-keygen` e um link `#passo-4`. Os
  dois agora têm o mesmo comando único e o mesmo aviso de "primeira vez numa VPS nova", que remete
  ao guia de instalação para o passo a passo de usuário e chave.
- **Estrutura.** O pt-BR não tinha o cabeçalho centralizado com navegação, a seção "Escopo e
  limitações" (que estava diluída em "Segurança") nem a frase sobre "Não vou usar" no EN. Tudo
  espelhado. Emojis nos títulos do pt-BR removidos (o EN não tinha).
- **CONTRIBUTING pt-BR** estava atrás do inglês: faltavam "Por onde começar", a seção
  "Documentação" e o link para o guia de desenvolvimento. Reescrito seção por seção; o aviso "pode
  estar um pouco atrás" saiu.
- **SECURITY pt-BR** tinha a ordem diferente (versões suportadas no fim) e sem a tabela e o link
  para o guia de operação. Alinhado.
- **CODE_OF_CONDUCT pt-BR** dizia "versão 2.0" e não tinha "casta", enquanto o EN é a 2.1. Corrigido
  (texto e URL de atribuição). O restante é o texto original.
- **Links de comunidade no pt-BR** apontam para as versões pt-BR (já era assim) e o CHANGELOG e o
  ROADMAP, que só existem num idioma, estão sinalizados.

### Fatos que estavam desatualizados ou imprecisos (conferidos no código)

- "Deploy guardrails: 6 rules" estava defasado: `GUARDRAIL_RULES` em
  `packages/deploy/src/rules.ts` tem 16 regras (13 `block`, 2 `warn`, 1 `info`), e 4 bloqueios não
  aceitam override. Troquei o número por uma descrição que não envelhece ("a maioria dos bloqueios
  aceita override explícito e auditado").
- CONTRIBUTING dizia "JSON/SQLite em `data/`". Não há SQLite no servidor (só dentro do Roundcube);
  agora diz "arquivos JSON".
- CONTRIBUTING dizia "nada de shell arbitrário vindo da UI", o que contradiz o terminal web.
  Passou a dizer que o terminal é a única exceção deliberada.
- CONTRIBUTING dizia "o CI bloqueia o merge sem testes". O CI só confere os thresholds; a frase
  virou "todo PR precisa de testes".
- CONTRIBUTING falava de Discussions "se estiverem habilitadas": `gh api` confirmou
  `has_discussions: true`; condicional removido.
- SECURITY dizia "token de uso único". No código (`setup-token.ts`) o token deixa de valer quando o
  setup termina, mas não é consumido no primeiro uso. Reescrito assim.
- README dizia que "Docker, Node e o resto" são instalados. Não confirmei Node no host (o painel
  roda em Docker); passou a "Docker e tudo o que o painel precisa".
- README: "Email blocklist checks" ficou "verificação do IP do servidor de e-mail em listas de
  bloqueio". ROADMAP: o score de entregabilidade conta "há quanto tempo você envia" (item
  "Aquecimento" em `deliverability-score.ts`), não "dias enviando" do IP.
- Rodapé de licença alinhado ao arquivo LICENSE ("TWS - Kelvin Medeiros").
- CHANGELOG (pt-BR): "guias em `docs/`" não vale mais (estão em `site/src/content/docs/`);
  "portas 80/443 de app comum" virou plural.

### Inglês (naturalidade e tom)

Voz ativa, frases mais curtas, "static HTML" em vez de "plain HTML", "multiple" em vez de
"several", "ready-to-use", "software company" em vez de "software house", "mail server" para o
software e "email" para as mensagens, "an hourly limit applies" em vez do substantivado "an hourly
limit". Retirei "professional email" do slogan (adjetivo de marketing sem lastro): agora é "run
your own email". "Mandatory philosophy" virou "core principle". Princípios do projeto viraram lista.
Títulos em sentence case em todos os arquivos.

### Português

Acentuação e concordância conferidas; "Wizard", "hardening", "guardrails", "override", "rollback",
"deploy" e "baseline" mantidos como termos do projeto (aparecem assim na interface e nos guias).
"Roteiro" mantido para o checklist "Deixe o painel pronto" (é o termo da UI e dos guias pt-BR).

### Estrutura do README

Primeira dobra: slogan de duas linhas, selos (licença, beta, CI), navegação, captura do Dashboard e
aviso de beta. Ordem mantida: por que existe, o que faz, instalação, depois de instalar, escopo,
documentação, segurança, roadmap, contribuir, sobre, licença. Não movi seções grandes: a ordem já
segue o padrão de projetos maduros. Nada de selo, número, comparação ou depoimento novo.

## Glossário adotado (EN / pt-BR)

| EN | pt-BR |
|---|---|
| panel | painel |
| project | projeto |
| deploy (substantivo e verbo) | deploy |
| domain | domínio |
| certificate | certificado |
| backup / restore | backup / restauração (restore só no nome de botão) |
| mail server (software) / email (mensagens) | servidor de e-mail / e-mail |
| mailbox | caixa de e-mail (ou "caixa") |
| hardening | hardening |
| guardrails | guardrails |
| override | override |
| setup token | setup token (como na UI) |
| checklist "Get the panel ready" | roteiro "Deixe o painel pronto" |
| DNS checklist | checklist de DNS |
| sends (página) | Envios |
| off-site copy | cópia externa |
| beta | beta |

Padrão de títulos: sentence case. Nomes de tela em inglês trazem o nome em português em itálico na
primeira ocorrência relevante, seguindo a regra do CONTRIBUTING.

## Verificação

- `pnpm docs:links` (node scripts/check-doc-links.mjs): OK, 46 arquivos, nenhum link quebrado, após
  cada alteração.
- O site `https://kelvindk9w.github.io/tws-panel/` respondeu HTTP 200. Os links do README para o
  site são caminhos de arquivo do repositório (conferidos pelo verificador), mais a URL raiz.
- Valores da tabela de cobertura do CONTRIBUTING conferidos contra os `vitest.config.ts`: batem.
- Imagens de `docs/assets/` existem; vi `dashboard.png` e o texto alternativo confere (checklist e
  três projetos "rodando").
- Requisitos conferidos: Ubuntu 22.04/24.04 e portas no `install.sh`; "1 vCPU / 2 GB / 25 GB" está
  nos guias, mas o pré-flight do instalador só avisa abaixo de 1,5 GB de RAM e 10 GB de disco
  (o README fala em mínimo "recomendado", então não é contradição).

## O que NÃO consegui confirmar contra o código

- Prazos do SECURITY (72 horas, 90 dias): são compromissos seus, não verificáveis. Mantive.
- A história "Por que existe" (mudança parada por dias, sem resposta do suporte): narrativa
  sua, mantida sem alteração de fato.
- "Não invasivo: reaproveita o Docker da máquina e não mexe no que funciona": o pré-flight e o
  pedido de confirmação existem, mas não auditei o instalador inteiro contra "não mexe em nada".
- "Mensagens sem o IP da VPS" nas notificações e "conferência de que chave e certificado
  combinam": vêm do texto original e dos guias; não reli o código dessas duas funções.
- Que os "guardrails" listados como exemplo (porta de banco, container privilegiado) estejam todos
  em `block`: estão em `GUARDRAIL_RULES`, mas "credenciais fracas" aparece como bloqueio também.
- O modo "só túnel" e `--acesso=tunel` não foram exercitados.
- Não executei o instalador nem abri o painel; nada foi testado em VPS.

## Sugestões que dependem do Kelvin

1. **Capturas de tela e GIF.** O README tem 4 imagens estáticas. Um GIF curto (instalar, abrir o
   token, primeiro projeto no ar) seria o maior ganho de primeira dobra, mas precisa de gravação
   com dados fictícios. Não criei nenhum.
2. **CHANGELOG em inglês.** O repositório é "EN principal", mas o CHANGELOG só existe em português
   (mantive e avisei no topo e no README). Traduzir exige decidir se o arquivo raiz vira EN e
   ganha cópia em `docs/community/pt-BR/`; vários guias linkam `blob/main/CHANGELOG.md`.
3. **Guia de instalação e site.** O `installation.md` diz que o clone "começa na branch `dev`", mas
   a branch padrão do repositório já é `main` (`gh api`: `default_branch: main`). Fica para quem
   edita `site/src/content/docs`. O mesmo vale para "token de uso único" em `reference/security.md`.
4. **Texto de divulgação** (post, Show HN, perfil do GitHub "About"): sugiro reaproveitar
   exatamente o slogan atual e a lista de princípios, sem acrescentar comparações com outros
   painéis. Posso redigir se pedir.
5. **Termo "roteiro"** (pt-BR) vs "checklist" (EN): se preferir um termo único, é só trocar na UI e
   nos guias; deixei como está para não divergir da interface.
6. **Texto de licença de contribuição** (item 2 do CONTRIBUTING, sublicenciamento): é decisão
   jurídica sua; só melhorei a redação, sem mudar o sentido. Vale uma leitura de advogado.
7. **Link do LinkedIn e e-mail** no "Sobre": mantidos como estavam.

## Commits (por tema)

README EN/pt-BR; CONTRIBUTING EN/pt-BR; SECURITY EN/pt-BR; CODE_OF_CONDUCT pt-BR; ROADMAP;
CHANGELOG; modelos do `.github`. Sem push.
