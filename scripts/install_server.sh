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

########################################
# Clave de admin del servidor (root -> nodos)
########################################
# Par de claves para que "ssh root@localhost -p <tunnelPort>" (a través del
# túnel inverso) entre sin pedir contraseña. La privada se queda SIEMPRE en
# este servidor, en la ruta por defecto de ssh (id_ed25519), así el comando
# funciona sin -i. La pública la expone el backend (endpoint que lee este
# .pub) para que el provisionador la instale en /etc/dropbear/authorized_keys
# de cada nodo durante el provisioning. Ver scripts/backend-jobs/serverAdminKeyRoute.js.

mkdir -p /root/.ssh
chmod 700 /root/.ssh
if [ ! -f /root/.ssh/id_ed25519 ]; then
  ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N "" -q -C "tkounter-server-admin"
fi
chmod 600 /root/.ssh/id_ed25519
chmod 644 /root/.ssh/id_ed25519.pub

echo "=== SERVER READY ==="