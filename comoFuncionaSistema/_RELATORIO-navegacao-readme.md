# Relatório: navegação do README e dos guias iniciais

Base: `origin/dev` (o worktree estava em um commit anterior, sem trabalho próprio; foi realinhado).
Só documentação. Nenhum código nem dicionário da interface foi alterado.

## Decisões

- **Guia principal para iniciantes: "Do zero ao painel pronto" (complete-guide).** Conferido nos
  dois textos: o guia completo cobre as 11 etapas (VPS, instalação, wizard, domínio, fuso, e-mail,
  notificações, backups, primeiro projeto, restauração testada, manutenção). Já a Instalação (passos
  1 a 8) cobre só até abrir o wizard. A Etapa 2 do guia completo resume os comandos e manda para a
  Instalação nos detalhes, então a sugestão do dono vale: o guia completo é o caminho; a Instalação é o
  detalhe de consulta. Contrapartida aceita: quem não sabe usar SSH sai do guia completo para a
  Instalação na Etapa 2 (o link está lá, e o README mostra os dois na mesma célula).
- **Caminho 3 ("já sei o que estou fazendo")** aponta para a seção "Instalação" do README, que
  continua com o mesmo título e a mesma âncora (`#installation` / `#instalação`). No site essa seção
  não existe, então o link vai para o README no GitHub.
- **Âncoras preservadas:** `#installation`, `#instalação`, `#after-installing`, `#depois-de-instalar`
  e `#host-identification-changed` seguem iguais. Novas: `#start-here` (EN) e `#por-onde-começar` (PT).
- **Aviso do SSH:** um único alerta, com o mesmo texto, em quatro lugares e dois idiomas
  (installation, complete-guide, restore-new-server e a seção Instalação do README, esta em versão
  curta). A última frase foi reescrita para ser segura: manda não continuar e não rodar o
  `ssh-keygen -R`, conferir o IP e ver no painel do provedor se houve reinstalação, modo de resgate ou
  troca de IP, e avisa que o aviso pode ser o único sinal de outra máquina no endereço. O bloco
  recolhido da Instalação continua como detalhe.

## O que mudou, pelo comportamento

- **README (EN e PT, mesma estrutura):** o seletor de idioma virou uma linha própria no topo, com o
  idioma atual em negrito, e saiu do fim da linha de menu. O item "Instalação" do menu leva à nova
  seção "Where to start" / "Por onde começar", logo após a imagem do dashboard e antes do aviso de beta:
  uma tabela com os 3 caminhos, cada um com uma frase de para quem é, e uma linha sobre problemas de
  SSH. A seção Instalação ganhou uma frase apontando para o guia completo e o aviso do SSH. A tabela de
  documentação passou a começar pelo guia completo e ganhou a restauração.
- **Guias iniciais:** a Instalação e o guia completo começam com um quadro "Qual guia eu uso?" que
  liga um ao outro e à restauração. O guia de restauração diz que a primeira instalação é pelo guia
  completo e mostra o aviso do SSH no passo 1.
- **Site:** a página inicial (en e pt-br) mostra, no topo, botões para a primeira instalação e para a
  restauração e, logo abaixo, a tabela dos 3 caminhos com o aviso do SSH. A barra lateral começa por
  "Comece aqui: guia completo", depois Instalação (passos 1 a 8), Wizard de segurança e Restaurar numa
  VPS nova (que saiu do grupo Guias; cada página aparece uma vez). O seletor de idioma do Starlight já
  está no cabeçalho e não foi mexido; o tema também não.
- **Correção encontrada:** a página inicial usava componentes do Starlight (`Card`, `CardGrid`) dentro
  de `.md`, mas o projeto não tem `@astrojs/mdx`, e o resultado era a linha `import ...` aparecendo
  como texto e os cartões colados em um parágrafo. Reescrevi a página em Markdown puro (lista no lugar
  dos cartões). Adotar MDX exigiria nova dependência; não fiz.
- `site/README.md` descreve a navegação para iniciantes e a regra do texto único do aviso do SSH.

## Verificação

`pnpm install --frozen-lockfile`, `pnpm docs:build`, `check:build`, `pnpm docs:links` e
`node scripts/check-no-real-hosts.mjs`: todos passaram (sem `git init`, o script usa o git do worktree).
Conferi no navegador a página inicial em pt-br, a barra lateral e o topo da Instalação em pt-br.

## O que não foi conferido

- Os READMEs renderizados no GitHub (só leitura do Markdown; a tabela com `<br>` e as âncoras com
  acento em `#por-onde-começar` e `#instalação` precisam de um olhar no GitHub).
- A página inicial e os guias em inglês no navegador (mesma estrutura do pt-br, só o build foi conferido).
- Se o navegador abre o bloco recolhido ao seguir `#host-identification-changed` (depende do navegador).
- O alerta do SSH nas páginas de restauração e no guia completo foi visto só no HTML gerado pelo
  `check:build` (contagem de avisos), não visualmente.
- Os links do site para o README apontam para `main`; só funcionam depois que esta mudança chegar lá.
