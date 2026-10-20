# Relatório — revisão editorial da documentação (site/)

Branch do worktree `worktree-agent-a58394ed636dbd009`, a partir de `origin/dev` (813ea12). Sem push. Escopo: `site/` (conteúdo em `site/src/content/docs/{en,pt-br}/`, configuração, README do site). Nada em `apps/`, `packages/` nem nos README/CONTRIBUTING/SECURITY/CODE_OF_CONDUCT/ROADMAP/CHANGELOG da raiz.

## O que mudou, por categoria

**Pedido do coordenador (resolvido primeiro)**
- Passo 6 da instalação e do guia completo: o comando agora é `git clone --branch main …` (sem `git checkout main`), e a dica deixou de dizer que o clone "começa na `dev`".
- "Token de uso único" em `reference/security.md` (en e pt-br): o texto agora diz que o setup token deixa de valer, e o arquivo é apagado, quando o setup termina. Não havia outra ocorrência (conferido por busca).

**Veracidade (código e scripts conferidos; en e pt-br)**
- `production.md`: o token fica guardado até o wizard terminar (antes dizia que ficava para sempre); o `reset-setup.sh` **gera um token novo** (a página dizia que o token não era tocado); a imagem do helper é fixada por digest (lote 5) e a primeira instalação precisa de acesso ao registro; a variável do contêiner é ignorada quando já existe administrador.
- `host-bridge.md`: allowlist cobre as fases `00..07` (dizia `00..06`) e a flag `--no-tunnel`; nota sobre a imagem fixada por digest.
- Guardrails (`security.md`, `features.md`): o texto "6 regras" estava defasado. Agora descreve a lista do que se permite sobre o compose resolvido, as regras duras sem override e o isolamento (redes separadas, `trustProxy` só do Caddy, imagens por digest, git sem hooks). Afirmações com "todas/nunca" suavizadas (validação "em todas as rotas", auditoria "de todas as ações").
- `features.md`: bloqueio do webmail corrigido (10 logins errados do mesmo endereço bloqueiam esse endereço por 1 hora, conforme `comoFuncionaSistema/email/webmail.json`); nota do lote 6 (o `.env` do repositório nunca é sobrescrito; as variáveis do painel vão para `paas.env`), também no guia completo (9.3).
- `operations.md`: layout da pasta do projeto (`src/`, `repo.git`, `paas.env`) no lugar de "o docker-compose.yml que o painel gera".
- Afirmações sobre provedores sem comprovação saíram: "Contabo abre 80/443", "Contabo usa Berlim", lista de provedores que bloqueiam a 25 no guia completo, "Roundcube ≈ 265 MB".
- Rótulos da interface conferidos por script contra `apps/web/src` (cerca de 60 rótulos); todos existem, exceto os que são texto dinâmico.

**Inglês (naturalidade e consistência)**
- A tradução já estava boa; o trabalho foi de acabamento: remoção de notas de tradutor ("`your-user@your-computer` means…", "`PORTA` means port"), resumos curtos no lugar dos parágrafos longos que descreviam a saída em português do instalador, "paas" → "TWS Panel", "cert" → "certificate", "timezone" → "time zone", títulos sem travessão e em sentence case, emojis tirados dos títulos, cabeçalho "Caddy não emite certificado ("DNS não propagado")" simplificado (a frase não é texto da interface).
- Padrão de rótulos mantido: "rótulo em português (tradução em inglês)". Nenhum rótulo em inglês inventado. Nota padrão no início das páginas que citam a interface (10 páginas) nos dois idiomas, dizendo que a interface está sendo traduzida.

**Paridade en/pt-br**
- Script próprio (não versionado) compara títulos, âncoras, blocos de código, links e códigos inline: as diferenças restantes são só placeholders traduzidos (`YOUR_IP`/`SEU_IP`), comentários de código, links para a versão do README/CONTRIBUTING/SECURITY em cada idioma e âncoras explícitas `<a id>` que no pt-br já saem do título.
- pt-br: o domínio de exemplo `exemplo.com.br` virou `example.com` (nada de domínio que possa ser real); texto "Problemas comuns" virou "Solução de problemas" (título da página e da home); acentuação conferida por busca de palavras sem acento (nenhuma falha).
- A home em pt-br ganhou o link do roadmap que só existia em inglês.

