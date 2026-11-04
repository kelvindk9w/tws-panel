# Pesquisa de Segurança: Hardening de VPS Ubuntu (22.04/24.04) Recém-Contratada

> Relatório de pesquisa para especificação de script de hardening automatizado de um painel open-source.
> Fontes: documentação oficial Ubuntu/Canonical, CIS Benchmarks, guias de hardening 2025/2026 (Lynis/CISOfy, OpenSCAP, OWASP, Wiz, etc.).
> Data da pesquisa: agosto/2026.

---

## 0. Sumário executivo

Uma VPS Ubuntu recém-provisionada ("crua") exposta na internet recebe as primeiras tentativas de ataque automatizadas em **~90 segundos** após ficar online. Pesquisas de 2025 indicam que **~89% dos ataques a endpoints Linux envolvem brute force/credential stuffing contra SSH exposto**, e a maioria das invasões explora **misconfigurações e pacotes desatualizados**, não zero-days. Portanto, o hardening inicial deve priorizar: (1) SSH somente com chave, (2) firewall default-deny, (3) atualizações automáticas de segurança, (4) redução de superfície (pacotes/serviços/portas), e (5) detecção (auditoria, FIM, rootkit scanners).

---

## 1. Vetores de ataque por categoria

### 1.1 Ataques de acesso

| Vetor | Descrição | Sinais detectáveis |
|---|---|---|
| **Brute force SSH** | Bots escaneiam todo o IPv4 em minutos, tentam combos `root/root`, `admin/password`, `ubuntu/ubuntu` na porta 22 | Milhares de `Failed password` em `/var/log/auth.log` |
| **Password spraying** | Poucas senhas comuns testadas contra muitos usuários (evita lockout) | Falhas distribuídas entre vários usuários |
| **Credential stuffing** | Uso de credenciais vazadas de outros breaches | Logins bem-sucedidos de IPs/geolocalizações anômalas |
| **Chaves SSH fracas/roubadas** | Chaves RSA <2048, DSA, sem passphrase, ou vazadas em repositórios | Uso de `authorized_keys` não autorizados |
| **Ataques ao próprio OpenSSH** | Ex.: CVE-2025-26465 (MITM em client auth) — o daemon também é superfície de ataque | Pacotes OpenSSH desatualizados |

**Remediação padrão-ouro:**
- Autenticação **somente por chave** (ed25519): `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PubkeyAuthentication yes`.
- `PermitRootLogin no` (ou no máximo `prohibit-password`).
- `AllowUsers`/`AllowGroups` para restringir quem pode logar.
- `MaxAuthTries 3`, `LoginGraceTime 30`, `MaxSessions 2`.
- Desabilitar forwarding desnecessário: `X11Forwarding no`, `AllowAgentForwarding no`, `AllowTcpForwarding no` (ou limitado), `PermitTunnel no`, `PermitUserEnvironment no`.
- Logging verboso: `LogLevel VERBOSE` (registra fingerprint da chave usada).
- Criptografia moderna (OpenSSH 9.x):
  ```
  KexAlgorithms sntrup761x25519-sha512@openssh.com,curve25519-sha256,curve25519-sha256@libssh.org
  Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com
  MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com
  ```
- **Fail2ban** ou **CrowdSec** para banir IPs após N falhas.
- Porta não-padrão: **redução de ruído, não segurança real** — opcional, mas limpa os logs. **Atenção**: desde Ubuntu 22.10 o sshd usa *socket activation* — mudar a porta exige `systemctl edit ssh.socket` (alterar `ListenStream=`), não apenas `sshd_config`, e depois `systemctl daemon-reload && systemctl restart ssh.socket`.
- Opcional avançado: 2FA via `libpam-google-authenticator`.
- Sempre validar antes de recarregar: `sudo sshd -t` e testar nova sessão **antes** de fechar a atual.

### 1.2 Ataques de rede

