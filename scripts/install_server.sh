#!/bin/bash
set -e

TUNNEL_USER="tunnel"
SSHD_CONFIG="/etc/ssh/sshd_config"

echo "=== Installing tunnel server ==="

########################################
# Usuario tunnel
########################################

if ! id "$TUNNEL_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /home/$TUNNEL_USER --shell /usr/sbin/nologin "$TUNNEL_USER"
fi

########################################
# authorized_keys del usuario tunnel
########################################
# Cada nodo instala aquí su tunPubKey (lo hace el backend directamente por
# filesystem al recibir POST /api/nodes-provision, ver ensureNodeTunnelKeyInAuthorizedKeys).
# Aquí solo dejamos el directorio/archivo creado con los permisos correctos.

mkdir -p /home/$TUNNEL_USER/.ssh
touch /home/$TUNNEL_USER/.ssh/authorized_keys
touch /home/$TUNNEL_USER/.hushlogin
chmod 700 /home/$TUNNEL_USER/.ssh
chmod 600 /home/$TUNNEL_USER/.ssh/authorized_keys
chown -R $TUNNEL_USER:$TUNNEL_USER /home/$TUNNEL_USER

########################################
# sshd_config
########################################

ensure() {
  local key="$1"
  local value="$2"
  if grep -qE "^[[:space:]]*${key}[[:space:]]+" "$SSHD_CONFIG"; then
    sed -i -E "s|^[[:space:]]*${key}[[:space:]]+.*|${key} ${value}|" "$SSHD_CONFIG"
  else
    echo "${key} ${value}" >> "$SSHD_CONFIG"
  fi
}

ensure AllowTcpForwarding yes
ensure GatewayPorts yes
ensure ClientAliveInterval 30
ensure ClientAliveCountMax 3

systemctl restart ssh || systemctl restart sshd

echo "=== SERVER READY ==="