**Qualidade de uso do site**
- Todas as páginas têm `description` e rótulo curto de menu (`sidebar.label`); títulos longos ("lote 5", "host bridge — como…") viraram descritivos, sem jargão interno.
- Menu: nova página `guides/restore-new-server` depois do guia de produção.
- Home: chamada "Install the panel" (não promete "minutos"), seção "What you need", link para a restauração.
- `404.md` bilíngue (GitHub Pages serve um único `404.html`): mostra o bloco do idioma da URL, ou o do navegador.
- `site/README.md` novo: comandos, estrutura, como adicionar um idioma (pasta + entrada em `locales`, rótulos do menu e o redirecionamento da raiz), regras editoriais e glossário.

## Glossário adotado (en ↔ pt-br)

panel/painel; project/projeto; deploy (substantivo e verbo)/deploy; domain/domínio; certificate/certificado; backup (substantivo), to back up/fazer backup; restore/restaurar ("recover" só para acesso); mail server/servidor de e-mail; mailbox/caixa; email (sem hífen)/e-mail; webmail; VPS (a máquina) × host (em contraste com container); setup token; wizard/wizard-assistente; hardening; two-step verification/verificação em duas etapas; recovery codes/kit; external storage/armazenamento externo; time zone/fuso horário; log in (verbo), login (substantivo). Tabela completa em `site/README.md`.

## Cobertura do guia "Restaurar de outro servidor" (item 5)

Antes: um parágrafo de duas linhas no fim da Etapa 10 do guia completo e um item em Funcionalidades. Criada a página `guides/restore-new-server` (en e pt-br) com pré-requisitos, tabela do que volta e do que não volta, 8 passos executáveis, conferências finais e falhas. Lacunas encontradas e tratadas na página:
1. **O kit de recuperação não traz as chaves do armazenamento** (só endpoint e bucket); sem elas é preciso criar um token novo no R2. Antes o guia mandava usar "os dados do kit".
2. **Armadilha do domínio do painel:** `panel-domain.json` volta com o backup do painel; se o painel antigo estava com o acesso pelo IP desativado, o novo só responde no domínio, que ainda aponta para o IP antigo, e o operador fica sem entrar (saída: apontar o DNS antes, ou `reativar-acesso-ip.sh`). Lido em `panel-restore.ts` e `panel-domain.ts`.
3. **Dois servidores gravando no mesmo bucket** (as configurações de backup voltam): o passo 2 manda parar o painel antigo.
4. **Registro SPF** carrega o IP antigo; o PTR e a porta 25 também dependem da VPS nova.
5. Ordem (painel → projetos → e-mail), a senha usada quando aquele backup foi feito, a caixa "Publicar do GitHub antes de restaurar", a espera de até 45 min e o que fica de fora (itens não marcados na aba Backups, fora de volumes; branch atual do GitHub, não a da data do backup).

Correções da segunda rodada (revisor reprovou a primeira):
6. **Perda de dados:** o passo 2 agora manda fazer **Fazer backup agora** no painel antigo (Painel, cada projeto, E-mail), esperar "cópia externa conferida" e anotar a data, só então rodar `docker compose stop`; avisa que o que for gravado ou recebido depois não migra até o DNS mudar.
7. **Chaves do armazenamento voltam as antigas** depois do passo 5 (`backups.json` e a chave vêm no backup do painel): aviso de reinformar as chaves em Armazenamento externo → Editar, e, em caso de invasão, revogar o token antigo e trocar as senhas depois.
8. **Escolha da data e agenda:** a data é a do último backup da VPS antiga; os passos 3 a 8 sem pausa; não clicar em "Fazer backup agora" no painel novo antes do passo 5 (o backup automático vem ligado, pode subir um painel vazio para `_painel/` e a retenção de 5 cópias apagar a mais antiga); nas conferências finais, ver a aba Backups de cada projeto (o painel desliga o automático de projeto sem containers, `disableEmptyProject`).
9. **Projetos que não vêm do GitHub não são restaurados por este fluxo** (ver "Tarefas de código descobertas", item 1): a linha da tabela deixou de prometer o código desses projetos e a página descreve o caminho manual (extrair `codigo/codigo.tar` do `.7z` na pasta de origem do projeto, de forma diferente em upload e em pasta do servidor, ajustar o dono para 10001, publicar, restaurar os dados).
10. Detalhes de interface conferidos no código: "Tentar emitir agora" fica na página Certificados; aviso "abra a página E-mail e clique em Iniciar" com o botão **Iniciar servidor**; cartão "Criptografia da cópia externa"; o baseline fica em Segurança → "Atualizar retrato de referência".

