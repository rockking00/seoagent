#!/usr/bin/env bash
#
# 把站点和线索服务部署到 VPS（macOS / Linux / Git Bash / CI 用）。
#
#   ./deploy/deploy.sh 203.0.113.10          # 日常更新
#   ./deploy/deploy.sh 203.0.113.10 --full   # 首次部署，或改了 Caddyfile / systemd

set -euo pipefail

SERVER="${1:-}"
FULL="${2:-}"
USER_NAME="${DEPLOY_USER:-root}"

if [ -z "$SERVER" ]; then
  echo "用法: $0 <服务器IP> [--full]" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${USER_NAME}@${SERVER}"

echo "==> 打包 site/"
tar -czf /tmp/seo-site.tgz -C "$ROOT_DIR/site" .

echo "==> 上传"
scp -q /tmp/seo-site.tgz "${TARGET}:/tmp/seo-site.tgz"
scp -q "$ROOT_DIR/deploy/vps/server.mjs" "${TARGET}:/tmp/seo-server.mjs"
scp -q "$ROOT_DIR/deploy/vps/scripts/leads.mjs" "${TARGET}:/tmp/seo-leads.mjs"

if [ "$FULL" = "--full" ]; then
  scp -q "$ROOT_DIR/deploy/Caddyfile" "${TARGET}:/tmp/seo-Caddyfile"
  scp -q "$ROOT_DIR/deploy/seoagent.service" "${TARGET}:/tmp/seo-seoagent.service"
fi

echo "==> 远端执行"
ssh "$TARGET" "bash -s" <<'EOF'
set -eu

mkdir -p /srv/seoagent/site /srv/seoagent/server/data /srv/seoagent/server/scripts

rm -rf /srv/seoagent/site/*
tar -xzf /tmp/seo-site.tgz -C /srv/seoagent/site

install -m 644 /tmp/seo-server.mjs /srv/seoagent/server/server.mjs
install -m 644 /tmp/seo-leads.mjs /srv/seoagent/server/scripts/leads.mjs
chown -R seoagent:seoagent /srv/seoagent

systemctl restart seoagent
EOF

if [ "$FULL" = "--full" ]; then
  ssh "$TARGET" "bash -s" <<'EOF'
set -eu
install -m 644 /tmp/seo-Caddyfile /etc/caddy/Caddyfile
install -m 644 /tmp/seo-seoagent.service /etc/systemd/system/seoagent.service
systemctl daemon-reload
systemctl enable seoagent
systemctl reload caddy 2>/dev/null || systemctl restart caddy
EOF
fi

echo "==> 完成"
ssh "$TARGET" "systemctl is-active seoagent && curl -s -o /dev/null -w 'health %{http_code}\n' http://127.0.0.1:3001/api/health"