| Vetor | Descrição | Mitigação |
|---|---|---|
| **Port scanning / fingerprinting** | nmap/masscan para mapear serviços e versões | Firewall default-deny; minimizar portas; `server_tokens off` no nginx |
| **SYN flood / DDoS L3/L4** | Esgotamento da fila SYN | `net.ipv4.tcp_syncookies=1`, backlog maior, rate limiting; DDoS volumétrico só se resolve no provedor (Cloudflare, proteção do hoster) |
| **Slowloris / DDoS L7** | Conexões HTTP lentas e incompletas | Timeouts no nginx (`client_body_timeout`, `client_header_timeout`), `limit_req_zone`, fail2ban `nginx-limit-req` |
| **IP spoofing** | Pacotes com origem falsificada | Reverse path filtering: `net.ipv4.conf.all.rp_filter=1` |
| **MITM via ICMP redirect** | Envenenamento de tabela de rotas | `net.ipv4.conf.all.accept_redirects=0`, `secure_redirects=0` |
| **Source routing** | Roteamento forçado pelo remetente | `net.ipv4.conf.all.accept_source_route=0` |
| **Smurf/ICMP broadcast** | Amplificação via broadcast | `net.ipv4.icmp_echo_ignore_broadcasts=1` |
| **MITM em tráfego claro** | Sniffing de HTTP/SMTP/IMAP sem TLS | TLS obrigatório em tudo (HSTS, `smtpd_tls_security_level=encrypt`) |

**Configuração sysctl de referência** (`/etc/sysctl.d/99-hardening.conf`, aplicar com `sysctl --system`):

```ini
# --- Anti-spoofing / roteamento ---
net.ipv4.ip_forward = 0                       # a menos que seja router/host Docker*
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.log_martians = 1

# --- SYN flood / DDoS ---
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 2048
net.ipv4.tcp_synack_retries = 2
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
net.ipv4.tcp_keepalive_time = 600

# --- IPv6 (se não usado, considere desabilitar) ---
net.ipv6.conf.all.accept_ra = 0
net.ipv6.conf.default.accept_ra = 0
net.ipv6.conf.all.accept_redirects = 0
# net.ipv6.conf.all.disable_ipv6 = 1   # somente se IPv6 não for usado

# --- Kernel ---
kernel.randomize_va_space = 2
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
kernel.yama.ptrace_scope = 1
kernel.sysrq = 0
kernel.unprivileged_bpf_disabled = 1
net.core.bpf_jit_harden = 2
kernel.perf_event_paranoid = 2

# --- Filesystem ---
fs.protected_symlinks = 1
fs.protected_hardlinks = 1
fs.protected_fifos = 2
fs.protected_regular = 2
fs.suid_dumpable = 0
```

> ⚠️ *Se o host roda Docker com containers que precisam de NAT/forwarding, o Docker gerencia `ip_forward` automaticamente — não force `=0` nesse caso, ou faça-o sabendo que o Docker o reabilita.*

### 1.3 Ataques a serviços web hospedados

| Vetor | Mitigação padrão-ouro |
|---|---|
| **SQLi** | WAF: **ModSecurity v3 + OWASP Core Rule Set (CRS)** no nginx/Apache; na aplicação: prepared statements (responsabilidade do app, não do painel) |
| **XSS** | Headers: `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`; WAF CRS cobre padrões comuns |
| **Path traversal / LFI** | WAF CRS; `alias`/`root` corretos no nginx; `disable_symlinks` |
| **Reverse proxy mal configurado** | `proxy_pass` para backends que escutam **apenas em 127.0.0.1**; nunca expor porta de app/db diretamente; validar `Host`/`server_name`; passar `X-Real-IP`/`X-Forwarded-For` corretamente |
| **Portas expostas** | Inventário com `ss -tulpn` + scan externo `nmap -sV <ip>`; fechar tudo que não for necessário no UFW |
| **Info disclosure** | `server_tokens off;` no nginx; bloquear `.git`, `.env`, `.svn`:
  ```nginx
  location ~* /(\.git|\.env|\.svn|\.hg) { deny all; return 404; }
  ``` |
| **TLS fraco** | Somente TLS 1.2/1.3, ciphers fortes, HSTS, OCSP stapling; cert via Let's Encrypt (`certbot`); testar com SSL Labs |
| **Brute force HTTP/auth** | Rate limiting + fail2ban jails nginx |

**Snippet nginx de referência:**
```nginx
# /etc/nginx/conf.d/security.conf
server_tokens off;

limit_req_zone $binary_remote_addr zone=req_zone:10m rate=10r/s;

add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

# no server block:
#   limit_req zone=req_zone burst=20 nodelay;
#   client_body_timeout 10s; client_header_timeout 10s;
#   ssl_protocols TLSv1.2 TLSv1.3;
```

