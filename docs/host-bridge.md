# Host bridge — como o painel executa scan/hardening na VPS real

> Problema original (bug arquitetural encontrado em campo): o painel roda num
> container Docker, mas o módulo de segurança executava os comandos com
> `bash -c` no **namespace do próprio container** — o scan mostrava dados do
> Debian da imagem (`node:22-bookworm-slim`) e o hardening modificaria o
> container descartável, não a VPS. Inútil e enganoso.

## 1. Arquitetura

O painel executa comandos no **host real** através de um **container helper
privilegiado e descartável** — o mesmo padrão usado por Coolify e Portainer:

```
docker run --rm --privileged --pid=host alpine:3 \
  nsenter -t 1 -m -u -i -n -p -- bash -c "<comando>"
```

- `--pid=host`: o helper enxerga o PID 1 do host (init);
- `nsenter -t 1 -m -u -i -n -p`: o comando entra nos namespaces de **mount,
  uts, ipc, net e pid** do host — ou seja, `ufw`, `sshd -T`, `apt`,
  `fail2ban-client`, `/etc/passwd` etc. são os da **VPS real**;
- `--rm`: o helper é destruído ao fim de cada comando — nenhum processo ou
  estado privilegiado permanece;
- o **upload dos scripts** (`scripts/hardening/*`) usa só o namespace de
  mount (`nsenter -t 1 -m`), extraindo um tar via stdin em
  `/opt/paas-hardening` do host.

Implementação: `NsenterHostRunner` em `packages/security/src/runner.ts`;
a montagem dos comandos e a allowlist ficam em
`packages/security/src/host-bridge.ts` (funções puras, 100% testadas).

## 2. Por que é seguro

| Propriedade | Como é garantida |
|---|---|
| **Sem credencial nova** | Usa o `/var/run/docker.sock` que o painel já monta para gerenciar o Docker — nenhuma senha/chave extra é criada. Quem monta o socket já é, por definição, equivalente a root no host: o bridge não aumenta esse privilégio. |
| **Allowlist estrita** | O runner rejeita qualquer comando que não seja: (a) um dos comandos fixos somente-leitura dos checks/baseline/Lynis, ou (b) uma invocação validada de `scripts/hardening/{00..06}-*.sh` com flags conhecidas (`--dry-run/--rollback/--confirm/--user/--pubkey`). Nada vindo da API vira shell arbitrário. |
| **Input revalidado** | A chave pública SSH e o nome de usuário da Fase 01 são validados duas vezes (rota + builder do comando) com regex que proíbe aspas/quebras de linha — impossível quebrar o quoting. |
| **Descartável** | `--rm` + nome único por execução; em timeout o cliente é morto e o helper é removido com `docker rm -f`. |
| **Timeout por comando** | `exec` tem timeout (default 120s; 300s para Lynis); streams de fase têm teto de 30 min. |
| **Auditado** | Todo comando enviado ao host gera entrada `hardening.host-exec` no log de auditoria (tela **Auditoria**). |
| **Rollback preservado** | As garantias já existentes (backup de arquivos, rollback imediato em falha, rollback agendado de 5 min em SSH/firewall/fase 01) continuam valendo — agora no host de verdade. |

## 3. Perfis do scanner (host vs container)

O scanner sabe o perfil do alvo (`runner.profile`):

- **`host`** (produção, `PAAS_TARGET=host`): todos os checks rodam na VPS real
  via host bridge;
- **`container`** (dev/teste, `PAAS_TARGET=container`, usado pelos E2E):
  checks que só fazem sentido num host — `ufw`, `sshd`, `fail2ban`, `snapd`,
  `unattended-upgrades`, `sysctl`, `auditd`, `AIDE`, `rkhunter`, cron — são
  **pulados** e listados em `skippedChecks` do relatório, com o motivo.
  Rodá-los num container gerava **falsos-positivos de contexto**: o check
  avaliava o namespace do container, não a máquina real.

Checks mantidos no perfil container (se aplicam a qualquer alvo Linux):
pacotes pendentes, repositórios de terceiros, UID 0, senha do root, sudo,
portas de banco/Docker expostas, inventário de portas, clientes legados.

## 4. Fase 01 com a chave SSH do operador

Antes da Fase 01 o wizard pede a **chave pública SSH** da máquina do operador
(validação de formato no cliente e no servidor). O script instala a chave no
novo usuário e **só trava a senha do root com a chave presente**
(anti-lockout, já existente). Ao travar o root, o script agenda uma reversão
automática (`at`/timer de 5 min) que destranca o root — o alerta pulsante da
UI orienta: *"abra outra janela SSH e teste o login com o novo usuário ANTES
de confirmar"*.

