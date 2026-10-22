# Política de Segurança

Versão em inglês (principal): [SECURITY.md](../../../SECURITY.md).

O TWS Panel administra uma VPS inteira, por isso levamos a segurança a sério. Se você encontrou uma
vulnerabilidade, agradecemos um relato responsável.

## Reportando uma vulnerabilidade

**Não abra uma issue, um pull request nem uma discussão pública** para uma vulnerabilidade de
segurança.

Reporte de forma privada pelos GitHub Security Advisories:

1. Abra a [aba Security do repositório](https://github.com/kelvindk9w/tws-panel/security).
2. Clique em **Report a vulnerability** e preencha o formulário.

Link direto: <https://github.com/kelvindk9w/tws-panel/security/advisories/new>

Se você não puder usar o GitHub, escreva para
**[contato@tws.tec.br](mailto:contato@tws.tec.br)**. Não publique detalhes de exploração em nenhum
lugar público.

Se possível, inclua:

- Uma descrição da vulnerabilidade e do impacto potencial;
- Os passos para reproduzir (ou uma prova de conceito);
- A versão ou o commit afetado e o seu ambiente (SO, versão do Docker etc.).

**O que esperar:**

- Confirmação de recebimento do seu relato em até **72 horas**;
- Uma avaliação e, se o relato for confirmado, uma correção ou mitigação em até **90 dias** (antes,
  sempre que possível);
- Crédito no anúncio da correção, se você quiser;
- Pedimos que você não divulgue a vulnerabilidade publicamente antes de a correção estar disponível.

## Versões suportadas

O projeto está em **beta** (`0.x`). Somente o código mais recente da branch `main` recebe correções
de segurança, e não há linhas de versões antigas mantidas. Rode sempre a versão mais recente (veja o
[CHANGELOG](../../../CHANGELOG.md) e as instruções de atualização no
[guia de operação](../../../site/src/content/docs/pt-br/guides/operations.md)).

| Versão | Suportada |
| ------ | --------- |
| `main` (mais recente) | Sim |
| Qualquer versão anterior | Não, atualize |

## Escopo

**Dentro do escopo:**

- O código deste repositório: `apps/server`, `apps/web`, `packages/*` e `scripts/*`;
- O instalador (`scripts/install.sh`) e os scripts de hardening (`scripts/hardening/`);
- O wizard de setup (autenticação por token) e o acesso ao painel (HTTPS pelo proxy Caddy, túnel
  SSH, domínio do painel);
- A API do painel (autenticação, autorização, injeção, path traversal etc.).

**Fora do escopo:**

- Vulnerabilidades em dependências de terceiros sem prova de que elas podem ser exploradas por meio
  deste projeto (reporte ao upstream; nós mantemos as nossas dependências atualizadas);
- Problemas que exigem acesso root ou local à VPS (o painel trata o host como a base de confiança);
- Configurações deliberadamente inseguras marcadas como "apenas para testes" em `examples/`;
- Negação de serviço por esgotamento dos recursos da própria máquina.

## Práticas de segurança do projeto

- **Um wizard de setup protegido por um token**, comparado em tempo constante. O instalador o gera
  com permissão 0600, e ele deixa de ser aceito quando o setup termina.
- **Um terminal web com shell real na VPS, de propósito.** Ele permite conduzir o hardening pela
  interface e é a maior superfície de ataque do sistema. Na instalação, quem instala escolhe com
  qual usuário o terminal abre. O recomendado é o seu próprio usuário comum: o que precisa de root
  passa pelo `sudo` com senha ou roda em segundo plano e fica registrado no log de auditoria. O
  `root` é possível, mas desaconselhado: com `root`, quem tem uma sessão no painel tem a máquina.
  Isso **não é uma vulnerabilidade a reportar**. Está declarado como risco aceito no
  [threat-model.json](../../../comoFuncionaSistema/global/threat-model.json), junto com o socket do
  Docker montado no painel. Falhas que permitam chegar a esse terminal **sem uma sessão válida**
  estão no escopo.
- **O painel escuta só em `127.0.0.1`.** O container do painel não publica porta na internet. O
  proxy Caddy o atende de fora nas portas 80 e 443, com HTTPS (ou você o acessa por um túnel SSH, no
  acesso somente por túnel).
- **Login com verificação em duas etapas** (TOTP, com códigos de recuperação), hash de senha
  argon2id, sessões revogáveis e limite de tentativas.
- **O socket do Docker nunca é exposto por TCP.** O acesso é somente pelo socket local.
- **CORS de mesma origem** por padrão, cabeçalhos de segurança (Helmet/CSP) e rate limiting.
- **Segredos em disco com modo 0600**, com os sensíveis cifrados (variáveis de ambiente dos
  projetos, credenciais de repositório, token do Telegram, e chave e senha dos backups), e
  **mascaramento de tokens e senhas nos logs**.
- **Auditoria** de toda ação sensível (login, deploy, override de guardrail, hardening, mudanças no
  e-mail, domínio do painel, notificações, backups e monitoramento).
- **Guardrails de deploy** que bloqueiam configurações perigosas (como uma porta de banco de dados
  exposta, credenciais fracas ou um container privilegiado) e só podem ser contornados com um override explícito e auditado. As regras que protegem o isolamento do próprio painel não podem ser contornadas de forma alguma.
- **Imagens de container fixadas e mantidas em dia.** Toda imagem que o painel roda (Node, Caddy,
  Stalwart, webmail Roundcube, nginx) é fixada por tag e digest, então as correções só chegam quando
  o repositório troca o digest. Quando a imagem fixada do webmail muda, o painel recria o container
  do webmail sozinho depois de uma atualização (dados e configuração ficam no volume).
- **Risco aceito e conhecido: `braces` (alerta do Dependabot, GHSA-vfj7-8cjw-p6xm).** Não existe
  versão corrigida no projeto original. É só dependência de desenvolvimento (via `tailwindcss`,
  `chokidar` e `micromatch`, usadas no build da interface), o `pnpm audit --prod` não acusa nada e o
  servidor nunca a carrega, então nenhuma entrada externa chega a ela. Revisamos quando sair uma
  versão corrigida.
- **Hardening com rollback automático** nas três fases que mexem no acesso (usuário, SSH e
  firewall): se ninguém confirmar em cerca de 5 minutos, o servidor desfaz sozinho o que aplicou.
