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
5. Ordem (painel → projetos → e-mail), a senha "da época", a caixa "Publicar do GitHub antes de restaurar", a espera de até 45 min e o que fica de fora (itens não marcados na aba Backups, fora de volumes; branch atual do GitHub, não a da data do backup).

## O que NÃO consegui confirmar contra o código

- Se o baseline de monitoramento volta no backup do painel e gera alertas na VPS nova (a página manda recriá-lo "se houver diferenças").
- Como um projeto que **não** vem do GitHub é republicado numa VPS nova (o backup guarda o código, mas o fluxo usa `projects.redeploy`; só li o caso GitHub).
- Que o fuso da VPS nova segue o que o painel restaurado espera (a página manda conferir).
- Texto exato "Conexão testada e salva" e demais mensagens dinâmicas da interface (conferi os rótulos fixos).
- Afirmações sobre provedores que ficaram: PTR (Contabo/Hetzner/Vultr, existe em `dns-checklist.ts`), "Hetzner, AWS, OCI bloqueiam a 25" (troubleshooting e produção), e o link "Fale com a TWS".
- Não executei nenhum script de shell nem os comandos de VPS; a leitura foi do código.

## Sugestões que dependem do Kelvin

1. **`ALLOWED_ORIGINS` não é repassada pelo `docker-compose.yml`** (nem `docker-compose.dev.yml`, não verifiquei): quem usa o painel atrás de outro proxy e recebe `403 forbidden_origin` não tem como configurar. Decidir se passa a repassar; só então documentar a variável em "Solução de problemas".
2. Incluir as chaves do armazenamento (ou instrução explícita) no kit de recuperação; hoje a restauração numa VPS nova exige um passo a mais.
3. Avisar na tela de restauração do painel sobre o acesso pelo IP desativado (armadilha do passo 5).
4. Os guias citam `tws.tec.br` ("Fale com a TWS") e nomes de provedores: manter ou tirar.
5. Os links para `blob/main/...` só funcionam depois que a `main` tiver esses arquivos.
6. Quando a interface em inglês sair, trocar o padrão "rótulo em português (tradução)" pelos rótulos reais e remover a nota das páginas.
7. Revisão humana de um falante nativo de inglês ainda é recomendada; esta revisão foi feita por modelo.

## Verificação

`pnpm install --frozen-lockfile`, `pnpm --filter site build` (30 páginas), `pnpm --filter site check:build` (OK), `pnpm docs:links` (50 arquivos, 0 quebrados), varredura do HTML gerado (1778 `href` internos, âncoras incluídas, 0 problemas). **Não testado:** aparência do site em navegador (inclusive o script do 404), o workflow do GitHub Pages, e a leitura integral do pt-br fora da página de instalação (o resto foi conferido por estrutura, busca de acentos e comparação com o inglês).
