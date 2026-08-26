# Estado da sessão — 25/08/2026 (atualizado ao fim da sessão)

Documento de retomada. Se você é um agente entrando agora, leia este arquivo
primeiro e depois `index.json`. Ele diz **onde o trabalho parou**, o que está
pendente e por quê — informação que não está no código nem no git log.

---

## Onde tudo está

| | |
|---|---|
| Repositório | `github.com/kelvindk9w/tws-panel` |
| Branch de desenvolvimento | `dev` (default do repo) |
| Branch de instalação | `main` — protegida, exige Pull Request |
| PR #8 | **MESCLADO** (squash) — promoveu `dev` → `main` |
| Sincronização | **feita** — `dev` e `main` com o mesmo conteúdo |

**A `main` está pronta para instalação**: RCE fechado, validação de schema, Dockerfile
corrigido, README completo, CI verde nos dois jobs. É o que o README manda clonar.

**Cuidado que originou o PR #8, para não repetir:** a `main` tinha ficado 96 commits
atrás enquanto o README dirigia instalações reais a ela — ou seja, o caminho
documentado entregava software vulnerável. Sempre que houver trabalho relevante na
`dev`, promova. O README agora tem um comando para o usuário conferir isso antes de
instalar.

## O que foi feito nesta sessão

### 1. Documentação legível por máquina (`comoFuncionaSistema/`)
93 arquivos JSON: um índice raiz, um índice por módulo, um arquivo por endpoint
com parâmetros, erros, efeitos colaterais, chamadores e testes. Mais os arquivos
de conceito (guardrails, detecção de stack, DNS, checagens de hardening, tipos de
alerta, ações auditadas) e a pasta `global/` com as peças transversais.

Foi **testada**: um agente restrito a ler apenas esse diretório respondeu 9 de 10
perguntas sobre o sistema de forma completa, sem links quebrados.

### 2. Correções de segurança
- **Execução de comando pela URL do repositório** (o grave). O transporte `ext::`
  do git executava comando arbitrário a partir de um `POST /api/projects` seguido
  de deploy. Como o painel tem o socket do Docker, equivalia a root no host.
  Fechado com allowlist de esquema em `validateGitSource` e de caracteres em
  `validateBranch`.
- **Injeção no Caddyfile** por domínio, fechada na entrada e de novo na geração
  do arquivo (defesa em profundidade — projetos gravados antes da validação).
- **Validação de schema em todas as 10 rotas**, com `coerceTypes` e
  `removeAdditional` desligados no Ajv: o schema recusa, não conserta.

### 3. Correções de comportamento
21 dos 25 achados abertos do review. Entre eles: alertas abertos não são mais
descartados pelo teto; jobs de segurança são persistidos e restaurados no boot;
`start`/`stop` devolvem erro de domínio em vez de 500 opaco; falhas de Docker e
de e-mail deixaram de ser silenciosas; auditoria arquiva em vez de descartar.

### 4. Funcionalidades
- **Edição de projeto** após a criação (nome, repositório, branch, domínio), com
  o painel registrando qual branch está de fato publicada (`deployedBranch`).
- **Fluxo de hardening acessível fora do wizard**, em `/security/hardening`.
- Confirmado por teste que **o mesmo repositório pode ser hospedado duas vezes**
  em branches e domínios diferentes (produção + sandbox) — já funcionava.

### 5. Infraestrutura
- Docker CLI 27.5.1 → 29.7.2 e Compose 2.32.4 → 5.5.0, eliminando 3 CVEs
  CRITICAL. Validado que o override de rede que o painel gera ainda funciona no
  Compose 5.x.
- Trivy passou a bloquear CRITICAL, com allowlist documentada para os dois que
  restam e não estão sob nosso controle.
- `tsconfig.json` do servidor passou a incluir os testes no typecheck.

---

## Pendências — o que fazer a seguir

### Imediato
1. **Instalação na VPS — em andamento.** A primeira tentativa falhou porque a `main`
   estava desatualizada (o Dockerfile copiava `scripts/` depois do `pnpm install` que
   depende dele). Corrigido e mesclado. O usuário resetou a VPS e está refazendo o
   fluxo do zero.
   - Ao reconectar após o reset, o SSH avisa que a identidade do host mudou. É
     esperado (o SO foi reinstalado): `ssh-keygen -f ~/.ssh/known_hosts -R SEU_IP`.
   - Nada foi validado numa máquina real ainda: DNS, emissão de certificado TLS,
     porta 25 do provedor e o hardening aplicado de verdade só se provam lá.

### Próximo bloco de trabalho: repositórios privados
Ordem definida com o usuário, **nesta sequência**:
1. **Camada de segredos cifrados** (AES-256-GCM, chave mestra fora do `dataDir`).
   Pré-requisito de tudo, e absorve as senhas do Stalwart que hoje estão em texto
   plano.
2. **Clone autenticado sem vazamento.** A credencial deve ir por
   `git -c http.extraHeader`, **nunca embutida na URL** — se for na URL, ela
   vaza em três lugares: log do job (visível na UI), stderr do git em caso de
   falha, e `.git/config` (persistido em disco, e o scan de secrets do painel
   exclui `.git`).
3. **Fine-grained PAT** — aqui repositório privado já funciona.
4. **GitHub App via manifest flow** — melhor UX e token de 1h, mas não destrava
   capacidade nova. Permissão necessária: apenas `Contents: read-only`.