**WAF (ModSecurity + OWASP CRS):**
```bash
sudo apt install libmodsecurity3 modsecurity-crs   # ou compilar connector nginx
sudo cp /etc/modsecurity/modsecurity.conf-recommended /etc/modsecurity/modsecurity.conf
# mudar: SecRuleEngine On   (começar com DetectionOnly para tuning, evitar falsos positivos)
```
Estratégia recomendada: iniciar em `DetectionOnly`, revisar `/var/log/modsec_audit.log` por dias, whitelisting de falsos positivos, e só então `On`.

### 1.4 Ataques a Docker/containers

| Vetor | Descrição | Mitigação |
|---|---|---|
| **Socket Docker exposto** | `/var/run/docker.sock` montado em container ou API em `tcp://0.0.0.0:2375` sem TLS = root no host (CVE-2025-9074, CVSS 9.3, demonstrou escape via API sem auth) | **Nunca** montar o socket em containers de apps; se API remota for necessária: TLS + auth (`dockerd --tlsverify`); verificar `ss -tulpn \| grep 2375` |
| **Container escape** | Capabilities excessivas (`SYS_ADMIN`, `SYS_PTRACE`, `SYS_MODULE`), CVEs de runtime/kernel (runc CVE-2019-5736, Leaky Vessels CVE-2024-21626, Dirty Pipe CVE-2022-0847) | `--cap-drop=ALL`, `--security-opt no-new-privileges`, rodar como não-root, seccomp/AppArmor (`docker-default`), kernel/runtime atualizados |
| **Containers privilegiados** | `--privileged` = isolamento desligado | Proibir; alertar em auditoria: `docker ps -q \| xargs docker inspect -f '{{.Name}} privileged={{.HostConfig.Privileged}}'` |
| **Imagens vulneráveis** | CVEs herdados de imagens base | Scan com **Trivy** (`trivy image <img>`); imagens mínimas/distroless; reconstruir regularmente |
| **Mounts perigosos** | Montar `/`, `/proc`, `/sys`, `/etc` no container | Proibir; usar volumes nomeados |
| **Docker bypassa UFW** | Docker manipula iptables diretamente — regras UFW **não se aplicam** a portas publicadas por containers! | Publicar com `127.0.0.1:PORTA:PORTA` quando o acesso for local, ou configurar `/etc/docker/daemon.json` + regras `DOCKER-USER` |
| **Root no container = risco** | | User namespaces / rootless Docker onde viável |

**daemon.json mínimo:**
```json
{
  "live-restore": true,
  "userland-proxy": false,
  "no-new-privileges": true,
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
```
**Checklist de auditoria Docker para o painel:**
- [ ] Nenhum container `--privileged`
- [ ] Nenhum mount de `/var/run/docker.sock` em containers não-admin
- [ ] API Docker não escuta em TCP público (`2375/2376`)
- [ ] Containers rodam como não-root (`docker inspect -f '{{.Config.User}}'`)
- [ ] Scan Trivy periódico nas imagens
- [ ] Docker Bench Security (`docker run --net host --pid host docker/docker-bench-security`) — baseado no CIS Docker Benchmark

### 1.5 Ataques a servidor de e-mail

| Vetor | Descrição | Mitigação |
|---|---|---|
| **Open relay** | Servidor retransmite e-mail de qualquer origem → vira plataforma de spam, IP entra em blacklist | Postfix: `mynetworks = 127.0.0.0/8`, `smtpd_relay_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination`. Testar externamente: `nmap --script smtp-open-relay -p 25 <ip>` |
| **Abuso SMTP / brute force SASL** | Password spraying em 587/465 | fail2ban jails `postfix`, `postfix-sasl`, `dovecot` |
| **Spoofing do domínio** | Terceiros enviam e-mail fingindo ser seu domínio | Publicar DNS: **SPF** (`v=spf1 mx -all`), **DKIM** (OpenDKIM), **DMARC** (`v=DMARC1; p=quarantine; rua=mailto:...`, evoluir para `p=reject`), PTR/rDNS coerente com o HELO |
| **Auth em texto claro** | Credenciais sniffadas | Dovecot: `disable_plaintext_auth = yes`, `ssl = required`; Postfix submission: `smtpd_tls_security_level=encrypt` na 587; **proibir AUTH na porta 25** |
| **Spam inbound / malware em anexos** | | Rspamd ou SpamAssassin + **ClamAV**; políticas HELO/sender no Postfix |
| **Vazamento via fila** | Fila deferred crescente = sinal de abuso ou reputação ruim | Monitorar `mailq` / `postqueue -p` |

