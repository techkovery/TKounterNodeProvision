#!/usr/bin/env bash
set -euo pipefail

# Se invoca desde el hook "after:release" de release-it (ver .release-it.json), una
# vez que la versión ya está commiteada, taggeada y pusheada. Aquí solo se compila
# el instalador de Windows y se sube al update-server, igual que hace TKounterNode
# en su propio release.sh.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

VERSION="${1:?Uso: publish-release.sh <version>}"

UPDATE_SERVER_BASE_URL="https://updates.techkovery.eu/api/releases"
APP_NAME="tkounterprovision"
FLAVOR="techkovery"

# Carga RELEASE_API_KEY desde .env (no versionado) si existe
if [[ -f "$REPO_ROOT/.env" ]]; then
    set -a
    source "$REPO_ROOT/.env"
    set +a
fi

if [[ -z "${RELEASE_API_KEY:-}" ]]; then
    echo "ERROR: Falta RELEASE_API_KEY. Crea un .env en la raiz del repo con RELEASE_API_KEY=..."
    exit 1
fi

create_changelog() {
    local new_tag="$1"
    local output_path="$2"
    local prev_tag

    prev_tag="$(git -C "$REPO_ROOT" describe --tags --abbrev=0 "${new_tag}^" 2>/dev/null || true)"

    if [[ -n "$prev_tag" ]]; then
        git -C "$REPO_ROOT" log --pretty=format:"%s" "${prev_tag}..${new_tag}" \
            | grep -v '^Release ' > "$output_path"
    else
        git -C "$REPO_ROOT" log --pretty=format:"%s" "${new_tag}" \
            | grep -v '^Release ' > "$output_path"
    fi
}

echo "==> Compilando dist:win"
npm run dist:win

DIST_DIR="$REPO_ROOT/dist"
EXE_PATH="$DIST_DIR/TKounter Node Provision-Setup-${VERSION}.exe"

if [[ ! -f "$EXE_PATH" ]]; then
    echo "ERROR: No se encontro el instalador en $EXE_PATH"
    exit 1
fi

echo "==> Generando changelog"
CHANGELOG_PATH="$DIST_DIR/${APP_NAME}_${VERSION}.txt"
create_changelog "$VERSION" "$CHANGELOG_PATH"

echo "==> Abriendo changelog en vim (guarda y cierra para continuar)"
vim "$CHANGELOG_PATH"

echo "==> Subiendo instalador"
curl -f -sS -X POST \
    -H "x-api-key: $RELEASE_API_KEY" \
    -F "file=@$EXE_PATH" \
    "$UPDATE_SERVER_BASE_URL/$APP_NAME/$FLAVOR/$VERSION"

echo "==> Subiendo changelog"
curl -f -sS -X POST \
    -H "x-api-key: $RELEASE_API_KEY" \
    -F "file=@$CHANGELOG_PATH" \
    "$UPDATE_SERVER_BASE_URL/$APP_NAME/$FLAVOR/$VERSION"

echo "Release completada"
echo "- Version: $VERSION"
echo "- Instalador: $EXE_PATH"
echo "- Changelog: $CHANGELOG_PATH"
echo "- Subido a: $UPDATE_SERVER_BASE_URL/$APP_NAME/$FLAVOR/$VERSION"
