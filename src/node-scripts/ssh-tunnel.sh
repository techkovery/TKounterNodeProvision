#!/bin/sh
SERVER="__SERVER__"
USER="tunnel"
KEY="/root/.ssh/id_ed25519_tunnel"
PORT="__PORT__"
# Disable autossh gatetime check: without this, if the inner ssh dies twice
# before 30s (e.g. network interface not up yet at boot), autossh gives up
# permanently instead of retrying.
export AUTOSSH_GATETIME=0
exec /usr/sbin/autossh -M 0 -N -y \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ConnectTimeout=10 \
  -o ExitOnForwardFailure=yes \
  -i "$KEY" \
  -R 127.0.0.1:${PORT}:localhost:22 \
  ${USER}@${SERVER}
