set -e
generate_uuid_v4() {
  if [ -r /proc/sys/kernel/random/uuid ]; then cat /proc/sys/kernel/random/uuid; return; fi
  if command -v uuidgen >/dev/null 2>&1; then uuidgen | tr "A-Z" "a-z"; return; fi
  od -An -N16 -tx1 /dev/urandom | tr -d " \n" | sed -E "s/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/\1-\2-\3-\4-\5/"
}
need_opkg_update=0
for p in autossh ca-bundle libstdcpp; do opkg list-installed | grep -q "^$p" || need_opkg_update=1; done
if [ "$need_opkg_update" -eq 1 ]; then
  opkg update
  opkg list-installed | grep -q "^autossh" || opkg install autossh
  opkg list-installed | grep -q "^ca-bundle" || opkg install ca-bundle
  opkg list-installed | grep -q "^libstdcpp" || opkg install libstdcpp
fi
mkdir -p /etc/tkounter /root/.ssh
chmod 700 /root/.ssh
[ -f /etc/tkounter/node_uuid ] || generate_uuid_v4 > /etc/tkounter/node_uuid
[ -f /root/.ssh/id_ed25519 ] || dropbearkey -t ed25519 -f /root/.ssh/id_ed25519
dropbearkey -y -f /root/.ssh/id_ed25519 | grep "^ssh-ed25519" > /root/.ssh/id_ed25519.pub
[ -f /root/.ssh/id_ed25519_tunnel ] || dropbearkey -t ed25519 -f /root/.ssh/id_ed25519_tunnel
dropbearkey -y -f /root/.ssh/id_ed25519_tunnel | grep "^ssh-ed25519" > /root/.ssh/id_ed25519_tunnel.pub
