# Segurança do Repositório Público — Guia de Configuração (TWS Panel)

> Guia prático para publicar o TWS Panel como open source no GitHub com segurança.
> Projeto de infraestrutura/VPS = alvo atrativo para ataques de supply chain.
> Última revisão: 2026-08. Fontes: docs.github.com, github.blog/changelog, OpenSSF, Wiz, análises do caso XZ Utils.

---

## 1. Proteção de branches (Rulesets)

Use **Rulesets** (sucessor do "branch protection" clássico — mais flexível, permite importar/exportar JSON e verificar com `gh ruleset check`). Em repos públicos, tudo isso é **gratuito**.

### Config recomendada para fluxo `main` + `dev`

**Ruleset 1 — "protect-main" (target: `~DEFAULT_BRANCH` ou `refs/heads/main`):**
- ✅ Restrict deletions (bloqueia deleção)
- ✅ Block force pushes (`non_fast_forward`)
- ✅ Require a pull request before merging
  - Required approvals: **1** (0 se for solo maintainer, caso contrário o repo trava)
  - Dismiss stale pull request approvals when new commits are pushed
  - **Require review from Code Owners**
  - Require approval of the most recent reviewable push
- ✅ Require status checks to pass (CI, lint) + "Require branches to be up to date"
- ✅ Require conversation resolution before merging
- ✅ Require linear history (opcional; combine com squash-merge-only)
- ✅ Require signed commits (desejável — ver seção 7)
- ✅ Bypass list: vazio ou só conta de emergência

**Ruleset 2 — "protect-dev" (target: `refs/heads/dev`):** mesmas regras, mas pode relaxar: approvals 0, status checks obrigatórios, sem force push, sem deleção.

**Ruleset 3 — "protect-tags" (target: tag, `v*`):** bloquear criação/atualização/deleção de tags por não-admins (release = tag imutável).

### Aplicar via gh CLI

Salve o JSON e importe (idempotente: verifique se já existe antes — POST cria duplicata; use PUT para atualizar):

```bash
cat > /tmp/ruleset-main.json <<'EOF'
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": true
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [ { "context": "ci" } ]
      }
    }
  ]
}
EOF

gh api repos/SEU_USER/tws-panel/rulesets --method POST --input /tmp/ruleset-main.json

# Repetir para dev (troque "include" para ["refs/heads/dev"])
# Verificar o que se aplica a uma branch:
gh ruleset check main
```

Via UI: **Settings → Rules → Rulesets → New branch ruleset** (também dá para "Import a ruleset" com o JSON versionado no repo em `.github/rulesets/`).

---

## 2. CODEOWNERS

Crie `.github/CODEOWNERS` (local preferido). Regras: **última linha que casa vence**; owners precisam de write access; sintaxe estilo gitignore **sem negação `!`**. Combine com "Require review from Code Owners" no ruleset — sem isso, CODEOWNERS só sugere reviewers, não bloqueia merge.

```text
# Dono padrão de tudo
*                              @SEU_USER

# Áreas críticas — só o dono aprova
/scripts/                      @SEU_USER
/scripts/install.sh            @SEU_USER
/scripts/hardening*            @SEU_USER
Dockerfile                     @SEU_USER
.dockerignore                  @SEU_USER
docker-compose.yml             @SEU_USER
docker-compose.dev.yml         @SEU_USER

# Autenticação / painel
**/auth*                       @SEU_USER

# CI/CD — protege os próprios workflows (crítico!)
/.github/                      @SEU_USER
```

⚠️ **Proteja o próprio CODEOWNERS**: a linha `/.github/ @SEU_USER` garante que ninguém altere CODEOWNERS ou workflows sem sua aprovação. Valide o arquivo com `npx codeowners-audit` ou o action `step-security/codeowners-validator` (erros de sintaxe falham **silenciosamente**).

---

## 3. Ameaças de PRs maliciosos em projetos de infra — e mitigações

