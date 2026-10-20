---
title: "Host bridge: how the panel runs scans and hardening on the real VPS"
description: "How the panel runs the security scan and hardening on the host through a privileged, disposable helper container, and how that is kept safe."
sidebar:
  label: "Host bridge"
---

> Original problem (an architectural bug found in the field): the panel runs in a Docker
> container, but the security module executed commands with `bash -c` in the **container's own
> namespace** — the scan showed data from the image's Debian (`node:22-bookworm-slim`) and hardening
> would have modified the disposable container, not the VPS. Useless and misleading.

> [!NOTE]
> **The panel interface is being translated.** For now, screen names, buttons and messages appear in Portuguese, exactly as on screen, followed by the English meaning in parentheses. They may change when the English interface is released.

## 1. Architecture

The panel runs commands on the **real host** through a **privileged, disposable helper
container** — the same pattern used by Coolify and Portainer:

```
docker run --rm --privileged --pid=host alpine:3 \
  nsenter -t 1 -m -u -i -n -p -- bash -c "<command>"
```

(The panel uses the image pinned by digest, `alpine:3@sha256:…`, defined in
`packages/core/src/images.ts`; `alpine:3` is shown here only for readability. This way, a hosted
project that overwrites the `alpine:3` tag on the server cannot swap the binary that runs as root.)

- `--pid=host`: the helper sees the host's PID 1 (init);
- `nsenter -t 1 -m -u -i -n -p`: the command enters the host's **mount,
  uts, ipc, net and pid** namespaces — that is, `ufw`, `sshd -T`, `apt`,
  `fail2ban-client`, `/etc/passwd` etc. are the ones from the **real VPS**;
- `--rm`: the helper is destroyed at the end of each command — no privileged process or
  state remains;
- the **upload of the scripts** (`scripts/hardening/*`) uses only the mount
  namespace (`nsenter -t 1 -m`), extracting a tar via stdin into
  `/opt/paas-hardening` on the host.

Implementation: `NsenterHostRunner` in `packages/security/src/runner.ts`;
command assembly and the allowlist live in
`packages/security/src/host-bridge.ts` (pure functions, 100% tested).

## 2. Why it is designed to be safe

| Property | How it is guaranteed |
|---|---|
| **No new credential** | Uses the `/var/run/docker.sock` that the panel already mounts to manage Docker — no extra password/key is created. Whoever mounts the socket is, by definition, already equivalent to root on the host: the bridge does not increase that privilege. |
| **Strict allowlist** | The runner rejects any command that is not: (a) one of the fixed read-only commands of the checks/baseline/Lynis (includes reading the time zone, `timedatectl show -p Timezone --value`), (b) a validated invocation of `scripts/hardening/{00..07}-*.sh` with known flags (`--dry-run/--rollback/--confirm/--no-tunnel/--user/--pubkey`), or (c) the time zone change from **Configurações → Fuso horário** (Settings → Time zone) (`timedatectl set-timezone '<fuso>'`, with `ln -sf` of `/etc/localtime` as a fallback), accepted only if it is byte for byte the command built for a time zone from the closed list (`isKnownTimezone`). Nothing coming from the API becomes arbitrary shell. |
| **Input revalidated** | The SSH public key and the user name of Phase 01 are validated twice (route + command builder) with a regex that forbids quotes/line breaks — it is designed so that the quoting cannot be broken. |
| **Disposable** | `--rm` + a unique name per execution; on timeout the client is killed and the helper is removed with `docker rm -f`. |
| **Per-command timeout** | `exec` has a timeout (default 120s; 300s for Lynis); phase streams have a 30 min ceiling. |
| **Audited** | Every command sent to the host generates a `hardening.host-exec` entry in the audit log (**Auditoria** (Audit) screen); time zone ones generate `timezone.host-exec`, plus `timezone.applied`/`timezone.apply_failed`. |
| **Rollback preserved** | The existing guarantees (file backup, immediate rollback on failure, 5-minute scheduled rollback in SSH/firewall/phase 01) still hold — now on the real host. |

## 3. Scanner profiles (host vs container)

The scanner knows the target's profile (`runner.profile`):

- **`host`** (production, `PAAS_TARGET=host`): all checks run on the real VPS
  via the host bridge;
- **`container`** (dev/test, `PAAS_TARGET=container`, used by the E2E tests):
  checks that only make sense on a host — `ufw`, `sshd`, `fail2ban`, `snapd`,
  `unattended-upgrades`, `sysctl`, `auditd`, `AIDE`, `rkhunter`, cron — are
  **skipped** and listed in the report's `skippedChecks`, with the reason.
  Running them in a container produced **context false positives**: the
  check evaluated the container's namespace, not the real machine.

Checks kept in the container profile (they apply to any Linux target):
pending packages, third-party repositories, UID 0, root password, sudo,
exposed database/Docker ports, port inventory, legacy clients.

## 4. Phase 01 with the operator's SSH key

