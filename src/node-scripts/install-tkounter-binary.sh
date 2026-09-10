# Downloads the manifest for UPDATES_APP/UPDATES_FLAVOR, fetches the
# artifact it points to and installs the tkounter binary. Expects
# UPDATES_BASE_URL, UPDATES_APP and UPDATES_FLAVOR to already be exported as
# shell variables by the caller.
download_to_file() {
  url="$1"; out="$2"
  if command -v uclient-fetch >/dev/null 2>&1; then uclient-fetch -q -O "$out" "$url"; else wget -q -O "$out" "$url"; fi
}
MANIFEST_FILE="/tmp/tkounter-update/manifest.json"
ARTIFACT_FILE="/tmp/tkounter-update/update.tar.gz"
EXTRACT_DIR="/tmp/tkounter-update/extract"
download_to_file "$UPDATES_BASE_URL/updates/$UPDATES_APP/$UPDATES_FLAVOR/manifest" "$MANIFEST_FILE"
if command -v jsonfilter >/dev/null 2>&1; then
  DOWNLOAD_URL="$(jsonfilter -i "$MANIFEST_FILE" -e "@.artifact.download_url")"
else
  DOWNLOAD_URL="$(sed -n "s/.*\"download_url\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$MANIFEST_FILE" | head -n1)"
fi
[ -n "$DOWNLOAD_URL" ] || { echo "Missing download_url"; exit 1; }
download_to_file "$DOWNLOAD_URL" "$ARTIFACT_FILE"
rm -rf "$EXTRACT_DIR" && mkdir -p "$EXTRACT_DIR"
tar -xzf "$ARTIFACT_FILE" -C "$EXTRACT_DIR"
[ -f "$EXTRACT_DIR/tkounter" ] || { echo "Missing tkounter binary in artifact"; exit 1; }
cp "$EXTRACT_DIR/tkounter" /overlay/tkounter/tkounter
chmod 0755 /overlay/tkounter/tkounter