### 1.6 Pós-invasão (assume-se breach inicial)

| Vetor | Detecção | Prevenção |
|---|---|---|
| **Rootkits (LKM/eBPF)** | `rkhunter`, `chkrootkit`, comparar `lsmod` vs `/sys/module/`, `dmesg \| grep "out-of-tree"` | Kernel atualizado, AppArmor enforce, `kernel.unprivileged_bpf_disabled=1` |
| **Cryptominers** | CPU alta persistente, processos estranhos em `ps aux`, conexões para pools de mineração, crons suspeitos | Reduzir privilégios, monitoramento de recursos, egress filtering |
| **Backdoors/persistência** | `authorized_keys` novos, entradas em `/etc/cron*`, systemd units novos, binários em `/usr/local/bin`, contas novas (`/etc/passwd`) | **AIDE** (integridade de arquivos) + **auditd** (regras em `/etc/passwd`, `/etc/sudoers`, cron) |
| **Escalação de privilégio** | sudo anômalo, exploits de kernel (Dirty Pipe etc.) | Patching rápido, sudo restrito, `fs.protected_*`, remover compiladores de produção |
| **Movimento lateral** | Conexões SSH saindo do servidor, scanning interno | Egress firewall, chaves sem agent forwarding, segmentação |
| **Apagamento de logs** | Gaps em auth.log/journal | Logs remotos (rsyslog para servidor central), `auditd` |

**Sinais de comprometimento que a varredura do painel deve checar:**
```bash
# Logins e brute force
grep "Failed password" /var/log/auth.log | awk '{print $11}' | sort | uniq -c | sort -rn | head
last -20; lastb -20
# Processos e rede
ps auxf; ss -tulpn
# Persistência
ls -la /etc/cron.d /etc/cron.daily; crontab -l
cat /etc/passwd | awk -F: '$3 >= 1000'          # usuários não-padrão
find / -perm -4000 -type f 2>/dev/null           # binários SUID
systemctl list-units --type=service --state=running
lsmod
```

### 1.7 Supply chain

| Vetor | Mitigação |
|---|---|
| **Pacotes com CVEs** | `unattended-upgrades` para security updates automáticos; `apt list --upgradable`; Ubuntu Pro/ESM (grátis até 5 máquinas) amplia cobertura; `needrestart` para serviços que precisam de restart |
| **Repositórios comprometidos/não oficiais** | Auditar `/etc/apt/sources.list.d/`; APT já verifica assinaturas GPG — nunca desabilitar `Signed-By`; remover PPAs desnecessários |
| **Imagens Docker / deps de aplicação** | Trivy/SBOM, pin de versões, assinatura de imagens |
| **Pacotes órfãos/obsoletos sem update** | `apt list '?obsolete'` → remover |

---

## 2. Remediações padrão-ouro — comandos concretos (Ubuntu)

### 2.1 Atualização do sistema + unattended-upgrades
```bash
apt update && apt -y full-upgrade
apt install -y unattended-upgrades apt-listchanges needrestart
dpkg-reconfigure --priority=low unattended-upgrades
# /etc/apt/apt.conf.d/50unattended-upgrades: garantir a origem "${distro_id}:${distro_codename}-security";
# opcional: Unattended-Upgrade::Automatic-Reboot "true"; (com janela de reboot)
```

### 2.2 Usuário não-root + sudo
```bash
adduser deploy
usermod -aG sudo deploy
passwd -l root            # após confirmar acesso do novo usuário
# granularidade opcional via /etc/sudoers.d/
```

### 2.3 SSH (drop-in em `/etc/ssh/sshd_config.d/99-hardening.conf`)
```ini
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PermitEmptyPasswords no
MaxAuthTries 3
MaxSessions 2
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
PermitTunnel no
PermitUserEnvironment no
HostbasedAuthentication no
IgnoreRhosts yes
LogLevel VERBOSE
AllowUsers deploy
```
Validar: `sshd -t` → `systemctl reload ssh` → **testar nova sessão antes de fechar a atual**.