Outras páginas corrigidas na segunda rodada: `troubleshooting` e `production` (sem modo DNS-01 no painel; botões reais **Verificar agora** e **Verificar DNS**), `features` (webmail: 10 logins errados do mesmo IP em 10 minutos bloqueiam esse IP, só no webmail), `security` (privilegiado, `docker.sock` e bind fora da pasta bloqueiam mas aceitam override auditado; só as regras de isolamento do painel, `panel-image`, `network-hijack`, `reserved-name` e `panel-resource`, não têm override), `installation` e `complete-guide` (etapas "Boas-vindas e token" e "Conta de administrador", como em `setup-state.ts`), trechos em inglês reescritos (instrução ao autor em `security`, "#1 cause", "send low, growing volume", "the commit version", contrações). No site: o 404 escolhe o idioma por `^/tws-panel/(en|pt-br)(/|$)` e ajusta `lang` e título; o `site/README.md` corrige a chave de `translations` (valor de `lang`, ex.: `'pt-BR'`) e lista o bloco do 404 ao adicionar idioma.

## O que NÃO consegui confirmar contra o código

- Se o baseline de monitoramento volta no backup do painel e gera alertas na VPS nova (a página manda recriá-lo "se houver diferenças").
- O caminho manual para projetos que não vêm do GitHub foi montado pela leitura do código e não foi executado: `tar.create(dirname(src), basename(src))` (o tar traz `src/` em upload e a pasta de origem em existing), `ingestUpload` apaga `.paas/<id>/src` antes de copiar a origem, `projectSrcDir` (existing = `project.source`), uid 10001 do Dockerfile, bind mount só de `PAAS_PROJECTS_DIR` no `docker-compose.yml`. Não confirmei que o painel recusa uma origem fora da pasta de projetos (ele só não a enxerga) nem que o `chown 10001` basta em todos os casos de permissão.
- Que o fuso da VPS nova segue o que o painel restaurado espera (a página manda conferir).
- Texto exato "Conexão testada e salva" e demais mensagens dinâmicas da interface (conferi os rótulos fixos).
- Afirmações sobre provedores que ficaram: PTR (Contabo/Hetzner/Vultr, existe em `dns-checklist.ts`), "Hetzner, AWS, OCI bloqueiam a 25" (troubleshooting e produção), e o link "Fale com a TWS".
- Não executei nenhum script de shell nem os comandos de VPS; a leitura foi do código.

## Tarefas de código descobertas

1. **Bug: `restoreProject` republica ANTES de devolver o código** (`backup-service.ts` ~2221). Em projetos `upload`/`existing` o caminho do código-fonte é da VPS antiga e a republicação falha. Solução: restaurar o item `source` (`codigo/codigo.tar`) antes de chamar o redeploy, quando o modo não for `git`.
2. **Pausar a agenda de backup durante e logo depois da restauração do painel.** O `backups.json` volta com o `lastSlot` antigo e o agendador (60 s) pode disparar backups de projetos ainda sem containers; o resultado é `NothingToBackup` e o painel desliga o backup automático deles (`disableEmptyProject`). Além disso, o backup automático do painel vem ligado de fábrica e, depois de definida a senha, uma VPS nova pode enviar um painel vazio para `_painel/`, e a retenção apagar o backup bom.
3. **Restaurar o painel mantendo as chaves do armazenamento atuais** (ou, no mínimo, avisar na tela): hoje as chaves voltam as antigas e o download de projetos e e-mail falha quando o token foi trocado ou revogado.
4. **Kit de recuperação sem as chaves de acesso** (só endpoint e bucket): incluir as chaves ou dizer na tela que elas precisam ser guardadas à parte.
5. **Aviso ou solução na tela para o acesso pelo IP desativado ao restaurar** (`panel-domain.json` volta com `ipAccessDisabled`).
6. **`docker-compose.yml` não repassa `ALLOWED_ORIGINS`** ao painel (ver sugestão abaixo): quem usa outro proxy e recebe `403 forbidden_origin` não consegue configurar.

## Ajuste necessário no merge com a branch da interface (página "Translating the interface")

