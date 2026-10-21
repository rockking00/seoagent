#!/usr/bin/env bash
#
# 全新的 Vultr VPS（Debian 12 / Ubuntu 24.04）上跑一次。
#   curl -fsSL .../bootstrap.sh | bash     或者   bash deploy/bootstrap.sh
#
# 它会装好：Node 24、Caddy、1GB swap、earlyoom，建好目录和用户。
# 不会碰你的域名和证书，那是部署 Caddyfile 之后的事。

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行：sudo bash $0" >&2
  exit 1
fi

echo "==> 安装基础依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg apt-transport-https rsync earlyoom

echo "==> 安装 Node.js 24"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
echo "    node $(node -v)"

echo "==> 安装 Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi
echo "    caddy $(caddy version | head -n1)"

echo "==> 建用户和目录"
if ! id seoagent >/dev/null 2>&1; then
  useradd --system --home /srv/seoagent --shell /usr/sbin/nologin seoagent
fi
mkdir -p /srv/seoagent/site /srv/seoagent/server/data /var/log/caddy
chown -R seoagent:seoagent /srv/seoagent
chown -R caddy:caddy /var/log/caddy 2>/dev/null || true
chmod 750 /srv/seoagent/server/data

echo "==> 配置 1GB swap（512MB 内存的保命设置）"
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  echo "    swap 已开启"
else
  echo "    swap 已存在，跳过"
fi

echo "==> 调低 swappiness"
echo 'vm.swappiness=10' >/etc/sysctl.d/99-swappiness.conf
sysctl --system >/dev/null

echo "==> 启用 earlyoom（内存快满时先杀小进程，别把整机拖死）"
systemctl enable --now earlyoom >/dev/null 2>&1 || true

cat <<'EOF'

==> 完成。接下来：

  1. 本地改好 deploy/Caddyfile 里的域名和邮箱
  2. 在本地跑：  ./deploy/deploy.ps1 -Server <服务器IP> -Full
  3. 域名 A 记录指向这台机器，等 DNS 生效
  4. 打开 https://你的域名，提交一次表单试试

  记得在 Vultr 控制台的 Firewall 里放行 22 / 80 / 443。
EOF
