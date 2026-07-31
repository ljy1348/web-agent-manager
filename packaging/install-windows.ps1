$ErrorActionPreference = "Stop"

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    Write-Error "WSL2가 필요합니다. 관리자 PowerShell에서 'wsl --install'을 실행한 뒤 다시 시도하세요."
}

$PackageVersion = (Get-Content (Join-Path $PSScriptRoot "package.json") -Raw | ConvertFrom-Json).version
Write-Host "WSL2에서 web-agent-manager v$PackageVersion 설치를 시작합니다."
& wsl.exe --cd $PSScriptRoot bash ./install.sh
if ($LASTEXITCODE -ne 0) {
    throw "web-agent-manager 설치에 실패했습니다."
}
