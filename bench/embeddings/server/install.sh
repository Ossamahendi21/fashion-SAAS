#!/usr/bin/env bash
# Production install for the local BGE embedding gateway. Run ONCE with sudo:
#   sudo bash /tmp/bge-deploy/install.sh
# Source layout in the staging dir: install.sh, bge_gateway.py (from
# bench/embeddings/server/), bge-gateway.service, Caddyfile.fragment.
# Lays down /opt/fashion-bge-gateway (code, venv, pinned model snapshot), the env file with a
# generated API key, and the systemd unit. Does NOT start the service, touch Docker, modify Caddy
# or touch any existing gateway/service on this box. Idempotent: re-runs keep the existing API key.
#
# Pinned revision (immutable; the service runs offline so it cannot drift):
#   BAAI/bge-small-en-v1.5       5c38ec7c405ec4b44b94cc5a9bb96e735b38267a
#
# Model weights are NEVER committed to git: they are downloaded here onto the host.
set -u

die() { echo "FATAL: $1" >&2; exit "${2:-5}"; }
[ "$(id -u)" -eq 0 ] || die "run as root (sudo bash install.sh)" 5

APP=/opt/fashion-bge-gateway
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE=/etc/bge-gateway.env
BGE_SHA=5c38ec7c405ec4b44b94cc5a9bb96e735b38267a
BGE_REPO=BAAI/bge-small-en-v1.5
MODELS_DIR="$APP/models/$BGE_SHA"

command -v python3 >/dev/null || die "python3 not found"
command -v openssl >/dev/null || die "openssl not found"
test -f "$SRC_DIR/bge_gateway.py" || die "bge_gateway.py missing beside install.sh"
test -f "$SRC_DIR/bge-gateway.service" || die "bge-gateway.service missing beside install.sh"

FREE_KB=$(df --output=avail /opt 2>/dev/null | tail -1 | tr -d ' ')
[ "${FREE_KB:-0}" -ge 2048000 ] || die "need >=2GB free under /opt (have ${FREE_KB}KB)"

id -u bge >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin bge
mkdir -p "$APP/gateway" "$APP/models"
cp "$SRC_DIR/bge_gateway.py" "$APP/gateway/bge_gateway.py"

[ -x "$APP/venv/bin/python" ] || python3 -m venv "$APP/venv" || die "venv creation failed (install python3-venv first)"
# onnxruntime + tokenizers + numpy: the B1-validated runtime, CPU only, no torch.
"$APP/venv/bin/pip" install --upgrade pip
"$APP/venv/bin/pip" install "onnxruntime==1.20.1" "tokenizers==0.20.3" "numpy<2" huggingface_hub

if [ ! -f "$ENV_FILE" ]; then
  printf 'EMBEDDING_API_KEY=%s\n' "$(openssl rand -hex 32)" > "$ENV_FILE"
  echo "generated new API key in $ENV_FILE"
else
  echo "keeping existing API key in $ENV_FILE"
fi
chown root:bge "$ENV_FILE"
chmod 640 "$ENV_FILE"

# Only the two files the gateway reads: tokenizer.json + onnx/model.onnx. No torch/transformers.
export HF_HOME="$APP/hf"
"$APP/venv/bin/python" - "$BGE_REPO" "$BGE_SHA" "$MODELS_DIR" <<'EOF'
import os
import sys
from huggingface_hub import snapshot_download

repo, sha, target = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(target, exist_ok=True)
path = snapshot_download(
    repo_id=repo,
    revision=sha,
    allow_patterns=["tokenizer.json", "onnx/model.onnx"],
    local_dir=target,
)
print(f"cached {repo}@{sha[:12]} -> {path}", flush=True)
EOF

test -f "$MODELS_DIR/onnx/model.onnx" || die "pinned onnx/model.onnx missing after download"
test -f "$MODELS_DIR/tokenizer.json" || die "pinned tokenizer.json missing after download"

cp "$SRC_DIR/bge-gateway.service" /etc/systemd/system/bge-gateway.service
chown -R bge:bge "$APP"
systemctl daemon-reload
echo "INSTALLED. Next (as operator):"
echo "  add the Caddyfile.fragment vhost, then: sudo systemctl reload caddy"
echo "  sudo systemctl enable --now bge-gateway"
echo "  sudo systemctl status bge-gateway"
echo "  sudo journalctl -u bge-gateway -f"
echo "  then set EMBEDDING_BASE_URL / EMBEDDING_API_KEY / EMBEDDING_PROVIDER=local on the deployment"