A branch da interface cria `development/` "Translating the interface" (não toquei nela). Ao juntar:
- A página nova precisa de `description` e `sidebar.label` no frontmatter (regra do `site/README.md`) e do mesmo título em sentence case.
- Ela diz que a interface em inglês já existe; as minhas páginas dizem "está sendo traduzida". Como o inglês chega no mesmo PR, as notas devem ser removidas ou trocadas pelos rótulos reais:
  - a nota `> [!NOTE]` "The panel interface is being translated" / "A interface do painel está sendo traduzida para o inglês" em `getting-started/installation`, `getting-started/security-wizard`, `getting-started/complete-guide`, `guides/features`, `guides/production`, `guides/troubleshooting`, `guides/recover-access`, `guides/network-migration`, `guides/restore-new-server`, `reference/security`, `reference/host-bridge` (en e pt-br);
  - a frase da página inicial (`index.md`, en e pt-br) que diz que a interface está sendo traduzida e por ora aparece em português;
  - em `site/README.md`, a regra de rótulos da interface ("rótulo em português com a tradução entre parênteses") e a convenção "Interface labels";
  - os textos "(tradução em inglês)" entre parênteses nos rótulos, que passam a ser o rótulo real em inglês.

Itens adicionais do merge, vindos da branch da interface (`worktree-agent-ab2ce877abb916808`; dicionários em `apps/web/src/locales/en/`, relatório `_RELATORIO-i18n-interface.md`). Esta lista é só o registro; o alinhamento será feito numa tarefa seguinte, depois que as duas branches forem mescladas:
1. **Mensagens do servidor continuam em português** (fase 2 pendente, 563 mensagens). Portanto remover todas as notas "interface sendo traduzida" seria errado: nas 11 páginas e no `index.md` acima a nota deve virar "as mensagens que vêm do servidor ainda aparecem em português". Os textos citados nos guias que vêm do servidor seguem em português, por exemplo "cópia externa conferida", "Conexão testada e salva", "Não cadastrado aqui: restaure o painel primeiro" e o aviso "abra a página E-mail e clique em Iniciar" (`restore-new-server.md`), além dos textos de erro citados em `troubleshooting.md`.
2. **Palavras de confirmação:** com a interface em inglês a tela de restauração pede `panel` e `email` (`restore.confirmWord.*`), enquanto os guias mandam digitar `painel` e `e-mail`. Ajustar `restore-new-server.md` (passos 5 e 8, en e pt-br) e `features.md` (trecho da restauração, en e pt-br), dizendo que a palavra depende do idioma da interface.
3. **Rótulos entre parênteses:** conferir um a um contra `apps/web/src/locales/en/`. Exemplos já conhecidos: o guia diz "Update the reference snapshot" e a tela diz "Update baseline snapshot" (`restore-new-server.md`, Conferências finais); menu "Envios" vira "Sending" e "Envios → Reputação" vira "Sending → Reputation" (`troubleshooting.md`, `features.md`). Valem as mesmas verificações para todas as traduções entre parênteses nas páginas de `getting-started/`, `guides/` e `reference/`. Alinhar também o glossário de `site/README.md` com `apps/web/src/locales/GLOSSARY.md` (a interface usa "sign in"; o glossário do site usa "log in") e o texto das páginas.
4. **Seletor de idioma** (menu do usuário, tela de login, setup e Configurações → Aparência; a escolha fica salva no navegador): documentar pelo menos em `getting-started/installation.md` e `getting-started/complete-guide.md` (en e pt-br).

## Sugestões que dependem do Kelvin

1. **`ALLOWED_ORIGINS` não é repassada pelo `docker-compose.yml`** (nem `docker-compose.dev.yml`, não verifiquei): quem usa o painel atrás de outro proxy e recebe `403 forbidden_origin` não tem como configurar. Decidir se passa a repassar; só então documentar a variável em "Solução de problemas".
2. Ver "Tarefas de código descobertas", itens 4 e 5 (chaves no kit; aviso do acesso pelo IP desativado).
4. Os guias citam `tws.tec.br` ("Fale com a TWS") e nomes de provedores: manter ou tirar.
5. Os links para `blob/main/...` só funcionam depois que a `main` tiver esses arquivos.
6. Quando a interface em inglês sair, trocar o padrão "rótulo em português (tradução)" pelos rótulos reais e remover a nota das páginas.
7. Revisão humana de um falante nativo de inglês ainda é recomendada; esta revisão foi feita por modelo.

## Verificação

`pnpm install --frozen-lockfile`, `pnpm --filter site build` (30 páginas), `pnpm --filter site check:build` (OK), `pnpm docs:links` (50 arquivos, 0 quebrados), varredura do HTML gerado (1778 `href` internos, âncoras incluídas, 0 problemas). **Não testado:** aparência do site em navegador (inclusive o script do 404), o workflow do GitHub Pages, e a leitura integral do pt-br fora da página de instalação (o resto foi conferido por estrutura, busca de acentos e comparação com o inglês).
