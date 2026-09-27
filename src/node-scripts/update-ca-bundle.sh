#!/bin/sh
# Keeps the node's CA trust store current via opkg, run periodically by cron
# (see /etc/crontabs/root). Without this, a future CA/root rotation on the
# server certificate (e.g. Sectigo switching intermediates) can leave nodes
# unable to validate HTTPS even though the server's certificate is fine -
# see the 2026-09 Sectigo R46 incident.
LOG=/var/log/tkounter-ca-bundle-update.log
{
    echo "=== $(date -Iseconds) ==="
    opkg update && opkg upgrade ca-bundle
} >> "$LOG" 2>&1
