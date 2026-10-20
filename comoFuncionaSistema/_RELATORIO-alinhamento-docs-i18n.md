# Relatório — alinhamento da documentação com a interface bilíngue

Branch do worktree `worktree-agent-ad9acf41c2f63a1d4`, a partir de `origin/dev` (813ea12 mais o merge de `origin/dev` que trouxe a interface em inglês). Sem push. Escopo: `site/` (conteúdo em `site/src/content/docs/{en,pt-br}/` e `site/README.md`). Nada em `apps/`, `packages/` nem nos README/CONTRIBUTING da raiz.

## O que mudou, por categoria

**Notas de idioma (item a)**
- A nota "a interface está sendo traduzida" foi trocada, nas 11 páginas e no `index.md` (en e pt-br), por um aviso verdadeiro: a interface existe em inglês e português; os rótulos citados na página estão no idioma da página; algumas mensagens vindas do servidor continuam em português nos dois idiomas. A lista de categorias muda por página (por exemplo, a página de restauração fala de registros de backup e avisos do servidor de e-mail). A lista completa, no guia completo: resultados das verificações de saúde e de segurança, mensagens do deploy e da checagem de DNS, status do servidor de e-mail e observações do checklist de DNS, erros de certificado, alertas e detalhes da auditoria, registros de backup, detalhes dos passos do roteiro (onboarding) e muitas mensagens de erro. O texto do kit de recuperação não entra: o navegador o monta (`buildRecoveryKit`, `packages/core/src/backups.ts`) e ele é fixo em português. Fonte: `comoFuncionaSistema/_RELATORIO-i18n-interface.md` e `_i18n-servidor-fase2.tsv`.
- Textos do servidor citados nas páginas ficam em português e a frase diz que vêm do servidor: "ainda não aponta", "acesso pelo IP ainda ativo", "Opcional: trocar o nome reverso", "Senha certa", "Teste de notificação", "Por que falhou", aviso "O servidor de e-mail ainda não existe nesta VPS…", linhas de log da migração de redes.

**Palavras de confirmação (item b)**
- Restauração do painel e do e-mail (`restore-new-server.md` passos 5 e 8, e `features.md`): `panel`/`email` com a interface em inglês, `painel`/`e-mail` com a interface em português. Projeto continua com o nome do projeto.
- "Apagar e recomeçar" (`recover-access.md`): `restart` (en) ou `recomeçar`; a tela aceita `recomeçar` nos dois idiomas (lido em `SetupDone.tsx`). O botão agora é citado como **Delete and start over** / **Apagar e recomeçar**.

**Rótulos (item c)**
- Páginas em inglês: todos os rótulos com "português (tradução)" viraram o rótulo real em inglês, lido de `apps/web/src/locales/en` (algumas centenas de trechos; parte com script que consulta os dicionários, o resto à mão; os que têm vários rótulos em inglês para o mesmo texto em português foram escolhidos pela tela descrita). Menus com o nome do caminho: Settings → Backups, Sending → Reputation, Security → Scan and apply protections etc.
- Corrigidos rótulos inventados ou que não existem: "Update the reference snapshot" → **Update baseline snapshot**; "Envios" → **Sending**; "Nota de entregabilidade" → aba **Score** / **Nota** (a aba não tem esse nome); "Segurança → Proteções" → **Security → Scan and apply protections** / **Segurança → Verificar e aplicar proteções** (não existe aba "Proteções"); cartão "Criptografia" → **External copy encryption** / **Criptografia da cópia externa**; "Entendo os riscos" → texto completo do rótulo; "VPS (mais rápido)" → **da VPS (mais rápido)** / **from the VPS (faster)**; "Usar envio.… (recomendado)" → **Use envio.example.com (recommended)**; "Token inválido" agora cita a mensagem real (**Invalid token. Check the value the installer printed in the terminal.** / **Token inválido. Confira o valor exibido pelo instalador no terminal.**).
- Páginas pt-br: todos os rótulos conferidos contra `locales/pt-BR`; só os citados acima estavam errados. "Válido/Valid" e "Sim/Yes" agora com a capitalização da tela.
- Terminologia em inglês alinhada à interface: "two-step verification" → "two-factor authentication"; "log in/login" → "sign in/sign-in" (SSH incluído, exceto "password login" como substantivo); "Machine health" → **Server health**.
- Saídas do instalador e dos scripts (`senha`, `segundo-plano`, `continuar`, `sim`, `resetar`, `desligar`) ficam em português: não são interface web.

**Glossário e regras do `site/README.md` (item d)**
- Glossário alinhado a `apps/web/src/locales/GLOSSARY.md` (sign in/sign-in, two-factor authentication, recovery code, audit log, Sending/queue/reputation, baseline snapshot, setup wizard) e uma nota sobre onde o guia e a interface ainda divergem.
- Regras editoriais reescritas: rótulo na língua da página, copiado do dicionário; sem tradução entre parênteses; regra para mensagens do servidor; nota padrão "Interface language"; palavras de confirmação lidas do dicionário; instalador continua em português; como citar rótulos ao adicionar um idioma. A regra antiga "rótulo em português primeiro" foi removida.

**Seletor de idioma e detecção (item e)**
- Parágrafo "Language of the interface" / "Idioma da interface" em `getting-started/installation.md` (Passo 8, primeiro acesso) e "Language" / "Idioma" em `getting-started/complete-guide.md` (3.1), com âncora `idioma-da-interface` nos dois idiomas; as notas das outras páginas apontam para ele. Descreve: lista de idiomas do navegador, primeiro que o painel tem (`pt*` → pt-BR, `en` → en, nenhum → en), seletor no assistente, no login, no menu do usuário e em Configurações → Aparência, escolha só no navegador. Redação baseada em `detectLocale` (percorre `navigator.languages`), um pouco mais precisa que "pt* → pt-BR, resto → en".