### 2.4 Firewall UFW (default-deny)
```bash
apt install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'        # ou porta customizada
ufw allow 80/tcp comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'
# Se houver painel em porta própria: restrinja por IP se possível
# ufw allow from <IP_ADMIN> to any port 9000 proto tcp
# E-mail (se aplicável):
ufw allow 25,587,465/tcp comment 'SMTP'
ufw allow 993/tcp comment 'IMAPS'
# ufw allow 143/tcp   # apenas se IMAP sem TLS for exigido (evitar)
ufw enable
ufw status verbose
```
⚠️ Regra de ouro: **liberar SSH antes de `ufw enable`**. Lembrar que Docker bypassa UFW (ver 1.4).

### 2.5 Fail2ban (`/etc/fail2ban/jail.local` ou `/etc/fail2ban/jail.d/custom.conf`)
```ini
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = auto
banaction = nftables-multiport
ignoreip = 127.0.0.1/8 ::1
bantime.increment = true
bantime.factor = 2
bantime.maxtime = 1w
dbpurgeage = 7d

[sshd]
enabled = true
maxretry = 3
bantime = 6h
# port = <porta custom, se houver>

[nginx-http-auth]
enabled = true

[nginx-limit-req]
enabled = true
maxretry = 10

[nginx-botsearch]
enabled = true

[postfix]
enabled = true
mode = aggressive

[postfix-sasl]
enabled = true

[dovecot]
enabled = true

[recidive]
enabled = true
bantime = 1w
findtime = 1d
```
Comandos: `fail2ban-client -t` (valida), `systemctl enable --now fail2ban`, `fail2ban-client status sshd`.
Alternativa moderna: **CrowdSec** (blocklists comunitárias + cenários de detecção comportamental).

### 2.6 Kernel/sysctl
Ver seção 1.2 — arquivo `/etc/sysctl.d/99-hardening.conf` + `sysctl --system`.

### 2.7 AppArmor
```bash
aa-status                                   # verificar perfis loaded/enforce
apt install -y apparmor-utils
aa-enforce /etc/apparmor.d/*                # colocar todos em enforce
# para perfis novos: 48h em complain mode revisando logs antes de enforce
```

### 2.8 auditd (detecção pós-invasão)
```bash
apt install -y auditd audispd-plugins
systemctl enable --now auditd
```
`/etc/audit/rules.d/hardening.rules` (essencial):
```
-w /etc/passwd -p wa -k identity
-w /etc/group -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /etc/sudoers -p wa -k sudoers_changes
-w /etc/sudoers.d/ -p wa -k sudoers_changes
-w /etc/ssh/sshd_config -p wa -k sshd_config
-w /etc/crontab -p wa -k cron
-w /etc/cron.d/ -p wa -k cron
-w /var/log/ -p wa -k logs
-a always,exit -F arch=b64 -S setuid -S setgid -S setreuid -S setregid -k privilege_escalation
-a always,exit -F arch=b64 -S init_module -S finit_module -S delete_module -k kernel_modules
```
Consulta: `ausearch -k identity -i`, `aureport --summary`.

### 2.9 AIDE (integridade de arquivos)
```bash
apt install -y aide aide-common
aideinit && mv /var/lib/aide/aide.db.new /var/lib/aide/aide.db
# rodar baseline IMEDIATAMENTE após provisionar sistema limpo;
# guardar cópia do aide.db + sha256 fora do servidor
# cron diário: aide --check | mail -s "AIDE $(hostname)" admin@...
# após updates legítimos: aide --update && mv aide.db.new aide.db
```

### 2.10 Rootkit scanners
```bash
apt install -y rkhunter chkrootkit
rkhunter --update && rkhunter --propupd     # baseline em sistema limpo!
rkhunter --check --skip-keypress --report-warnings-only
chkrootkit -q
# cron diário; revisar /var/log/rkhunter.log por "Warning"
# whitelist de falsos positivos em /etc/rkhunter.conf.local
```