| Técnica | Exemplo real | Mitigação |
|---|---|---|
| **Mudança sutil em script de instalação** (um `curl \| sh` extra, variável trocada, permissão relaxada) | Comum em painéis/VPS; `install.sh` roda como root nas máquinas dos usuários | CODEOWNERS em `scripts/` (seção 2); review linha a linha de qualquer diff em shell; CI com `shellcheck`; tratar diff em scripts de install como **sempre suspeito** |
| **Código ofuscado / payload em pedaços** | XZ Utils: backdoor dividido em vários commits, parte em arquivos de "teste" binários | Desconfie de blobs/binários e arquivos não-legíveis em PRs; exija justificativa; rejeite código minificado/ofuscado sem fonte |
| **Dependência maliciosa / typosquatting / starjacking** | `reqeusts` vs `requests`; pacote que linka metadata de repo popular | Lockfiles commitados (nunca aceitar PR que delete/regenere lockfile sem motivo); revisar **todo diff de lockfile**; dependency-review-action no CI; Dependabot alerts |
| **Dependency confusion** | Pacote público com nome de pacote interno | Namespaces/escopos; nunca referenciar pacotes internos no repo público |
| **Exfiltração via CI** (PR modifica workflow ou script executado no CI) | Incidentes `tj-actions`, `trivy-action` (2025) | CODEOWNERS em `.github/`; pin por SHA; permissões read-only (seção 4) |
| **PR gigante diluindo a mudança maliciosa** | Padrão clássico | Política: PRs grandes demais são recusados e pedidos para quebrar |
| **"Living off the pipeline"** — abusar de ferramenta legítima do CI que executa código de config | Wiz, 2026 | Não executar código de PR com secrets (seção 4) |

---

## 4. GitHub Actions seguro

### Configurações do repositório (Settings → Actions → General)

1. **Fork pull request workflows from outside collaborators** → **"Require approval for all outside collaborators"** (não apenas "first-time contributors" — quem já teve 1 typo mergeado pula o gate).
2. **Workflow permissions** → **"Read repository contents and packages permissions"** (default read-only do `GITHUB_TOKEN`).
3. ❌ Desmarcar **"Allow GitHub Actions to create and approve pull requests"**.
4. (Opcional, forte) **Allow actions** → "Allow only actions created by GitHub" + ações verificadas do Marketplace, ou lista explícita.

```bash
# Default read-only + sem aprovação de PR por Actions
gh api -X PUT repos/SEU_USER/tws-panel/actions/permissions/workflow \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false

# Aprovação obrigatória para TODOS os colaboradores externos (fork PRs)
gh api -X PUT repos/SEU_USER/tws-panel/actions/permissions/fork-pr-contributor-approval \
  -f approval_policy=all_external_collaborators
```

### Regras de ouro nos workflows

- **Permissões explícitas no topo de todo workflow**: `permissions: contents: read` (ou `{}`), elevando por job só o necessário.
- **`pull_request` (de fork) NUNCA recebe secrets** — o GitHub já os omite; não tente contornar. Secrets ficam vazios em fork PRs *por design*.
- **`pull_request_target` é quase impossível de usar com segurança** (roda no contexto do repo base, **com** secrets, e **sempre roda** mesmo com approval gate). Regras:
  - NUNCA fazer `checkout` do head do PR (`ref: ${{ github.event.pull_request.head.sha }}`) num job `pull_request_target` — é o padrão "pwn request" (RCE + roubo de secrets; ver advisory GHSA-9jgv-x8cq-296q).
  - Desde jun/2026 o `actions/checkout` v7 **bloqueia** checkout de fork PR em `pull_request_target`, mas `run:` com `git`/`gh` continua podendo baixar código não-confiável.
  - Uso legítimo: só automação de metadata (labels, comentários) sem rodar código do PR.