**Página "Translating the interface" (item f)**
- Ganhou `description` e `sidebar.label` (en e pt-br). A frase sobre chave ausente agora diz que o teste de paridade impede chave faltando e o typecheck recusa chave escrita errada. Passo de verificação: "nenhuma chave crua e nenhum rótulo ou botão vazio". Detecção e seletores corrigidos (também no assistente), remissão ao `site/README.md` e à regra de rótulos nos guias.

**404 e home (item g)**
- Home (en e pt-br): o parágrafo "sendo traduzida" virou a descrição da interface bilíngue, do seletor e das mensagens do servidor, com link para "Translating the interface". O `404.md` já é bilíngue e não falava da interface: sem alteração.

## Verificação

`pnpm install --frozen-lockfile`; `pnpm --filter site build` (32 páginas); `pnpm --filter site check:build` (OK); `pnpm docs:links` (53 arquivos, 0 quebrados). Paridade en/pt-br por script próprio (não versionado): mesmos arquivos, mesma estrutura de títulos, mesmo número de blocos de código, mesmas âncoras explícitas e mesmos links; as únicas diferenças são as já conhecidas (âncoras `<a id>` que no pt-br saem do título, links para a versão em cada idioma do README/CONTRIBUTING/SECURITY, `index.md` sem `sidebar.label`).

## Rótulos divergentes encontrados na interface (para correção futura)

1. **Mesmo texto em português, rótulos diferentes em inglês:** "Verificar DNS" é **Check DNS** em `panelDomain.domain.verify` e **Verify DNS** em `projects.domains.verify`/`projects.new.domain.verifyDns`; "Verificar agora" é **Verify now** (`mail.dns.verifyNow`), **Scan now** (`security.monitor.runNow`) e **Check now** (`security.blacklist.check`); "Aplicar na VPS" é **Apply to VPS** (`setup.timezone.apply`) e **Apply to the VPS** (`timezone.apply`). Os guias seguem a tela descrita.
2. **Verificação em duas etapas:** em inglês os títulos dizem "Two-factor authentication", mas `errors.code.already_enabled`, `errors.code.not_enabled`, `shell.userMenu.twoFactor` e `shell.twoFactorNudge.text` dizem "Two-step verification"; em português a interface diz "Verificação em duas etapas" e o `GLOSSARY.md` manda "autenticação em dois fatores".
3. **Passo "Proteções da VPS" do roteiro:** o texto em português manda "Abra Segurança → Proteções" e o botão se chama "Abrir Proteções" (en: "Open Security → Hardening", "Open Hardening"), mas não existe aba Proteções nem Hardening; o caminho real é Segurança → botão "Verificar e aplicar proteções". Chaves `onboarding.steps.hardening.howTo.1` e `.action`.
4. **Cartão da criptografia dos backups:** o título é "Criptografia da cópia externa" (en: "External copy encryption"), mas `backups.page.reminder` e `onboarding.steps.backups.howTo.7` dizem "cartão Criptografia" / "Encryption card".
5. **Sugestão de subdomínio de envio:** o botão mostra `envio.<domínio>` também em inglês (`mail.existing.useSuggested` + `suggestedDomain` do `@paas/core`, prefixo em português).
6. **Nota de entregabilidade:** a aba é "Nota"/"Score", mas o título do conteúdo é "Prontidão para a caixa de entrada"/"Inbox readiness" (`envios.score.ready.title`).
7. **Palavra de confirmação da restauração:** o servidor só aceita a palavra em português (`backup-service.ts` `confirmText`); a interface em inglês pede `panel`/`email` e envia a portuguesa (indicado no relatório da i18n). Se o outro executor mudar isso, atualizar `restore-new-server.md` (passos 5 e 8) e `features.md`.
8. `projects.folderBrowser.hint` ainda cita "Enviar do meu computador" (já registrado no relatório da i18n).
9. **Botões do passo de backups do roteiro:** `onboarding.steps.backups.howTo.7` diz "Suggest a strong phrase" e "I saved the password somewhere safe", mas os botões reais são "Suggest a strong passphrase" e "I've stored the password somewhere safe".

## O que NÃO consegui confirmar

- Não abri o painel em navegador: os rótulos foram lidos dos dicionários `locales/{en,pt-BR}`, não conferidos tela a tela. Onde o mesmo texto em português tem mais de um rótulo em inglês, escolhi pelo contexto da página (lista acima, item 1); um erro de contexto é possível.
- O botão **Start**/**Começar** do Telegram é do aplicativo do Telegram e depende do idioma dele; a página cita "Start".
- Que o Roundcube (webmail) abre em português por padrão (`packages/mailer/src/webmail.ts` define `pt_BR`) e não segue o idioma do painel: lido no código, não testado.
- A afirmação de que as páginas "site em configuração" e "temporariamente indisponível" são servidas em português: lida em `packages/deploy/src/caddy.ts`, não testada.
- A lista de categorias de mensagem do servidor vem do inventário da fase 2 (gerado por leitura de `apps/server/src`); mensagens de `packages/*` podem ter escapado.
- O teste manual do fluxo de restauração e do "Apagar e recomeçar" em inglês não foi feito.
- Revisão por falante nativo de inglês continua recomendada.

## Não testado

Aparência do site em navegador; seletor de idioma e detecção no painel real; workflow do GitHub Pages.
