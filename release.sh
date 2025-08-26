#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------
# release.sh — Release helper (anon commits)
# ---------------------------------------------
# Usage:
#   ./release.sh [patch|minor|major|<version>] [-m "commit msg"] [-t <npm-tag>] [--force]
#
# Env:
#   NPM_OTP -> one-time password for npm 2FA (optional)
# ---------------------------------------------

BUMP="${1:-patch}"
shift || true

MSG="chore(release): bump"
NPM_TAG="latest"
FORCE_PUSH="no"

# === Identità ANONIMA per i commit/tag di questo script ===
# Suggerito: abilita su GitHub "Keep my email addresses private" e usa la tua noreply:
#   <id>+<user>@users.noreply.github.com   oppure   <user>@users.noreply.github.com
ANON_NAME="mrMiimo"
ANON_EMAIL="mrMiimo@users.noreply.github.com"

# Applica l'identità solo alle operazioni di questo script:
export GIT_AUTHOR_NAME="${ANON_NAME}"
export GIT_AUTHOR_EMAIL="${ANON_EMAIL}"
export GIT_COMMITTER_NAME="${ANON_NAME}"
export GIT_COMMITTER_EMAIL="${ANON_EMAIL}"

# Parse flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--message) MSG="$2"; shift 2 ;;
    -t|--tag)     NPM_TAG="$2"; shift 2 ;;
    --force)      FORCE_PUSH="yes"; shift ;;
    *) echo "Unknown arg: $1"; exit 2 ;;
  esac
done

git rev-parse --show-toplevel >/dev/null

# .gitignore (idempotente)
{
  echo 'node_modules/'
  echo 'dist/'
  echo 'out/'
  echo '*.tgz'
  echo '.DS_Store'
} | sort -u | tee .gitignore >/dev/null

git rm -r --cached node_modules dist out *.tgz 2>/dev/null || true

# Commit pending (se ci sono modifiche)
if ! git diff --quiet || ! git diff --cached --quiet; then
  git add -A
  git commit -m "${MSG}"
fi

# Allinea a origin/main se esiste
if git ls-remote --exit-code --heads origin main >/dev/null 2>&1; then
  git fetch origin
  set +e
  git rebase origin/main
  RC=$?
  set -e
  if [[ $RC -ne 0 ]]; then
    echo "❌ Rebase fallito. Risolvi conflitti e poi: git rebase --continue"
    exit 1
  fi
fi

# Build (crea dist/plugin.zip)
echo "▶️  Building…"
npm run build
test -f dist/plugin.zip || { echo "❌ dist/plugin.zip mancante"; exit 1; }

# Bump versione
echo "▶️  Bumping version: ${BUMP}"
npm version "${BUMP}" --no-git-tag-version
VERSION="$(node -p "require('./package.json').version")"
echo "📦 Version: v${VERSION}"

# Publish npm
PUBLISH_CMD=(npm publish --access public --tag "${NPM_TAG}")
if [[ -n "${NPM_OTP:-}" ]]; then
  PUBLISH_CMD+=("--otp" "${NPM_OTP}")
fi
echo "▶️  Publishing to npm (tag: ${NPM_TAG})…"
"${PUBLISH_CMD[@]}"

# Commit del bump (se necessario), tag e push
git add package.json package-lock.json 2>/dev/null || true
if ! git diff --quiet --cached; then
  git commit -m "chore(release): v${VERSION}"
fi

# Il tag userà ANON_NAME/ANON_EMAIL perché già esportati sopra
git tag -a "v${VERSION}" -m "release v${VERSION}"

if [[ "${FORCE_PUSH}" == "yes" ]]; then
  git push --force-with-lease -u origin main
else
  git push -u origin main
fi
git push origin "v${VERSION}"

echo "✅ Done!
- GitHub: pushed main + tag v${VERSION}
- npm: @$(node -p "require('./package.json').name")@${VERSION} (tag ${NPM_TAG})"