### 2.11 ClamAV (malware, útil c/ e-mail e web uploads)
```bash
apt install -y clamav clamav-daemon
systemctl stop clamav-freshclam && freshclam && systemctl start clamav-freshclam
clamscan -r -i /var/www --exclude-dir="\.git"
```

### 2.12 Desabilitar serviços desnecessários
```bash
systemctl list-unit-files --state=enabled
systemctl disable --now avahi-daemon cups bluetooth ModemManager 2>/dev/null
systemctl mask avahi-daemon cups bluetooth
```

---

## 3. Ferramentas de auditoria/varredura existentes

| Ferramenta | O que detecta | Automação |
|---|---|---|
| **Lynis** (CISOfy) | 300+ checks: SSH, kernel, firewall, permissões, pacotes, logging, usuários. Gera **Hardening Index 0-100** (instalação crua: ~55-65; meta: 75-85) + warnings/suggestions parseáveis | `lynis audit system --quick`; relatório máquina-legível em `/var/log/lynis-report.dat` (`grep "^warning\[\]"`); cron semanal: `lynis audit system --cronjob` |
| **OpenSCAP + SCAP Security Guide** | Compliance formal contra CIS Level 1/2 (200+ controles), gera pass/fail por regra + script de remediação (`oscap xccdf generate fix`) | `oscap xccdf eval --profile xccdf_org.ssgproject.content_profile_cis_level1_server --report report.html /usr/share/xml/scap/ssg/content/ssg-ubuntu2404-ds.xml`. Exit 0=pass, 2=há falhas, 1=erro |
| **Ubuntu Security Guide (`usg`)** | Ferramenta da Canonical (Ubuntu Pro, grátis p/ 5 hosts) com perfis CIS exatos para 22.04/24.04 | `usg audit cis_level1_server` / `usg fix cis_level1_server` |
| **CIS Benchmarks** (PDF) | Referência normativa dos controles; base para script próprio | Usar como especificação de checks |
| **ClamAV** | Malware conhecido em arquivos | `clamscan -r -i <dir>`; freshclam automático |
| **AIDE** | Mudanças não autorizadas em arquivos (hashes/permissões) | baseline + `aide --check` via cron |
| **rkhunter / chkrootkit** | Rootkits conhecidos, binários adulterados, processos ocultos, sniffers | cron diário com `--report-warnings-only` / `-q` |
| **fail2ban / CrowdSec** | (Prevenção ativa) padrões de abuso em logs | daemon contínuo |
| **Trivy** | CVEs em imagens Docker, configs IaC, SBOM | `trivy image`, `trivy fs`, `trivy config` |
| **Docker Bench Security** | CIS Docker Benchmark | container one-shot |
| **nmap** (externo) | Portas realmente expostas | scan periódico de fora; comparar com baseline |
| **needrestart** | Serviços usando libs antigas após update | hook pós-apt |

**Recomendação para o painel:** usar **Lynis como motor principal de health-check** (saída parseável, índice quantitativo, sem agente), complementado por checks próprios simples (sshd_config efetivo via `sshd -T`, `ufw status`, `ss -tulpn`, contagem de pacotes atualizáveis). OpenSCAP/USG como camada opcional "modo compliance CIS".

---

## 4. Checklist de hardening inicial — ordem de execução

> A ordem importa para **não se trancar fora do servidor**.

**Fase 0 — Inventário (somente leitura, gera o relatório inicial do painel)**
1. `ss -tulpn` — portas escutando e processos donos
2. `systemctl list-units --type=service --state=running` e `--state=enabled`
3. `apt list --upgradable` — pacotes pendentes
4. `/etc/apt/sources.list.d/` — repositórios de terceiros
5. Usuários com shell: `awk -F: '$7 !~ /nologin|false/ {print $1}' /etc/passwd`
6. Scan externo (se possível): `nmap -sV <ip>`

**Fase 1 — Base**
7. `apt update && apt -y full-upgrade` (+ reboot se kernel novo)
8. Instalar ferramentas: `ufw fail2ban unattended-upgrades lynis auditd needrestart`
9. Configurar `unattended-upgrades` (security updates automáticos)

