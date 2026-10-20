# Relatório — internacionalização da interface (pt-BR e en)

Branch `worktree-agent-ab2ce877abb916808`, a partir de `origin/dev` (813ea12). Sem push. Quatro commits: infraestrutura, textos, testes, docs do site (mais este relatório e o inventário do servidor).

## Decisão técnica

Módulo próprio mínimo (`apps/web/src/i18n/`), sem dependência nova, em vez de `react-i18next`.

- Por quê: o painel precisa de interpolação, plural, fallback e formatação por `Intl`. Isso são cerca de 250 linhas. `react-i18next` traria `i18next` + `html-parse-stringify` (~40 kB minificados) e um provider/instância para configurar, sem resolver nada que o módulo próprio não resolva. Também não há carregamento assíncrono de idiomas a gerenciar (os dicionários cabem no bundle).
- O que se perde: ICU completo (select/ordinal), extração automática de chaves, detector de idioma pronto. Plural usa `Intl.PluralRules` com sufixos `_one/_other/...`; marcação em texto usa `<Trans>` com tags simples `<b>..</b>`.
- Estrutura: `core.ts` (catálogo, detecção, store, `translate`), `react.tsx` (`useI18n`, `t`, `Trans`), `format.ts` (datas/números/ordenação), `api-error.ts` (`apiErrorText`), `keys.ts` (tipo `Key` gerado do pt-BR: chave errada não compila).
- Dicionários: `apps/web/src/locales/{pt-BR,en}/<namespace>.ts`, 23 namespaces, chaves planas `área.chave`. `import.meta.glob` descobre as pastas: **idioma novo = pasta nova**, sem mexer em componente (o seletor, a detecção e o fallback leem as pastas).
- Idioma: preferência em `localStorage` (`paas.locale`) > navegador (`pt*` -> pt-BR; idioma que tenha pasta -> ele; qualquer outro -> en). Seletor em: menu do usuário, login, setup, Configurações -> Aparência. Nada no servidor (sem endpoint novo, sem campo novo em preferências): a escolha vale por navegador.
- Trocar o idioma remonta a árvore (`App.tsx`, `Fragment key={locale}`): nada fica com texto antigo. O estado de rota é do `router`, que não remonta.
- Fuso: os helpers só trocam o locale do `Intl`; `timeZone` (UTC, fuso do projeto) continua o que cada tela já passava. Sem `timeZone`, vale o do navegador, como antes.
- Fallback: chave ausente no idioma -> pt-BR; ausente nos dois (ou chave que não é string, ou nome herdado como `constructor`/`__proto__`) -> texto vazio, sem lançar, com `console.warn` só em dev.
- Erros da API (`apiErrorText`): em pt-BR vale a mensagem do servidor (pode ter detalhes e é o que os testes consultam); em outro idioma usa `errors.code.<code>` quando existe, senão a mensagem do servidor em português.

## Glossário

Fica em `apps/web/src/locales/GLOSSARY.md` (tabela pt-BR/en + tom). Termos que os executores usaram sem linha na tabela (para revisar e promover): recusada/rejected, adiada/deferred, nota/score, blacklist/blocklist (en), reconhecer alerta/acknowledge, certificado próprio/custom certificate, caixa do projeto/project mailbox, kit de recuperação/recovery kit, armazenamento externo/external storage, cópia externa/external copy, retenção/retention, porta interna e do servidor/internal and server port, retrato de referência/baseline snapshot, aplicar de verdade/apply for real, fazer manualmente/run manually, chamado ao provedor/support ticket, nuvem cinza/gray cloud. Ficam iguais nos dois idiomas: guardrail(s), override, slug, healthcheck, PAT.

## Etapas

