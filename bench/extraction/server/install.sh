#!/usr/bin/env bash
# Production install for the Florence+SAM2 extraction gateway. Run ONCE with sudo:
#   sudo bash /tmp/fsw-deploy/install.sh
# Source layout in the staging dir: install.sh, florencesam_gateway.py (from
# bench/extraction/server/), florencesam-gateway.service, Caddyfile.fragment.
# Lays down /opt/fashion-florencesam (code, venvs, model cache), the env file with a
# generated API key, and the systemd unit. Does NOT start the service, touch Docker,
# or modify Caddy/app code. Idempotent: re-runs keep the existing API key.
#
# Pinned revisions (immutable; the service runs offline so they cannot drift):
#   microsoft/Florence-2-base      5ca5edf5bd017b9919c05d08aebef5e4c7ac3bac
#   facebook/sam2.1-hiera-tiny     de431c4043854a71d8101e17995dfe596bf101a5
set -u

die() { echo "FATAL: $1" >&2; exit "${2:-5}"; }
[ "$(id -u)" -eq 0 ] || die "run as root (sudo bash install.sh)" 5

APP=/opt/fashion-florencesam
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE=/etc/florencesam-gateway.env
FLORENCE_SHA=5ca5edf5bd017b9919c05d08aebef5e4c7ac3bac
SAM_SHA=de431c4043854a71d8101e17995dfe596bf101a5

command -v python3 >/dev/null || die "python3 not found"
command -v openssl >/dev/null || die "openssl not found"
test -f "$SRC_DIR/florencesam_gateway.py" || die "florencesam_gateway.py missing beside install.sh"
test -f "$SRC_DIR/florencesam-gateway.service" || die "florencesam-gateway.service missing beside install.sh"

FREE_KB=$(df --output=avail /opt 2>/dev/null | tail -1 | tr -d ' ')
[ "${FREE_KB:-0}" -ge 10485760 ] || die "need >=10GB free under /opt (have ${FREE_KB}KB)"

id -u florencesam >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin florencesam
mkdir -p "$APP/gateway" "$APP/hf-hub/modules"
cp "$SRC_DIR/florencesam_gateway.py" "$APP/gateway/florencesam_gateway.py"

for VENV in venv-flor venv-sam; do
  [ -x "$APP/$VENV/bin/python" ] || python3 -m venv "$APP/$VENV" || die "venv creation failed (install python3-venv first)"
done

"$APP/venv-flor/bin/pip" install --index-url https://download.pytorch.org/whl/cpu torch torchvision
"$APP/venv-flor/bin/pip" install "transformers==4.44.2" timm einops pillow numpy
SITE_FLOR=$("$APP/venv-flor/bin/python" -c "import sysconfig; print(sysconfig.get_paths()['purelib'])")
grep -q 'tokenizers>=0.19,<0.23' "$SITE_FLOR/transformers/dependency_versions_table.py" 2>/dev/null \
  || sed -i 's/"tokenizers>=0.19,<0.20"/"tokenizers>=0.19,<0.23"/' \
    "$SITE_FLOR/transformers/dependency_versions_table.py"
grep -q 'huggingface-hub>=0.23.2,<2.0' "$SITE_FLOR/transformers/dependency_versions_table.py" 2>/dev/null \
  || sed -i 's/"huggingface-hub>=0.23.2,<1.0"/"huggingface-hub>=0.23.2,<2.0"/' \
    "$SITE_FLOR/transformers/dependency_versions_table.py"
mkdir -p "$SITE_FLOR/flash_attn"
cat > "$SITE_FLOR/flash_attn/__init__.py" <<'EOF'
# Bench/prod import-scan stub. Never executed: guarded off on CPU by
# is_flash_attn_2_available() == False.
EOF
cat > "$SITE_FLOR/flash_attn/bert_padding.py" <<'EOF'
# Bench/prod import-scan stub. Never executed at runtime.
def flash_attn_func(*a, **k): raise RuntimeError("stub")
def flash_attn_varlen_func(*a, **k): raise RuntimeError("stub")
def index_first_axis(*a, **k): raise RuntimeError("stub")
def pad_input(*a, **k): raise RuntimeError("stub")
def unpad_input(*a, **k): raise RuntimeError("stub")
EOF

"$APP/venv-sam/bin/pip" install --index-url https://download.pytorch.org/whl/cpu torch torchvision
"$APP/venv-sam/bin/pip" install "transformers==5.14.1" pillow numpy

if [ ! -f "$ENV_FILE" ]; then
  printf 'FLORENCESAM_API_KEY=%s\n' "$(openssl rand -hex 32)" > "$ENV_FILE"
  echo "generated new API key in $ENV_FILE"
else
  echo "keeping existing API key in $ENV_FILE"
fi
chown root:florencesam "$ENV_FILE"
chmod 640 "$ENV_FILE"

export HF_HUB_CACHE="$APP/hf-hub"
"$APP/venv-flor/bin/python" - "$FLORENCE_SHA" "$SAM_SHA" <<'EOF'
import sys
from huggingface_hub import snapshot_download
for repo, sha in [("microsoft/Florence-2-base", sys.argv[1]),
                  ("facebook/sam2.1-hiera-tiny", sys.argv[2])]:
    path = snapshot_download(repo_id=repo, revision=sha)
    print(f"cached {repo}@{sha[:12]} -> {path}", flush=True)
EOF
test -d "$APP/hf-hub/models--microsoft--Florence-2-base/snapshots/$FLORENCE_SHA" \
  || die "Florence snapshot missing after download"
test -d "$APP/hf-hub/models--facebook--sam2.1-hiera-tiny/snapshots/$SAM_SHA" \
  || die "SAM2 snapshot missing after download"

cp "$SRC_DIR/florencesam-gateway.service" /etc/systemd/system/florencesam-gateway.service
chown -R florencesam:florencesam "$APP"
systemctl daemon-reload
echo "INSTALLED. Next (as operator):"
echo "  add the Caddyfile.fragment vhost, then: sudo systemctl reload caddy"
echo "  sudo systemctl enable --now florencesam-gateway"
echo "  sudo systemctl status florencesam-gateway"
echo "  sudo journalctl -u florencesam-gateway -f"