**Fase 2 — Acesso**
10. Criar usuário não-root, adicionar ao grupo `sudo`, **testar sudo**
11. Instalar chave SSH do usuário (`~/.ssh/authorized_keys`, `chmod 700/600`), **testar login por chave em nova sessão**
12. Aplicar drop-in de hardening SSH → `sshd -t` → reload → **testar nova sessão antes de fechar a atual**
13. `passwd -l root`

**Fase 3 — Rede**
14. UFW: default deny incoming, liberar portas necessárias (ver abaixo), **SSH primeiro**, depois `ufw enable`
15. sysctl hardening (`/etc/sysctl.d/99-hardening.conf` + `sysctl --system`)
16. Desabilitar/remover serviços desnecessários (avahi, cups, bluetooth, telnet/rsh/ftp clients)

**Fase 4 — Detecção e prevenção ativa**
17. Fail2ban com jails (sshd + nginx + postfix/dovecot conforme serviços)
18. AppArmor: verificar `aa-status`, enforce nos perfis
19. auditd com regras essenciais
20. rkhunter/chkrootkit: baseline + cron
21. AIDE: `aideinit` **agora, no sistema limpo** + cópia externa do banco

**Fase 5 — Serviços de hospedagem (conforme cenário)**
22. Nginx/Apache: TLS (certbot), headers, rate limiting, `server_tokens off`, backends em 127.0.0.1
23. (Opcional) ModSecurity + OWASP CRS em DetectionOnly → tuning → On
24. Docker: daemon.json endurecido, sem containers privilegiados, Trivy nas imagens
25. E-mail: Postfix sem open relay, AUTH só em 587/465 com TLS, Dovecot `ssl=required`, DNS SPF/DKIM/DMARC/PTR
26. Fail2ban jails específicos dos serviços instalados

**Fase 6 — Verificação final e baseline**
27. `lynis audit system` — registrar Hardening Index e tratar warnings
28. (Opcional) `usg audit cis_level1_server` ou OpenSCAP
29. Scan externo `nmap` comparando com as portas esperadas
30. Salvar baseline: `apt-mark showmanual > /etc/baseline-packages.txt`, `ss -tulpn > baseline-ports.txt`, hash de configs críticas

**Matriz de portas para o cenário do painel (web + painel + e-mail):**

| Porta | Serviço | Exposição |
|---|---|---|
| 22 (ou custom) | SSH | Aberta; idealmente restrita por IP de admin (`ufw allow from <ip>`) |
| 80 | HTTP | Aberta (redirect p/ 443 + ACME challenges) |
| 443 | HTTPS | Aberta |
| porta do painel | UI do painel | **Restrita por IP** ou atrás de auth forte + TLS; nunca exposta crua |
| 25 | SMTP (recebimento entre servidores) | Aberta **somente se** o servidor recebe e-mail; sem AUTH |
| 587 | Submission | Aberta se usuários enviam; TLS + AUTH obrigatórios |
| 465 | SMTPS | Alternativa ao 587 |
| 993 | IMAPS | Aberta se há acesso a caixas |
| 143 | IMAP | Evitar; só com `STARTTLS` obrigatório — preferir apenas 993 |
| 3306/5432/6379/27017 | DBs | **Nunca** públicas — bind em 127.0.0.1 |
| 2375/2376 | Docker API | **Nunca** públicas sem TLS+auth |
| tudo mais | — | Fechado (default deny) |

---

## 5. Minimalismo — identificar e remover pacotes desnecessários

### 5.1 Descoberta
```bash
# Pacotes manuais com prioridade optional/extra (candidatos a revisão)
apt-mark showmanual '?priority(optional) | ?priority(extra)'
# ⚠️ kernel e bootloaders aparecem aqui — NÃO remover

# Bibliotecas órfãs
apt install deborphan && deborphan

# Pacotes obsoletos (sem repositório → sem updates!)
apt list '?obsolete'

# Resíduos de config de pacotes removidos
apt list '?config-files'

# Categorias tipicamente desnecessárias em servidor
dpkg -l | grep -E 'x11|xorg|gnome|kde|wayland' | grep '^ii'
dpkg -l | grep -iE 'bluetooth|cups|printer|avahi|modemmanager'
dpkg -l | grep -E 'telnet|rsh|ftp|tftp|talk|nis' | grep '^ii'
dpkg -l | grep -E 'gcc|g\+\+|make|cmake|build-essential' | grep '^ii'   # compiladores: removê-los em produção
```