- **Padrão seguro de 2 workflows**: `pull_request` (sem secrets, builda/testa código do fork, sobe artifact limitado) → workflow privilegiado separado (`workflow_run`/`pull_request_target`) que consome apenas dados validados, nunca executa conteúdo do artifact.
- **Pin de TODAS as actions por SHA completo** com comentário da versão:
  ```yaml
  - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2
  ```
  (Mitiga diretamente os ataques tj-actions/trivy-action. Automatize com Dependabot para `github-actions` + `actionlint`.)
- Não escrever em `GITHUB_ENV`/`GITHUB_PATH` com conteúdo controlado por PR.
- Para deploy/nuvem: **OIDC** (`id-token: write` restrito ao job, trust restrito a repo+branch) em vez de chaves long-lived.
- Secrets em **Environments** com required reviewers, não em repo secrets, quando possível.

---

## 5. Secret scanning + Push protection + Dependabot

Em repos **públicos**: secret scanning e push protection são **gratuitos e automáticos** (push protection vem ligado por default). Confirme em **Settings → Code security and analysis**:

- ✅ Dependency graph
- ✅ Dependabot alerts
- ✅ Dependabot security updates
- ✅ Secret scanning (+ validity checks, non-provider patterns)
- ✅ **Push protection** (bloqueia o push que contém secret — é a linha de defesa mais importante; o que não sobe não vaza)
- ✅ Code scanning (CodeQL default setup — grátis em repo público)

```bash
# Dependabot alerts + security updates
gh api -X PUT repos/SEU_USER/tws-panel/vulnerability-alerts
gh api -X PUT repos/SEU_USER/tws-panel/automated-security-fixes

# Conferir estado de tudo:
gh api repos/SEU_USER/tws-panel --jq '.security_and_analysis'
```

Adicione também `.github/dependabot.yml` cobrindo o ecossistema do projeto **e** `github-actions` (atualiza actions pinadas por SHA):

```yaml
version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule: { interval: "weekly" }
  - package-ecosystem: "docker"   # ou npm/pip/composer conforme o projeto
    directory: "/"
    schedule: { interval: "weekly" }
```

**O que cobrem**: secret scanning detecta tokens/senhas commitados (e alerta o provedor, que pode revogar automaticamente); push protection bloqueia no `git push`; Dependabot alerta CVEs em dependências e abre PRs de correção. **Não cobrem**: secrets ofuscados/encoding, secrets em issues/wikis, padrões custom (configure "custom patterns" se necessário). Complemente com pre-commit hook local (ex.: `gitleaks`).

---

## 6. Separação pública/privada (o repo público NÃO pode dar brecha pros privados)

1. **Nunca** use um classic PAT amplo (`repo` scope = todos os seus repos, públicos e privados) em CI, scripts ou máquinas de terceiros. Prefira, nesta ordem:
   - **GitHub Apps** (tokens de instalação curtos, escopo por repo, auditáveis) — ideal para automação/self-hosted runners.
   - **Fine-grained PAT**: escopo de **1 repo**, permissões mínimas, **expiração obrigatória** (máx 366 dias). Ex.: CI do repo público recebe token que só lê o repo público — se vazar, os privados estão fora de alcance.
   - **Deploy keys** (SSH): chave dedicada **por repo**, read-only quando possível (`Settings → Deploy keys`). Uma chave SSH da sua conta pessoal dá acesso a **todos** os repos — não use em servidores/CI.
2. **OIDC** para cloud em vez de secrets de longa duração.
3. No repo público: nenhum secret, path interno, nome de pacote privado, IP/hostname de infra, nem referência a repos privados em código, issues, workflows ou logs de Actions (logs de repo público são públicos).
4. `.dockerignore`/`.gitignore` deny-by-default; audite `git log --all -p -- .env '*.pem' '*.key'` antes de tornar público (histórico incluso — se algo vazou no passado, reescreva histórico ou recrie o repo).
5. Self-hosted runners: **nunca** em repo público com workflows acionados por forks (fork PR rodaria código na sua máquina/rede).

