# web-agent-manager Windows 네이티브 노드 실행 (#145)
# setup-windows-native.ps1이 만든 windows-node.json의 접속 설정으로 서버를 실행한다.
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Root = if (Test-Path (Join-Path $PSScriptRoot "package.json")) { $PSScriptRoot } else { Split-Path $PSScriptRoot -Parent }
Set-Location $Root
$ConfigPath = Join-Path $Root "windows-node.json"
if (-not (Test-Path $ConfigPath)) { throw "설정 파일이 없습니다. 먼저 setup-windows-native.cmd를 실행하세요." }
if (-not (Test-Path (Join-Path $Root "dist/server/src/server/index.js"))) { throw "서버 파일이 없습니다. setup-windows-native.cmd로 다시 설치하세요." }
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw "Node.js를 찾을 수 없습니다. setup-windows-native.cmd로 다시 설치하세요." }
$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json

# 같은 포트에 이미 서버가 떠 있으면(자동 시작 등) 두 번 띄우지 않는다.
$listening = Get-NetTCPConnection -LocalPort $config.port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    Write-Host "포트 $($config.port)에서 이미 서버가 실행 중입니다: $($config.publicUrl)"
    exit 0
}

$env:NODE_ENV = "production"
$env:WEB_AGENT_MANAGER_HOST = $config.host
$env:WEB_AGENT_MANAGER_PORT = [string]$config.port
$env:WEB_AGENT_MANAGER_PUBLIC_URL = $config.publicUrl
$env:WEB_AGENT_MANAGER_DATA_DIR = $config.dataDir
Write-Host "web-agent-manager: $($config.publicUrl)"
Write-Host "이 창을 닫으면 서버가 멈춥니다."
& node.exe (Join-Path $Root "dist/server/src/server/index.js")
exit $LASTEXITCODE