### 5.2 Remoção segura
```bash
apt -s purge <pacote>          # SIMULAR primeiro — verificar o que mais seria removido
apt purge <pacote>             # remove binários + configs
apt autoremove --purge -y      # limpa dependências órfãs + configs
apt purge $(deborphan)         # iterar até deborphan não retornar nada
apt purge '?config-files'      # limpa resíduos
apt autoclean && apt clean
```
**Nunca remover:** metapacotes `ubuntu-server`/`ubuntu-minimal`/`ubuntu-standard` (desprotege dependências no autoremove) e o kernel em execução (`uname -r`; manter 2 kernels).

### 5.3 Alvos específicos de imagens cloud Ubuntu
- **snapd**: em servidor sem snaps, pode ser removido: remover snaps na ordem correta (`snap list`), `systemctl disable --now snapd.socket snapd.service`, `apt purge snapd`, `apt-mark hold snapd`, `rm -rf /var/cache/snapd ~/snap`. Avaliar antes: algumas imagens usam snap para componentes.
- **cloud-init**: necessário no primeiro boot da VPS, dispensável depois — muitos provedores o reutilizam em rebuild; preferível **desabilitar** (`touch /etc/cloud/cloud-init.disabled`) a purgar, ou purgar com cuidado (atenção à dependência `netplan.io`).
- **avahi-daemon, cups, bluetooth, ModemManager, whoopsie, apport** (crash reporting): desabilitar/mascarar.

### 5.4 Prevenção de re-crescimento
```bash
# /etc/apt/apt.conf.d/99dependencies — não instalar Recommends/Suggests
APT::Install-Recommends "false";
APT::Install-Suggests "false";
```
Baseline e drift:
```bash
apt-mark showmanual | sort > /etc/baseline-packages.txt
diff <(apt-mark showmanual | sort) /etc/baseline-packages.txt   # detecta pacotes novos não autorizados
```

---

## 6. Recomendações de arquitetura para o painel/script de hardening

1. **Fase de scan separada da fase de fix** — rodar inventário primeiro (fase 0), exibir findings, aplicar remediações com confirmação e log de tudo.
2. **Idempotência e rollback** — cada passo deve ser re-executável; fazer backup de todo arquivo alterado (`sshd_config.backup.$(date +%F)`); para mudanças em SSH/firewall, agendar job de reversão automática (`at now +5 minutes` revertendo config) que é cancelado após o operador confirmar conectividade.
3. **Nunca travar o operador para fora**: ordem usuário→chave→teste→só então desabilitar senha/root; UFW libera SSH antes de enable.
4. **Métrica quantitativa**: expor Hardening Index do Lynis antes/depois; opcionalmente score CIS via `usg`/`oscap`.
5. **Checks próprios de baixo custo** (shell puro, sem deps): `sshd -T | grep ...`, `ufw status`, `ss -tulpn`, `awk` em `/etc/passwd`, `apt list --upgradable | wc -l`, presença de `docker.sock` montado, containers privilegiados, portas de DB expostas.
6. **Baseline pós-hardening** salvo (pacotes, portas, AIDE db, rkhunter propupd) e varreduras recorrentes via cron/systemd timer com diff contra baseline.
7. **Camadas opcionais por perfil**: `--profile web` (nginx+WAF), `--profile mail` (postfix/dovecot/jails), `--profile docker` (daemon.json+bench+trivy), `--profile cis` (usg/openscap).

## 7. Referências principais
- CIS Ubuntu Linux 22.04/24.04 LTS Benchmark (Center for Internet Security)
- Ubuntu Security Documentation — documentation.ubuntu.com/security
- Lynis / CISOfy — cisofy.com/lynis
- SCAP Security Guide / OpenSCAP — open-scap.org
- OWASP Core Rule Set — coreruleset.org
- Wiz Academy — Container Escape (2026)
- Postfix/Dovecot docs; SIDN — guia SPF/DKIM/DMARC
- Canonical Ubuntu Pro / Ubuntu Security Guide (`usg`)
- Notas de CVEs: CVE-2025-9074 (Docker API escape, CVSS 9.3), CVE-2025-26465 (OpenSSH MITM), CVE-2024-21626 (Leaky Vessels), CVE-2022-0847 (Dirty Pipe)