---

## 7. Proteção da conta/perfil do dono

A conta é o ponto único de falha — se cair, todas as proteções de repo caem junto.

1. **2FA obrigatório** (GitHub já exige para quem contribui código). Hierarquia de força: **passkey / security key (WebAuthn) > TOTP app > SMS** (SMS é fraco — SIM swap). Cadastre **pelo menos 2 fatores** (ex.: passkey + TOTP).
2. **Recovery codes**: baixar, guardar offline (cofre/papel) — e testar um.
3. **Revisar periodicamente** (Settings):
   - **Sessions** → encerrar sessões desconhecidas.
   - **Authorized OAuth Apps** e **Installed GitHub Apps** → revogar o que não usa (caso Heroku/Travis 2022: tokens OAuth roubados).
   - **SSH and GPG keys** → remover chaves antigas/desconhecidas.
   - **Security log** (`Settings → Security log`) → mudanças de visibilidade, transfers, chaves adicionadas.
4. **Commits assinados + vigilant mode**:
   ```bash
   # SSH signing (mais simples que GPG)
   git config --global gpg.format ssh
   git config --global user.signingkey ~/.ssh/id_ed25519.pub
   git config --global commit.gpgsign true
   ```
   Adicione a chave no GitHub **como Signing Key** (é um tipo separado de Authentication Key!). Ative **Vigilant mode** (Settings → SSH and GPG keys → "Flag unsigned commits as unverified"): todos os commits não assinados passam a aparecer como "Unverified", dificultando que alguém comite se passando por você.
5. Email de commit privado: Settings → Emails → "Keep my email addresses private" + "Block command line pushes that expose my email".
6. E-mail da conta com 2FA próprio (é o vetor de recuperação — e de takeover via domínio expirado).

---

## 8. Proteção contra takeover do repo

- **Quem pode deletar/transferir/renomear/mudar visibilidade**: apenas o dono (conta pessoal) ou owners/admins (org). Ou seja: takeover do repo = takeover da conta → seção 7 é a defesa real. Não adicione colaboradores com role **admin**; contribuidores externos ficam sem acesso de escrita (trabalham via fork).
- **Organização vs conta pessoal — vale criar org?** Para este projeto, **sim, vale considerar** (org gratuita serve):
  - ✅ "Require two-factor authentication for everyone in the organization" forçado por política.
  - ✅ Permissões por time; branch restrictions ("Restrict who can push") disponíveis em repo público de org free.
  - ✅ Repo sobrevive à conta pessoal; múltiplos owners de confiança = recuperação sem depender do suporte.
  - ✅ Separa identidade do projeto dos repos privados pessoais (privados ficam fora da org pública).
  - ✅ Security configurations centralizadas (aplicar secret scanning etc. em todos os repos).
  - ⚠️ Crie a org com conta de e-mail dedicada; tenha **2 owners** (um pode ser conta de backup sua, também com 2FA) para não se trancar fora — mas poucos owners (OpenSSF recomenda < 3).
- Se ficar na conta pessoal: nunca adicione colaboradores com mais que **Write**, e mesmo Write só para quem tem confiança longa (ver seção 9).
- Ative **private vulnerability reporting** (`gh api -X PUT repos/SEU_USER/tws-panel/private-vulnerability-reporting`) + `SECURITY.md` para reports de vulnerabilidade não virarem issue pública.

---

## 9. Sinais de alerta em contribuidores (lições do caso XZ Utils)

O backdoor do XZ (CVE-2024-3094) foi um ator que contribuiu **por ~2 anos**, virou co-maintainer e inseriu o payload ofuscado em pedaços — com sock puppets pressionando o maintainer ("por que não adiciona o Jia como maintainer?"). Sinais práticos:

