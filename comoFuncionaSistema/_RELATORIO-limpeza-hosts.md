# Relatório — limpeza de domínios e IPs reais

Este relatório não cita os valores removidos de propósito: repeti-los aqui os traria de volta ao repositório. Eles são descritos pelo papel que tinham.

## O que foi trocado

| Arquivo | O que havia | Valor de exemplo agora |
|---|---|---|
| apps/server/tests/deploy-domains.test.ts | subdomínios de teste da zona da empresa (o do projeto principal, três curtos a/b/c e o de "carteira"), mais uma grafia com maiúsculas | `loja.example.com`, `a/b/c.example.com`, `carteira.example.com`, `Loja.EXAMPLE.com` (mantém o teste de minúsculas) |
| apps/server/tests/routes-domains-auto.test.ts | subdomínio de teste antigo do projeto | `loja.example.com` |
| apps/server/tests/routes-projects.test.ts | idem | `loja.example.com` |
| apps/web/tests/project-detail-page.test.tsx | subdomínio antigo, o domínio raiz da empresa como domínio de e-mail e a caixa do projeto nesse domínio | `loja.example.com`, `example.com`, `loja@example.com` |
| apps/web/tests/project-sections.test.tsx | subdomínio antigo | `loja.example.com` |
| packages/deploy/tests/caddy-render.test.ts | subdomínio antigo | `loja.example.com` |
| apps/server/tests/system-info.test.ts, routes-health.test.ts, apps/web/tests/health-step.test.tsx | IP da VPS antiga (e o broadcast da mesma rede /24) | `203.0.113.67` (e `.255`), mesma relação entre eles |
| comoFuncionaSistema/_ESTADO-DA-SESSAO.md | menção ao domínio raiz da empresa | texto genérico |
| comoFuncionaSistema/_RELATORIO-trilha-repositorio-fase1.md | um domínio de teste antigo citado por extenso | "domínio de teste antigo" |

Nenhuma expectativa de teste mudou, só os valores literais.

## Verificação permanente

- `scripts/check-no-real-hosts.mjs` reprova: qualquer nome sob a zona da empresa (subdomínio, curinga, sublinhado), e-mail dessa zona que não seja o contato oficial, e IPv4 público fora das exceções. Pega IP no fim de frase, depois de reticências e embutido em nomes sslip.io/nip.io (com ponto ou hífen).
- Exceções de IP: loopback, privadas, link-local, CGNAT, faixas de documentação, DNS públicos (1.1.1.1, 8.8.8.8, 9.9.9.9), IPs fictícios curtos dos testes e as faixas da Cloudflare, comparadas por CIDR com as mesmas de `apps/server/src/routes/domains.ts`.
- Sem `.git` (tarball, ZIP do GitHub, container) o script percorre a árvore ignorando node_modules, dist, coverage e .git. Com `CI=true` a falta do git é erro.
- `packages/core/tests/no-real-hosts.test.ts` cobre cada brecha (positivos e negativos) e roda a varredura em `test:coverage`, então o CI atual já a executa. Os valores reprovados são montados no teste, sem literal. Para uma etapa própria no CI: `node scripts/check-no-real-hosts.mjs` (não alterei `.github/workflows`).
- E-mails pessoais comuns (gmail etc.) ficaram de fora: os testes de envio os usam como destinatários de exemplo, o que geraria falso positivo.

## O que ficou, e por quê

- Contato oficial da empresa (README.md, README.pt-BR.md, SECURITY.md, docs/community/pt-BR/SECURITY.md) e link institucional da empresa (READMEs e páginas de instalação do site): marca em texto institucional, de propósito.
- Endpoints de exemplo de armazenamento S3/R2 com identificadores genéricos: sem conta real.
- DNS públicos, faixas da Cloudflare e IPs fictícios de teste: configuração legítima, na lista de exceções.
- Não encontrei: nomes de hospedagem anterior, tokens de bucket, e-mails pessoais.
- Não toquei em apps/web/src, docs do site nem READMEs (escopo de outros executores).

## Histórico do git (recomendação, nada foi feito)

- Os valores antigos continuam em todos os commits alcançáveis por `main`, `dev` e demais ramos, e vão continuar mesmo depois que este ramo for mesclado.
- Apagar de verdade exige reescrever o histórico com `git filter-repo` e push forçado em TODOS os ramos, o que invalida clones e PRs abertos.
- Mesmo assim, as refs de PR do GitHub (`refs/pull/*`) e os forks não são reescritos por push forçado; só o suporte do GitHub consegue limpá-los. Quem já clonou ou fez fork guarda uma cópia.
- Este ramo foi condensado em um único commit antes do merge: versões intermediárias do relatório e do teste chegaram a conter os valores antigos, e mesclá-las deixaria uma cópia extra no histórico público do `dev`. O commit final não repete os valores (o relatório os descreve só pelo papel).
- Recomendação honesta: tratar os valores como já públicos. A medida efetiva é trocar o IP da VPS ou fechar o acesso por firewall (só portas necessárias, SSH por chave/VPN); reescrever histórico é opcional e só reduz a exposição, não a elimina.

## Testes

Typecheck de todos os pacotes e `pnpm -r --workspace-concurrency=1 --no-bail run test:coverage` (server com `--maxWorkers=2`), rodados depois de tudo commitado; resultado registrado na resposta do executor.
