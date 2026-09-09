#!/usr/bin/env bash
# Provision the Valheim map's TLS proxy on the valence box.
#
# This box also runs the mubs tritium plane. Nothing here touches tritium:
# separate unit, separate unprivileged user, /etc/tritium made inaccessible,
# and a socket-level fence so the proxy cannot reach tritium on :8080 at all.
# Idempotent. Run with sudo. Does NOT start the service.
set -euo pipefail

BOX_IP=100.58.44.32
HOSTNAME_=100-58-44-32.sslip.io
UPSTREAM=170.23.227.3:27021
ORIGIN=https://hunter-jsb.github.io
SVC_USER=caddyvh
BIN=/usr/local/bin/caddy-valheim
CFG_DIR=/etc/caddy-valheim
DATA_DIR=/var/lib/caddyvh
UNIT=/etc/systemd/system/caddy-valheim.service

id -u "$SVC_USER" >/dev/null 2>&1 || \
  useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
install -d -o "$SVC_USER" -g "$SVC_USER" -m 0750 "$DATA_DIR"
install -d -o root -g root -m 0755 "$CFG_DIR"

# Static release binary; deliberately no apt repo / third-party key on this box.
if [ ! -x "$BIN" ]; then
  ver=$(curl -fsSL https://api.github.com/repos/caddyserver/caddy/releases/latest \
        | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -1)
  [ -n "$ver" ] || { echo "could not resolve caddy version" >&2; exit 1; }
  tmp=$(mktemp -d)
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${ver}/caddy_${ver}_linux_amd64.tar.gz" \
    -o "${tmp:?}/c.tgz"
  tar -xzf "${tmp:?}/c.tgz" -C "${tmp:?}" caddy
  install -m 0755 "${tmp:?}/caddy" "$BIN"
  rm -rf "${tmp:?}"
  echo "installed caddy v${ver}"
fi

cat > "$CFG_DIR/Caddyfile" <<EOF
{
	admin off
	persist_config off
}

https://${HOSTNAME_} {
	bind ${BOX_IP}
	encode zstd gzip
	header {
		Access-Control-Allow-Origin "${ORIGIN}"
		Access-Control-Allow-Methods "GET, OPTIONS"
		Access-Control-Max-Age "600"
		-Server
	}
	@opts method OPTIONS
	respond @opts 204
	reverse_proxy ${UPSTREAM}
}
EOF
chmod 0644 "$CFG_DIR/Caddyfile"

# --- egress fence -------------------------------------------------------
# Scoped strictly to the proxy's uid, in its own chain, so nothing else on this
# box (tritium included) is affected. Blocks loopback and the box's own address
# -- both routes to tritium's *:8080 -- while leaving systemd-resolved's DNS
# reachable so ACME can resolve Let's Encrypt.
cat > /usr/local/sbin/caddy-valheim-fence <<'FENCE'
#!/usr/bin/env bash
set -euo pipefail
IPT=/usr/sbin/iptables
IPT6=/usr/sbin/ip6tables
CHAIN=CADDYVH
UID_NAME=caddyvh
BOX=100.58.44.32

up() {
  $IPT -N "$CHAIN" 2>/dev/null || $IPT -F "$CHAIN"
  $IPT -C OUTPUT -m owner --uid-owner "$UID_NAME" -j "$CHAIN" 2>/dev/null || \
    $IPT -I OUTPUT 1 -m owner --uid-owner "$UID_NAME" -j "$CHAIN"
  $IPT -A "$CHAIN" -d 127.0.0.53/32 -p udp --dport 53 -j RETURN
  $IPT -A "$CHAIN" -d 127.0.0.53/32 -p tcp --dport 53 -j RETURN
  $IPT -A "$CHAIN" -d 127.0.0.0/8 -j REJECT
  $IPT -A "$CHAIN" -d "$BOX"/32 -j REJECT
  $IPT6 -N "$CHAIN" 2>/dev/null || $IPT6 -F "$CHAIN"
  $IPT6 -C OUTPUT -m owner --uid-owner "$UID_NAME" -j "$CHAIN" 2>/dev/null || \
    $IPT6 -I OUTPUT 1 -m owner --uid-owner "$UID_NAME" -j "$CHAIN"
  $IPT6 -A "$CHAIN" -d ::1/128 -j REJECT
}

down() {
  $IPT -D OUTPUT -m owner --uid-owner "$UID_NAME" -j "$CHAIN" 2>/dev/null || true
  $IPT -F "$CHAIN" 2>/dev/null || true; $IPT -X "$CHAIN" 2>/dev/null || true
  $IPT6 -D OUTPUT -m owner --uid-owner "$UID_NAME" -j "$CHAIN" 2>/dev/null || true
  $IPT6 -F "$CHAIN" 2>/dev/null || true; $IPT6 -X "$CHAIN" 2>/dev/null || true
}

case "${1:-}" in up) up ;; down) down ;; *) echo "usage: $0 up|down" >&2; exit 2 ;; esac
FENCE
chmod 0755 /usr/local/sbin/caddy-valheim-fence

cat > "$UNIT" <<EOF
[Unit]
Description=Caddy TLS proxy for the Valheim web map (xn-valheim; unrelated to tritium)
Documentation=https://github.com/hunter-jsb/xn-valheim
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=notify
User=${SVC_USER}
Group=${SVC_USER}
ExecStart=${BIN} run --environ --config ${CFG_DIR}/Caddyfile
ExecReload=${BIN} reload --config ${CFG_DIR}/Caddyfile --force
Restart=on-failure
RestartSec=5s

# Resource fence: must never squeeze tritium's 128M store on a 447M box.
MemoryMax=96M
MemoryHigh=80M
CPUQuota=50%
TasksMax=64

# Privilege
NoNewPrivileges=true
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE
UMask=0077
RestrictSUIDSGID=true
LockPersonality=true
RestrictNamespaces=true
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM

# Filesystem
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ReadWritePaths=${DATA_DIR}
InaccessiblePaths=/etc/tritium

# Network. NOTE: systemd's IPAddressDeny= is a SILENT NO-OP on this box --
# Debian's systemd 252 here is built -BPF_FRAMEWORK (verified). So the fence
# that stops this proxy reaching tritium on :8080 is an iptables owner-match
# chain applied/removed with the unit; see caddy-valheim-fence.
RestrictAddressFamilies=AF_INET AF_INET6
ExecStartPre=+/usr/local/sbin/caddy-valheim-fence up
ExecStopPost=+/usr/local/sbin/caddy-valheim-fence down

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
echo "provisioned caddy-valheim (NOT started; needs 80/443 open at the Lightsail firewall)"
