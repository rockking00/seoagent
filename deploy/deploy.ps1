#Requires -Version 5.1
<#
.SYNOPSIS
  把站点和线索服务部署到 VPS（Windows 用）。

.DESCRIPTION
  依赖 Windows 自带的 OpenSSH 客户端和 tar（Win10 1803+ 都有）。
  注意：scp 的本地路径不能带盘符冒号，所以脚本先切到项目目录、只用相对路径。

.EXAMPLE
  ./deploy/deploy.ps1 -Server 203.0.113.10

.EXAMPLE
  ./deploy/deploy.ps1 -Server 203.0.113.10 -Full
  首次部署，或者改了 Caddyfile / systemd 配置时用 -Full。
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Server,

    [string]$User = "root",

    [switch]$Full
)

$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $PSScriptRoot
$target = "$User@$Server"
$archive = ".deploy-site.tgz"
$remoteScript = ".deploy-remote.sh"

if (-not (Test-Path (Join-Path $rootDir "site/index.html"))) { throw "找不到 site/index.html" }
if (-not (Test-Path (Join-Path $rootDir "deploy/vps/server.mjs"))) { throw "找不到 deploy/vps/server.mjs" }

Push-Location $rootDir
try {
    Write-Host "==> 打包 site/" -ForegroundColor Cyan
    if (Test-Path $archive) { Remove-Item $archive -Force }
    tar -czf $archive -C site .

    Write-Host "==> 上传到 $target" -ForegroundColor Cyan
    scp -q $archive "${target}:/tmp/seo-site.tgz"
    scp -q "deploy/vps/server.mjs" "${target}:/tmp/seo-server.mjs"
    scp -q "deploy/vps/scripts/leads.mjs" "${target}:/tmp/seo-leads.mjs"

    if ($Full) {
        scp -q "deploy/Caddyfile" "${target}:/tmp/seo-Caddyfile"
        scp -q "deploy/seoagent.service" "${target}:/tmp/seo-seoagent.service"
    }

    $remote = @'
set -eu

mkdir -p /srv/seoagent/site /srv/seoagent/server/data /srv/seoagent/server/scripts

rm -rf /srv/seoagent/site/*
tar -xzf /tmp/seo-site.tgz -C /srv/seoagent/site

install -m 644 /tmp/seo-server.mjs /srv/seoagent/server/server.mjs
install -m 644 /tmp/seo-leads.mjs /srv/seoagent/server/scripts/leads.mjs
chown -R seoagent:seoagent /srv/seoagent

systemctl restart seoagent
'@

    if ($Full) {
        $remote += @'

install -m 644 /tmp/seo-Caddyfile /etc/caddy/Caddyfile
install -m 644 /tmp/seo-seoagent.service /etc/systemd/system/seoagent.service
systemctl daemon-reload
systemctl enable seoagent
systemctl reload caddy 2>/dev/null || systemctl restart caddy
'@
    }

    $remote = $remote -replace "`r`n", "`n"
    [System.IO.File]::WriteAllText(
        (Join-Path $rootDir $remoteScript),
        $remote,
        (New-Object System.Text.UTF8Encoding($false))
    )

    scp -q $remoteScript "${target}:/tmp/seo-remote.sh"

    Write-Host "==> 远端执行" -ForegroundColor Cyan
    ssh $target "bash /tmp/seo-remote.sh"

    Write-Host "==> 完成，健康检查：" -ForegroundColor Green
    ssh $target "systemctl is-active seoagent; curl -s -o /dev/null -w 'api health %{http_code}\n' http://127.0.0.1:3001/api/health"
}
finally {
    Pop-Location
    Remove-Item $archive, $remoteScript -Force -ErrorAction SilentlyContinue
}
