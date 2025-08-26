#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------
# release.sh  —  Simple one-shot release helper
# ---------------------------------------------
# Usage:
#   ./release.sh [patch|minor|major|<version>] [-m "commit msg"] [-t <npm-tag>] [--force]
#
# Examples:
#   ./release.sh patch
#   ./release.sh minor -m "feat: multi partition" -t beta
#   NPM_OTP=123456 ./release.sh 1.0.4
#
# Env:
#   NPM_OTP  -> one-time password for npm 2FA (optional)
# ---------------------------------------------

BUMP="${1:-patch}"
shift || true

MSG="chore(release): bump"
NPM_TAG="latest"
FORCE_PUSH="no"

# Parse simple flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--message) MSG="$2"; shift 2 ;;
    -t|--tag)     NPM_TAG="$2"; shift 2 ;;
    --force)      FORCE_PUSH="yes"; shift ;;
    *) echo "Unknown arg: $1"; exit 2 ;;
  esac
done

# Ensure we are in a git repo
git rev-parse --show-toplevel >/dev/null

# Normalize .gitignore (idempotente)
{
  echo 'node_modules/'
  echo 'dist/'
  echo 'out/'
  echo '*.tgz'
  echo '.DS_Store'
} | sort -u | tee .gitignore >/dev/null

# Untrack artefacts se servisse
git rm -r --cached node_modules dist out *.tgz 2>/dev/null || true

# Commit pending (se ci sono cambi)
if ! git diff --quiet || ! git diff --cached --quiet; then
  git add -A
  git commit -m "${MSG}"
fi

# Allinea con remoto main (se esiste)
if git ls-remote --exit-code --heads origin main >/dev/null 2>&1; then
  git fetch origin
  # rebase "pulito"; se conflitti, fermiamo con messaggio chiaro
  set +e
  git rebase origin/main
  REBASE_RC=$?
  set -e
  if [[ $REBASE_RC -ne 0 ]]; then
    echo "❌ Rebase fallito. Risolvi i conflitti e poi: git rebase --continue"
    exit 1
  fi
fi

# Build (produce dist/plugin.zip)
echo "▶️  Building…"
npm run build

# Verifica artefatto richiesto da Scrypted
test -f dist/plugin.zip || { echo "❌ dist/plugin.zip mancante"; exit 1; }

# Bump versione (patch/minor/major o esplicita)
echo "▶️  Bumping version: ${BUMP}"
npm version "${BUMP}" --no-git-tag-version

VERSION="$(node -p "require('./package.json').version")"
echo "📦 Version: v${VERSION}"

# Publish su npm
PUBLISH_CMD=(npm publish --access public --tag "${NPM_TAG}")
if [[ -n "${NPM_OTP:-}" ]]; then
  PUBLISH_CMD+=("--otp" "${NPM_OTP}")
fi
echo "▶️  Publishing to npm (tag: ${NPM_TAG})…"
"${PUBLISH_CMD[@]}"

# Commit il bump, tag e push
git add package.json package-lock.json 2>/dev/null || true
if ! git diff --quiet --cached; then
  git commit -m "chore(release): v${VERSION}"
fi

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