5. **Webhook / deploy automático** — junto com o GitHub App, que já traz o canal
   e a validação de assinatura. Exige expor o painel; a alternativa sem exposição
   é polling.

### Achados abertos (decisão do usuário)
- **Stalwart** fixado em `v0.11.8`, afetado pelo **CVE-2025-61600** (DoS não
  autenticado no parser IMAP, corrigido só na 0.13.4, sem backport). Migrar exige
  reescrever `client.ts` (144 linhas, REST → JMAP) e o E2E. Recomendação: P1
  pós-lançamento. Mitigação barata: restringir exposição das portas IMAP.
- **Três riscos aceitos como custo arquitetural**, declarados em
  `global/threat-model.json`: socket do Docker montado, terminal web com root,
  senhas de e-mail em texto plano (esta última sai com o item 1 acima).
- `PUT /api/security/monitor/config` responde e audita o `intervalMs` enviado,
  não o valor efetivamente aplicado após o clamp.
- Trivy bloqueia CRITICAL, mas **HIGH ainda passa**.
- A imagem de produção **carrega devDependencies** (`Dockerfile:87` copia o
  estágio de build inteiro). Corrigir reduz tamanho e superfície.

---

## Lições desta sessão (evitar repetir)

- **Subagentes no mesmo diretório se atropelam.** Quatro agentes rodando em
  paralelo no mesmo working tree causaram `git stash`/`reset` que reverteram
  trabalho uns dos outros. Nada se perdeu, mas por sorte. Use worktrees isolados.
- **Hook local verde ≠ CI verde.** O pre-push roda testes, cobertura e build; o
  CI roda isso **mais o scan de imagem**. O erro se esconde no lado que só um dos
  dois executa. Verifique `gh run list` e compare o SHA testado com o topo da
  branch.
- **Achado de review é hipótese até traçar o caminho de chamada.** O review
  afirmava que existiam "dois sistemas de guardrails dessincronizados". Seguindo
  quem chama quem: `rules.ts` bloqueia o deploy (com scan de secrets) e
  `guardrails.ts` alimenta a detecção de stack. Propósitos diferentes, não
  duplicação.
- **Números em documentação envelhecem sozinhos.** Contagem de testes divergiu
  três vezes, o README afirmava usar SQLite (não existe) e dizia não haver shell
  arbitrário na UI (há: o terminal web é root). Uma checagem automatizada no CI
  para o que é verificável — contagens, links, caminhos citados — resolveria.
- **Espera fixa em teste é falso negativo esperando acontecer.** Dois testes
  intermitentes vieram de `setTimeout` fixo aguardando escrita assíncrona. A
  correção é esperar pela condição ou expor um `flush()`, nunca aumentar o sono.

## Detalhes que custaram tempo e vale saber de antemão

- **A `main` é protegida** (`protect-main`): push direto é rejeitado, só entra por Pull
  Request. Isso é correto e foi respeitado — quando o push falhou, o caminho foi abrir
  PR, nunca contornar. `protect-dev` também está ativa, mas aceita push direto.
- **O PR #8 foi mesclado com squash**, então a `main` tem a release como um commit único
  sem história compartilhada com a `dev`. Sincronizar depois disso gera conflitos que são
  artefato da história divergente, não de conteúdo: resolver favorecendo a `main` funciona,
  mas **verifique antes que ela é superconjunto** (foi o caso — as linhas que só a `dev`
  tinha eram versões antigas de trechos reescritos).
- **Hook local verde não significa CI verde.** O pre-push roda testes, cobertura e build;
  o CI roda isso **mais o scan de imagem**, que precisa construir o Dockerfile. Confira com
  `gh run list` e compare o SHA testado com o topo da branch — CI verde de dois commits
  atrás não diz nada.
- **Drop-in de sshd: o primeiro arquivo vence, não o último.** O README mandava o usuário criar
  `99-tws-panel.conf` para afrouxar o timeout de sessão ociosa, mas o painel grava
  `99-paas-hardening.conf` — que ordena antes e, pela semântica do OpenSSH (*the first obtained
  value will be used*), ganha. O override do usuário virava letra morta em silêncio, só depois de
  aplicar o hardening. Corrigido para `10-local-override.conf`. Ao contrário de systemd/sysctl.d,
  em `sshd_config.d` prefixo numérico **baixo** significa prioridade **alta**. E a verificação
  honesta não é olhar o arquivo, é `sudo sshd -T | grep -i clientalive`, que mostra o que o
  servidor de fato adotou.
- **Ao investigar um teste intermitente, varra o arquivo inteiro pelo mesmo padrão.** A
  causa era sempre a mesma (esperar por tempo fixo em vez de por condição) e estava em três
  lugares: dois no teste do terminal e um no de jobs de segurança. Corrigir só a linha que
  apitou fez o problema voltar duas vezes.

## Convenções observadas

- Commits em inglês, conventional commits, corpo explicando **por quê**.
- Comentários no código em português, densos, explicando a decisão e não o óbvio.
- TDD: teste que falha primeiro, verificado falhando pelo motivo certo.
- Nunca commitar sem `pnpm run test:unit` e `pnpm run typecheck` limpos.
- O usuário não quer código colado no chat — cite o caminho do arquivo.
