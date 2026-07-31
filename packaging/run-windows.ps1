$ErrorActionPreference = "Stop"

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    Write-Error "WSL2가 필요합니다. 관리자 PowerShell에서 'wsl --install'을 실행한 뒤 다시 시도하세요."
}

& wsl.exe --cd $PSScriptRoot bash ./run.sh
if ($LASTEXITCODE -ne 0) {
    throw "web-agent-manager 실행이 종료됐습니다."
}
