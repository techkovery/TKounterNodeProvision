#!/bin/sh
# Unified hostname/name script: writes /etc/tkounter/node_name and applies
# the derived system hostname (tk-<slug>-<uuid6>). Called during initial
# provisioning and can be invoked again later (e.g. by the tkounter binary)
# whenever the node name changes from the backend, keeping the SSH hostname
# in sync. Usage: tkounter-hostname.sh ["new node name"]
set -e
NODE_NAME="$1"
NAME_FILE="/etc/tkounter/node_name"
UUID_FILE="/etc/tkounter/node_uuid"
[ -n "$NODE_NAME" ] || { [ -f "$NAME_FILE" ] && NODE_NAME=$(cat "$NAME_FILE"); }
[ -n "$NODE_NAME" ] || { echo "Usage: $0 <node_name>" >&2; exit 1; }
[ -f "$UUID_FILE" ] || { echo "Missing $UUID_FILE" >&2; exit 1; }
NODE_UUID=$(cat "$UUID_FILE")
SHORT_UUID=$(printf "%s" "$NODE_UUID" | tr -d "-" | tr "A-Z" "a-z" | cut -c1-6)
[ -n "$SHORT_UUID" ] || { echo "Invalid node_uuid" >&2; exit 1; }
slugify() {
  printf "%s" "$1" \
    | sed -e "s/á/a/g" -e "s/à/a/g" -e "s/ä/a/g" -e "s/â/a/g" -e "s/ã/a/g" \
          -e "s/é/e/g" -e "s/è/e/g" -e "s/ë/e/g" -e "s/ê/e/g" \
          -e "s/í/i/g" -e "s/ì/i/g" -e "s/ï/i/g" -e "s/î/i/g" \
          -e "s/ó/o/g" -e "s/ò/o/g" -e "s/ö/o/g" -e "s/ô/o/g" -e "s/õ/o/g" \
          -e "s/ú/u/g" -e "s/ù/u/g" -e "s/ü/u/g" -e "s/û/u/g" \
          -e "s/ñ/n/g" -e "s/ç/c/g" \
          -e "s/Á/A/g" -e "s/À/A/g" -e "s/Ä/A/g" -e "s/Â/A/g" -e "s/Ã/A/g" \
          -e "s/É/E/g" -e "s/È/E/g" -e "s/Ë/E/g" -e "s/Ê/E/g" \
          -e "s/Í/I/g" -e "s/Ì/I/g" -e "s/Ï/I/g" -e "s/Î/I/g" \
          -e "s/Ó/O/g" -e "s/Ò/O/g" -e "s/Ö/O/g" -e "s/Ô/O/g" -e "s/Õ/O/g" \
          -e "s/Ú/U/g" -e "s/Ù/U/g" -e "s/Ü/U/g" -e "s/Û/U/g" \
          -e "s/Ñ/N/g" -e "s/Ç/C/g" \
    | tr "A-Z" "a-z" \
    | sed -r "s/[^a-z0-9]+/-/g; s/^-+//; s/-+\$//"
}
LABEL=$(slugify "$NODE_NAME")
[ -n "$LABEL" ] || LABEL="node"
MAX_LABEL_LEN=53
LABEL=$(printf "%s" "$LABEL" | cut -c1-"$MAX_LABEL_LEN" | sed -r "s/-+\$//")
[ -n "$LABEL" ] || LABEL="node"
NEW_HOSTNAME="tk-${LABEL}-${SHORT_UUID}"
printf "%s" "$NODE_NAME" > "$NAME_FILE"
if command -v uci >/dev/null 2>&1; then
  uci set system.@system[0].hostname="$NEW_HOSTNAME"
  uci commit system
fi
echo "$NEW_HOSTNAME" > /proc/sys/kernel/hostname 2>/dev/null || true
sed -i "/# tkounter-hostname/d" /etc/hosts 2>/dev/null || true
printf "127.0.0.1\t%s # tkounter-hostname\n" "$NEW_HOSTNAME" >> /etc/hosts 2>/dev/null || true
[ -x /etc/init.d/system ] && /etc/init.d/system reload >/dev/null 2>&1 || true
# Regenerate the SSH login banner so it always reflects the current name,
# uuid and hostname instead of hardcoding them (this block re-runs every
# time this script runs, i.e. on provisioning and on later rename events).
BANNER_FILE="/etc/banner"
cat > "$BANNER_FILE" <<"EOB"
------------------------------------------
 _____ _  __                 _
|_   _| |/ /___  _   _ _ __ | |_ ___ _ __
  | | | ' // _ \| | | | '_ \| __/ _ \ '__|
  | | | . \ (_) | |_| | | | | ||  __/ |
  |_| |_|\_\___/ \__,_|_| |_|\__\___|_|

------------------------------------------
TechKovery TKounter Node

EOB
printf "Name: %s\nUUID: %s\nHost: %s\n" "$NODE_NAME" "$NODE_UUID" "$NEW_HOSTNAME" >> "$BANNER_FILE"
printf -- "------------------------------------------\n" >> "$BANNER_FILE"
if command -v uci >/dev/null 2>&1 && [ -f /etc/config/dropbear ]; then
  uci set dropbear.@dropbear[0].BannerFile="$BANNER_FILE" 2>/dev/null || true
  uci commit dropbear 2>/dev/null || true
fi
echo "$NEW_HOSTNAME"