- 🚩 **Conta nova** com primeiro PR tocando área crítica (install script, auth, CI).
- 🚩 **PR grande demais** ou que mistura refatoração cosmética com mudança de comportamento ("mova 300 linhas, mude 1").
- 🚩 Código **ofuscado, minificado, binário/blob**, ou "test fixtures" ilegíveis (foi onde o backdoor do XZ morou).
- 🚩 **Urgência artificial**: "vulnerabilidade crítica, precisa mergear hoje", deadlines inventados.
- 🚩 **Pressão social coordenada**: várias contas pedindo para dar acesso de maintainer a alguém; perfis criados na mesma época com erros de escrita parecidos.
- 🚩 **Pedido de acesso de maintainer/write** após poucas contribuições — política recomendada: write access só após meses de contribuições consistentes e revisadas, e nunca com role admin.
- 🚩 Histórico de commits em horários/padrões que mudam abruptamente (no XZ, os commits maliciosos saíam do padrão de horário).
- 🚩 PRs de "typo/docs" triviais logo no início — tática para virar "contributor conhecido" e **furar o approval gate de first-time contributor** (por isso: "require approval for ALL outside collaborators").
- 🚩 Dependência nova sem justificativa clara, nome parecido com pacote famoso, ou link de registry apontando pra repo alheio (starjacking).

Regra de bolso: **confiança se ganha em meses; review obrigatório não se remove nunca** — nem para "maintainers" novos (dismiss stale approvals + CODEOWNERS cuidam disso automaticamente).

---

## 10. Checklist final (do mais crítico ao desejável)

### Conta (fazer ANTES de publicar)
- [ ] 2FA com passkey/security key + TOTP de backup; recovery codes offline
- [ ] Vigilant mode + commit signing (SSH/GPG) configurados
- [ ] Revisar OAuth apps, GitHub Apps, SSH keys, sessions; email privado

### Criação do repo
- [ ] `gh repo create tws-panel --public` (ou criar org dedicada antes, com 2FA obrigatório e 2 owners)
- [ ] Auditar histórico por secrets: `gitleaks detect -v` (se achar algo, limpar antes de publicar — o histórico público é para sempre)
- [ ] `.gitignore`/`.dockerignore` deny-by-default; sem nenhuma referência a repos/infra privados
- [ ] LICENSE, README, `SECURITY.md` (política de report privado), `CONTRIBUTING.md` (define barra de review e CODEOWNERS)

### Proteções do repo (na ordem)
- [ ] Rulesets `protect-main` + `protect-dev` + tags `v*` (seção 1 — comandos `gh api` prontos)
- [ ] `.github/CODEOWNERS` com `*` e `/.github/` para o dono (seção 2)
- [ ] Actions: `GITHUB_TOKEN` read-only, sem PR approval por Actions, approval para **todos** os outside collaborators (seção 4 — comandos prontos)
- [ ] Confirmar secret scanning + **push protection** + Dependabot alerts/updates (seção 5 — comandos prontos)
- [ ] Private vulnerability reporting ON
- [ ] CodeQL default setup
- [ ] Code review de todos os workflows: `permissions:` explícitas, pin por SHA, sem `pull_request_target` com checkout de PR
- [ ] `.github/dependabot.yml` incluindo ecossistema `github-actions`
- [ ] Limitar merge methods (squash only), auto-delete de head branches
- [ ] Environments com required reviewers para qualquer job de release/deploy; OIDC em vez de secrets long-lived
- [ ] Verificação final: `gh ruleset check main`, `gh api repos/OWNER/REPO --jq '.security_and_analysis'`, e teste prático: abrir PR de um fork fake e confirmar que workflow pede aprovação e merge é bloqueado sem review

### Rotina (recorrente)
- [ ] Revisão trimestral: colaboradores, deploy keys, webhooks, OAuth apps, tokens (rotacionar fine-grained PATs)
- [ ] Revisar com ceticismo PRs que tocam `scripts/`, auth, Dockerfile, `.github/` — sempre, sem exceção