1. **Infraestrutura** (`a91ded9`): feito. Testes em `tests/i18n.test.tsx` (detecção, persistência, troca no seletor, fallback, plural, interpolação, `Trans`, erros da API, formatação com fuso).
2. **Migração dos textos** (`6997b24`): feito para todos os arquivos de `apps/web/src` (~2.000 literais; 1.993 no primeiro levantamento do detector). Mais de 2.000 chaves por idioma. O pt-BR renderizado é idêntico ao anterior, com exceções pequenas, todas em casos de borda: "1 porta em conflito" (antes "1 portas"), "1 núcleo", espaços que faltavam no guia do R2 e no Telegram.
3. **Mensagens do servidor**: nenhum contrato mudou e `apps/server` não foi tocado. `errors.code.*` cobre 57 códigos estáveis de mensagem fixa (`apps/web/src/locales/*/errors.ts`). O restante aparece em português (fallback) e está listado abaixo.
4. **Testes** (`6e45832`): 746 -> 937 testes no web, nenhum teste existente alterado (só `tests/setup.ts`, que fixa pt-BR e falha qualquer teste que dispare "chave ausente"). Novos: paridade (chaves, variáveis, tags, namespaces), detector de texto fixo em português (parser do TypeScript; exceções justificadas em `ALLOWED`), render de 20 páginas em pt-BR e en em três estados (rede fora, resposta vazia, 500) sem chave crua nem aviso de chave ausente, uso de chave literal inexistente. Cobertura do web (relatório do vitest/v8, colunas statements / branches / functions / lines): ver "Revisão" abaixo. O web não tem threshold configurado.
5. **Docs**: este relatório; `comoFuncionaSistema/global/frontend.json`; páginas `site/.../development/translating-the-interface.md` (en e pt-br, mesma slug, no sidebar); `pnpm docs:links` OK.

## Como adicionar um idioma (resumo)

Copiar `apps/web/src/locales/en/` para `apps/web/src/locales/es/`; traduzir os valores (mesmas chaves, variáveis e tags); ajustar `"language.name"` em `common.ts`; rodar `pnpm test -- tests/i18n-parity.test.ts`, `pnpm test:coverage`, typecheck e build; conferir no navegador. Passo a passo completo na página do site.

## O que ficou de fora: fase 2 do servidor

O servidor continua devolvendo português. Inventário completo (563 linhas: código, status, rota, se é dinâmica, mensagem, arquivo:linha): `comoFuncionaSistema/_i18n-servidor-fase2.tsv`. 175 códigos distintos, 297 mensagens sem `code` (campos `message/summary/hint/detail` em respostas 200, auditoria, alertas, notificações), 257 dinâmicas. Gerado por leitura de `apps/server/src`; mensagens de `packages/security`, `packages/mailer`, `packages/deploy` e `packages/core` não entraram, e uma mensagem montada de forma incomum pode ter escapado.

Pontos da interface que mostram texto do servidor tal qual (arquivo da UI — rota — origem):

- Setup/saúde: `HealthStep` `checks.*.message` (`GET /api/health/scan`, `services/system-info.ts:243-304`); `SetupTimezoneCard` `cannotApplyReason` (`timezone-service.ts:212`); `AdminStep`/`SetupDone` erros de `routes/setup.ts` e `setup-restart.ts`; `WelcomeStep` 503 `setup_token_missing`.
- Segurança/hardening: `SecurityStep` `report.lynisNote/profileNote`, `checks[].title/description/detail/remediation`, `plan.actions[]`, `job.title/log/steps/error`, comandos manuais (`packages/security/src/{scanner,profiles,checks,planner}.ts`); `SecurityPage` `lastResult.note` (`monitor-service.ts:259`), `r.label/detail` das blacklists (`packages/mailer/src/blacklist.ts`), `baseline.target`.
- Projetos/deploy: detalhes e avisos da detecção (`packages/deploy/src/detect.ts:98-169`); guardrails `title/evidence/fix` (`packages/deploy/src/rules.ts:279-325`); DNS `check.message` (`routes/domains.ts:90-125`); erro de HTTPS (`deploy-service.ts:517`); `job.error` e `step.name` do deploy (`deploy-service.ts:677,1145-1149,1188,1647`); status do container (Docker). Códigos tratados: `guardrail_blocked`, `missing_env`.
- Env/compose/portas: `publishBlocked` (`port-map.ts:149-153`), erros por linha do batch de portas (`port-map.ts:573-605,647`), `conflictWith` (`port-map.ts:263`).
- E-mail: `status.message` (`mail-service.ts:459`), `tls.syncError/hint/error` (`mail-service.ts:606,633,1718`), webmail `status.message/proxyError` (`routes/webmail.ts:45-57`), DNS `record.purpose/note`, `ptr.instructions/ticketText/diagnostic`, `suggestion` (`packages/mailer/src/dns-checklist.ts`), `credentials.notes` (`mailboxes.ts:73`), `test.detail`; `envLinkNameProblem` (`packages/core/src/mail.ts:318-330`, e a regex `/reservado/` em `EmailLinksModal` depende dele). Código tratado: `domain_receives_mail`.
- Envios/certificados/monitoramento: `QueueSection` (`mail-envios-service.ts:194,233,265`), `HistorySection` (`:345`), `ReputationSection` (`mail-reputation-service.ts:182,210`), `ScoreSection` (`packages/mailer/src/deliverability-score.ts`), certificados `lastError.message/detail` (`certificate-service.ts:244,262,324`), alertas `title/detail` (`certificate-service.ts:391-395`, `deploy-service.ts:1097`, `monitor-service.ts:287`), auditoria `detail` (vários serviços; `action` é código estável mostrado cru). Código tratado: `already_valid` (o servidor não manda `{host}` em `details`).
- Backups: `record.error/remoteDetail/warnings/steps[].label`, detecção de banco (`backup-detect.ts:122-230`), `message` do teste de senha (`backup-service.ts:1195`). **Palavra de confirmação da restauração**: o servidor só aceita a palavra em português (`backup-service.ts:2096-2105`); a UI em outro idioma aceita a palavra local mas envia a portuguesa. Código tratado: `no_check_file`. Também em `@paas/core`: `buildRecoveryKit` e `backupPasswordStrength().label` em português.
- Configurações: `ChangePasswordForm`/`TwoFactorPanel`/`ProfileSettings` (`routes/auth.ts:283-448`, `routes/settings.ts:92-123`, `services/two-factor.ts`), `step.detail` do onboarding (`services/onboarding.ts:75-105`), `unavailableReason` e histórico de notificações, `hostError`/`cannotApplyReason` do fuso, `blockers[]` do domínio do painel, mensagem do GitHub (`routes/integrations.ts:17`).
- Terminal: `sudo_elevation_failed` (424, `terminal-service.ts:99`, `SUDO_FAILURE_MESSAGES`).
- Códigos reutilizados com mensagens diferentes em rotas diferentes (`invalid_payload`, `invalid_port`, `invalid_domain`, `not_found`, `unauthorized`) e os de mensagem dinâmica (ex.: `weak_password`, `too_many_attempts`, `domain_in_use`) **não** entraram em `errors.code.*`: traduzi-los exige código mais específico ou parâmetros em `details` no servidor.