Before Phase 01 the wizard asks for the **SSH public key** of the operator's machine
(format validation on the client and on the server). The script installs the key on the
new user and **only locks the root password with the key present**
(anti-lockout, already existing). When locking root, the script schedules an automatic
rollback (`at`/5-min timer) that unlocks root — the UI's pulsing alert
guides the operator: *"abra outra janela SSH e teste o login com o novo usuário ANTES
de confirmar"* (open another SSH window and test the login with the new user BEFORE
confirming).

## 5. Hardening of the panel's own image

The panel container is the example (see `Dockerfile` and `docker-compose.yml`):

- **non-root user** (`tws`) — socket access via `group_add` of the host's docker
  group GID (`DOCKER_GID`, written to `.env` by `install.sh`);
- **`no-new-privileges`**: no process in the container escalates privilege;
- **`cap_drop: ALL` with no `cap_add`**: the Docker client does not need
  capabilities to talk to the socket; whoever grants `--privileged` to the helper
  is the **host's daemon**. Documented because it is counter-intuitive: the helper's
  privilege comes from the daemon, not from the client's caps;
- **`read_only: true`** with `tmpfs` on `/tmp`: immutable rootfs; only `/data`
  (state volume) and `/tmp` (volatile) are writable;
- **Docker CLI + compose plugin** installed from official static binaries
  with **sha256 pinned** in the Dockerfile (previously the image did not even have the CLI —
  another latent bug for the host bridge);
- **Trivy scan in CI** (`.github/workflows/ci.yml`, job `image-scan`): image
  build + HIGH/CRITICAL report with a fix available. Current policy:
  *report-only* (`exit-code 0`) — CI will start failing on CRITICAL when the
  baseline is clean (residual Debian slim findings with no upstream fix).

> Threat model note: with docker.sock mounted, the panel container
> is **equivalent to root on the host** by design (it administers the VPS). The
> measures above are defense in depth against compromise of the Node
> process (RCE in the API), not against legitimate access to the daemon.

## 6. Manual bridge test (disposable environment)

```bash
# 1) helper runs in the host's namespace: hostname must be the VPS's
docker run --rm --privileged --pid=host alpine:3 \
  nsenter -t 1 -m -u -i -n -p -- hostname

# 2) allowlist: a command outside the list is rejected before touching the host
#    (see packages/security/tests/host-bridge.test.ts)

# 3) E2E tests remain on the container profile (ContainerRunner):
pnpm test:e2e
```

## 7. Embedded web terminal (PTY without node-pty)

The wizard's live terminal (dual view) uses the SAME pattern as the host bridge —
the decision was **Docker Engine API via `/var/run/docker.sock`, NOT node-pty**:

- **node-pty** compiles natively (node-gyp → python3/make/g++ in the image) and, worse,
  would give a shell INSIDE the panel container — the correct target is the HOST;
- the Docker daemon ALREADY allocates PTYs for free: the panel creates a disposable helper
  container (`Tty: true`, `--privileged`, `pid: host`, `AutoRemove`) running
  `nsenter -t 1 -m -u -i -n -p -- bash -l` and **hijacks** the attach (HTTP 101,
  raw stream — no stdout/stderr multiplexing when `Tty: true`). Resize is the
  `POST /containers/{id}/resize` endpoint of the API. In the dev target (container), the
  path is `POST /containers/{target}/exec` + hijacked `/exec/{id}/start`.

Implementation: `apps/server/src/services/docker-socket.ts` (transport),
`terminal-service.ts` (single DETACHABLE session — it lives on the server between
WS reconnections —, scrollback, command queue, 30 min idle timeout,
container cleanup on exit) and `routes/terminal.ts` (WebSocket
`/api/terminal/ws`, authenticated by the global guard: setup token in the wizard,
admin session afterwards). Session ownership by `clientId` (anti-ping-pong): the
same clientId reattaches; a different clientId is refused with close 4009
("terminal em uso" — terminal in use) without dropping the owner; an orphan session (owner disconnected)
can be taken over by any client.

**Phases inside the terminal:** the `TerminalRelayRunner` diverts the executor's
`execStream` to the terminal's shell — the command appears typed in xterm, the
output scrolls live and the exit code is read from a marker
`:::PAAS_EXIT_<nonce>:<code>` filtered out of the stream. Interactive prompts are
answered by the user typing in the terminal itself.

**GOLDEN RULE:** the backend does a PURE RELAY of the stream. The user's input
(passwords included) is NEVER logged, persisted, audited or inspected — auditing
records only connection/disconnection/session lifecycle. There is a test that injects `senha-secreta` into the stream and proves it does not appear in
any log/audit (`apps/server/tests/terminal-service.test.ts` and
`routes-terminal.test.ts`). If the PTY is unavailable (e.g. no
docker.sock), the executor falls back to the old path (direct `execStream`) — the
terminal being unavailable never blocks hardening.