## 5. Hardening da própria imagem do painel

O container do painel é o exemplo (ver `Dockerfile` e `docker-compose.yml`):

- **usuário não-root** (`tws`) — acesso ao socket via `group_add` do GID do
  grupo docker do host (`DOCKER_GID`, gravado no `.env` pelo `install.sh`);
- **`no-new-privileges`**: nenhum processo do container escala privilégio;
- **`cap_drop: ALL` sem `cap_add`**: o cliente Docker não precisa de
  capabilities para falar com o socket; quem confere `--privileged` ao helper
  é o **daemon do host**. Documentado porque é contra-intuitivo: o privilégio
  do helper vem do daemon, não das caps do cliente;
- **`read_only: true`** com `tmpfs` em `/tmp`: rootfs imutável; só `/data`
  (volume de estado) e `/tmp` (volátil) são graváveis;
- **Docker CLI + compose plugin** instalados de binários estáticos oficiais
  com **sha256 fixado** no Dockerfile (antes a imagem nem tinha o CLI —
  outro bug latente para o host bridge);
- **scan Trivy no CI** (`.github/workflows/ci.yml`, job `image-scan`): build
  da imagem + relatório HIGH/CRITICAL com fix disponível. Política atual:
  *report-only* (`exit-code 0`) — o CI passará a falhar em CRITICAL quando o
  baseline estiver limpo (findings residuais do Debian slim sem fix upstream).

> Nota de modelo de ameaça: com o docker.sock montado, o container do painel
> é **equivalente a root no host** por design (ele administra a VPS). As
> medidas acima são defesa em profundidade contra comprometimento do
> processo Node (RCE na API), não contra o acesso legítimo ao daemon.

## 6. Teste manual do bridge (ambiente descartável)

```bash
# 1) helper executa no namespace do host: hostname deve ser o da VPS
docker run --rm --privileged --pid=host alpine:3 \
  nsenter -t 1 -m -u -i -n -p -- hostname

# 2) allowlist: comando fora da lista é rejeitado antes de tocar o host
#    (ver packages/security/tests/host-bridge.test.ts)

# 3) E2E continuam no perfil container (ContainerRunner):
pnpm test:e2e
```

## 7. Terminal web embutido (PTY sem node-pty)

O terminal ao vivo do wizard (visão dupla) usa o MESMO padrão do host bridge —
a decisão foi **Docker Engine API via `/var/run/docker.sock`, NÃO node-pty**:

- **node-pty** compila nativo (node-gyp → python3/make/g++ na imagem) e, pior,
  daria um shell DENTRO do container do painel — o alvo correto é o HOST;
- o daemon Docker JÁ aloca PTYs de graça: o painel cria um container helper
  descartável (`Tty: true`, `--privileged`, `pid: host`, `AutoRemove`) rodando
  `nsenter -t 1 -m -u -i -n -p -- bash -l` e faz **hijack** do attach (HTTP 101,
  stream cru — sem multiplex de stdout/stderr quando `Tty: true`). O resize é o
  endpoint `POST /containers/{id}/resize` da API. No alvo de dev (container), o
  caminho é `POST /containers/{alvo}/exec` + `/exec/{id}/start` hijacked.

Implementação: `apps/server/src/services/docker-socket.ts` (transporte),
`terminal-service.ts` (sessão única, scrollback, fila de comandos, idle
timeout de 30 min) e `routes/terminal.ts` (WebSocket `/api/terminal/ws`,
autenticado pela guarda global: setup token no wizard, sessão admin depois).

**Fases dentro do terminal:** o `TerminalRelayRunner` desvia o `execStream` do
executor para o shell do terminal — o comando aparece digitado no xterm, a
saída rola ao vivo e o exit code é lido de um marcador
`:::PAAS_EXIT_<nonce>:<code>` filtrado do stream. Prompts interativos são
respondidos pelo usuário digitando no próprio terminal.

**REGRA DE OURO:** o backend faz RELAY PURO do fluxo. O input do usuário
(senhas inclusas) NUNCA é logado, persistido, auditado ou inspecionado — a
auditoria registra apenas conexão/desconexão/ciclo de vida da sessão. Há um
teste que injeta `senha-secreta` no stream e prova que ela não aparece em
nenhum log/auditoria (`apps/server/tests/terminal-service.test.ts` e
`routes-terminal.test.ts`). Se o PTY estiver indisponível (ex.: sem
docker.sock), o executor cai para o caminho antigo (`execStream` direto) — a
indisponibilidade do terminal nunca impede o hardening.