Texto em português mantido no código (todos em `ALLOWED` no teste, com motivo): valores de API (`"senha"`, `"sim"`), palavras de confirmação que o servidor compara ("painel", "recomeçar"), linha de log casada em `SecurityStep` ("operador não conseguiu entrar"), erro de programação do `useAuth`. Regexes que casam mensagens do servidor em português (`/setup token/i` em `lib/api.ts`, `/sudo/` em `terminal-info.ts`, `/reservado/`) também dependem do texto atual.

## Incertezas e riscos

- Inglês escrito por modelo, sem revisão humana. Convém uma leitura de estilo, sobretudo `hardening`, `mail` (guia de DNS) e `backups` (guia do R2).
- `apiErrorText` com `Error` que não é da API mostra `err.message` em pt-BR; em alguns arquivos mantive o comportamento antigo (texto fixo) com um helper local.
- Plurais: algumas telas usam duas chaves escolhidas por `n === 1` (em vez de `Intl.PluralRules`) porque o `Intl` do pt-BR trata 0 como singular e mudaria "0 entregues".
- Referência morta em `projects.folderBrowser.hint` (cita "Enviar do meu computador", opção que não existe mais), mantida idêntica ao pt-BR de antes.
- "Hostinger" segue em `DnsGuide` (pendência do relatório da fase 1).
- Bundle: os dicionários entram no bundle principal (eager); o aviso de chunk > 500 kB já existia.

## O que NÃO foi testado

- Navegador real: só abri `/login` (build de produção, `vite preview`) em Chromium: detectou `en-US` -> inglês, trocar para pt-BR pelo seletor mudou o texto, o `<html lang>` e gravou `paas.locale`. As demais páginas só foram renderizadas em jsdom (teste `i18n-render`, em três estados sem dados reais), nunca com um painel de verdade, nem com wizard/hardening/terminal em fluxo completo em inglês.
- Layout em inglês (textos mais longos ou mais curtos que os de pt-BR podem quebrar linhas/botões em telas estreitas).
- Persistência do idioma em outro navegador/dispositivo (por desenho, não existe).
- `docker build` da imagem não foi repetido (`pnpm docs:links`, build do site e `check:build` passaram: 30 páginas). Testes do servidor e dos outros pacotes não foram rodados (não foram tocados).
- Lint: o projeto não tem lint; o detector de texto fixo é heurístico (palavras funcionais, acentos, rótulos comuns) e não pega português sem acento e sem essas palavras.

## Revisão (correções após reprovação em segurança)

Cada item foi feito com o teste escrito antes e visto falhar (`tests/i18n-security.test.tsx`, 13 falhas antes; 0 depois).

1. **Injeção de marcação em `Trans`/`renderRich`**: as tags agora são lidas no texto da tradução sem valores; os `params` entram depois, só como texto, em cada trecho. `chat = "grupo</b> e <b>OUTRO"` e `"x</b><b>y"` geram um único `<strong>` com o texto literal; `<img onerror>`, `{b}`, `{{x}}` e `{chat}` nos valores ficam como texto (e não são reinterpolados). Testado em jsdom (React escapa o texto).
2. **Chaves hostis/ausentes**: `lookup` usa `Object.hasOwn` nos dois níveis e só aceita `typeof === "string"`. `translate`/`t` com `constructor`, `__proto__`, `toString`, `hasOwnProperty`, `undefined`, `null`, número, ou chave inexistente devolvem `""`, sem lançar, com aviso no console só em dev. (Mudança de comportamento: antes a chave inexistente devolvia a própria chave; a tela de teste continua reprovando qualquer aviso de chave ausente.)
3. `en/setup.ts` `done.restart.what`: "You can continue right away, with a new setup token".
4. **"Apagar e recomeçar" em inglês**: aceita "restart" (ou "recomeçar") e o corpo enviado ao servidor é sempre "recomeçar" (o servidor compara `confirm.trim().toLowerCase() === "recomeçar"`, `routes/setup-restart.ts:52`). A palavra aparece em `<code>` nos dois idiomas; o pt-BR segue exigindo "recomeçar" e o rótulo continua "Digite recomeçar para confirmar".
5. **Cobertura (colunas do vitest)**: após esta revisão, medida na seção "Verificação" abaixo. Antes da correção o web tinha instruções 91,81 / ramos 86,05 / funções 90,07 / linhas 93,14, contra 91,44 / 85,88 / 89,57 / 92,73 da dev (rótulos que eu tinha trocado no relatório anterior).
6. **`i18n-render`**: o captor agora registra a quebra e o teste falha, exceto nas 10 páginas que quebram com resposta `200 {}` (`EMPTY_BODY_CRASHES`: Alerts, Audit, Backups, Certificates, Dashboard, Mail, Notifications, PanelDomain, Security, Timezone). A causa é anterior à i18n (ex.: `data.projects.length` em `DashboardPage` já existia na dev): as telas confiam que a API sempre manda os campos do contrato. Não corrigi (fora do escopo, e o servidor real manda os campos); está marcado no teste com a justificativa.
7. `Intl.PluralRules` em cache por idioma; plural em `mail.page.domains.meta` (en: mailbox/mailboxes; pt-BR idêntico ao anterior); "apagar" no GLOSSARY; exceções do detector de texto fixo agora por **linha** (`line`), não por arquivo — "painel" em `backup-ui.tsx` só vale na linha da palavra de confirmação.
8. **Bundle**: decisão — NÃO carregar o `en` sob demanda agora. Custo medido pelo revisor: +74,6 kB gzip no JS inicial com os dois idiomas (o `en` é cerca de metade). Para adiar o `en` seria preciso: carregar o dicionário antes do primeiro render (`await` em `main.tsx`) e antes de cada troca, `setLocale` passar a ser assíncrona (hoje os testes e o seletor dependem dela síncrona), manter `catalog` completo para os testes de paridade e evitar flash de chaves. Risco médio para ~37 kB gzip num painel autohospedado; fica como melhoria futura (`import.meta.glob` sem `eager` para idiomas ≠ pt-BR).
9. Página do site ajustada: não promete mais "nunca mostra chave crua" (ver texto sobre chave ausente nos dois idiomas) e passa a dizer que valores nunca viram marcação.

### Verificação após a revisão

Rodado de verdade: `pnpm typecheck` (todos os pacotes, 0 erros), `pnpm --filter @paas/web test:coverage` (60 arquivos, 955 testes), build do web, build do site (30 páginas) + `check:build`, `pnpm docs:links`. Cobertura do web (instruções / ramos / funções / linhas): **91,82 / 85,99 / 90,09 / 93,20**, contra 91,44 / 85,88 / 89,57 / 92,73 da dev: igual ou maior nas quatro. Não testado de novo: navegador real (a revisão tocou `Trans`, `core` e `SetupDone`; foram cobertos por jsdom), `docker build`, testes do servidor.
