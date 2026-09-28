# web-agent-manager Windows 네이티브 노드 설치 (#145)
# WSL 없이 Windows에서 WAM 서버를 설치·설정하고 실행한다. 그 PC의 Claude 앱·Codex 앱 대화를 메인 WAM에서 보려면
# 이 노드를 메인 WAM의 "컴퓨터 연결"에 등록한다. WSL2로 설치하려면 기존 setup-windows.cmd를 쓴다.
# PowerShell 5.1(Windows 기본)에서 한글이 깨지지 않도록 이 파일은 UTF-8 BOM으로 저장한다.
param(
    [switch]$NoStart,          # 설치·설정만 하고 서버는 시작하지 않는다
    [switch]$Reconfigure       # 기존 설정 파일이 있어도 접속 범위·포트를 다시 묻는다
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 배포 zip에서는 이 파일 옆에 package.json이 있고, git 저장소에서는 packaging\ 안에 있으므로 한 단계 위가 앱 루트다.
function Get-AppRoot {
    if (Test-Path (Join-Path $PSScriptRoot "package.json")) { return $PSScriptRoot }
    return (Split-Path $PSScriptRoot -Parent)
}

function Write-Step([string]$Message) { Write-Host ""; Write-Host "== $Message" -ForegroundColor Cyan }

# 예/아니오 질문. 기본값은 Enter로 선택된다.
function Confirm-Choice([string]$Question, [bool]$Default = $true) {
    $suffix = if ($Default) { "[Y/n]" } else { "[y/N]" }
    $answer = Read-Host "$Question $suffix"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    return $answer.Trim().ToLower().StartsWith("y")
}

# winget 설치 직후 새 PATH가 현재 창에 반영되도록 레지스트리에서 다시 읽는다.
function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ";"
}

function Test-NodeVersion {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { return $false }
    $major = [int]((& node.exe -p "process.versions.node.split('.')[0]").Trim())
    return $major -ge 22
}

# 필수 도구가 없으면 사용자 동의를 받아 winget으로 설치한다. winget이 없으면 설치 주소를 안내하고 멈춘다.
function Install-WithWinget([string]$Name, [string]$WingetId, [string]$ManualUrl) {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw "$Name 이(가) 필요합니다. $ManualUrl 에서 설치한 뒤 이 스크립트를 다시 실행하세요."
    }
    if (-not (Confirm-Choice "$Name 이(가) 없습니다. winget으로 설치할까요?")) {
        throw "$Name 이(가) 필요합니다. $ManualUrl 에서 설치한 뒤 다시 실행하세요."
    }
    & winget.exe install --id $WingetId -e --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "$Name 설치에 실패했습니다. $ManualUrl 에서 직접 설치하세요." }
    Update-SessionPath
}

# 메인 WAM이 이 PC에 붙을 때 쓸 주소 후보: Tailscale IPv4 → 사설 IPv4 순서.
function Get-SuggestedAddress {
    $tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
    if ($tailscale) {
        try {
            $ip = (& tailscale.exe ip -4 2>$null | Select-Object -First 1)
            if ($ip -and $ip.Trim()) { return $ip.Trim() }
        } catch { }
    }
    try {
        $private = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)' } |
            Select-Object -First 1
        if ($private) { return $private.IPAddress }
    } catch { }
    return "127.0.0.1"
}

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$Root = Get-AppRoot
Set-Location $Root
$ConfigPath = Join-Path $Root "windows-node.json"
$PackageVersion = (Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json).version
Write-Host "web-agent-manager v$PackageVersion Windows 네이티브 노드 설치를 시작합니다."
Write-Host "앱 폴더: $Root"

Write-Step "필수 도구 확인"
if (-not (Test-NodeVersion)) {
    Install-WithWinget "Node.js 22 이상" "OpenJS.NodeJS.LTS" "https://nodejs.org/"
    if (-not (Test-NodeVersion)) { throw "Node.js 22 이상이 필요합니다. 설치 후 새 PowerShell 창에서 다시 실행하세요." }
}
Write-Host "Node.js $((& node.exe --version).Trim())"
if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    # Git은 브랜치·변경사항 화면에 필요하지만 대화 보기만 할 때는 없어도 된다.
    try { Install-WithWinget "Git" "Git.Git" "https://git-scm.com/download/win" } catch { Write-Warning $_.Exception.Message }
}
foreach ($cli in @("claude", "codex")) {
    if (-not (Get-Command $cli -ErrorAction SilentlyContinue)) { Write-Host "참고: $cli CLI가 PATH에 없습니다. 기존 대화 보기는 되지만 이어서 작업하기에는 필요합니다." -ForegroundColor Yellow }
}

Write-Step "의존성 설치"
# lockfile을 지키는 npm ci만 쓴다. 배포 zip은 dist가 이미 빌드돼 있고, git 저장소는 소스에서 빌드한다.
if (Test-Path (Join-Path $Root "dist/server/src/server/index.js")) {
    & npm.cmd ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw "의존성 설치(npm ci --omit=dev)에 실패했습니다. 위 오류를 확인하세요." }
} else {
    Write-Host "빌드된 dist가 없어 소스에서 빌드합니다."
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw "의존성 설치(npm ci)에 실패했습니다." }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "빌드(npm run build)에 실패했습니다." }
}

Write-Step "접속 설정"
$config = $null
if ((Test-Path $ConfigPath) -and -not $Reconfigure) {
    $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    Write-Host "기존 설정을 사용합니다: $ConfigPath (다시 설정하려면 -Reconfigure)"
} else {
    $port = Read-Host "포트 [4317]"
    if ([string]::IsNullOrWhiteSpace($port)) { $port = "4317" }
    if ($port -notmatch '^\d{2,5}$') { throw "포트는 숫자여야 합니다." }
    Write-Host "메인 WAM이 이 PC를 '컴퓨터 연결'로 붙이려면 다른 컴퓨터에서 접속할 수 있어야 합니다."
    $remote = Confirm-Choice "사설망·Tailscale의 다른 컴퓨터에서 접속을 허용할까요? (아니오면 이 PC에서만 접속)"
    if ($remote) {
        $suggested = Get-SuggestedAddress
        $address = Read-Host "메인 WAM이 이 PC에 접속할 주소 [$suggested]"
        if ([string]::IsNullOrWhiteSpace($address)) { $address = $suggested }
        $config = [ordered]@{ host = "0.0.0.0"; port = [int]$port; publicUrl = "http://${address}:$port"; dataDir = (Join-Path $Root "data") }
    } else {
        $config = [ordered]@{ host = "127.0.0.1"; port = [int]$port; publicUrl = "http://127.0.0.1:$port"; dataDir = (Join-Path $Root "data") }
    }
    ($config | ConvertTo-Json) | Set-Content -Path $ConfigPath -Encoding UTF8
    $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    Write-Host "설정 저장: $ConfigPath"
}
New-Item -ItemType Directory -Force -Path $config.dataDir | Out-Null

if ($config.host -eq "0.0.0.0") {
    $ruleName = "web-agent-manager $($config.port)"
    $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if (-not $existing) {
        # 방화벽 규칙은 관리자 권한이 필요하다. 사설망 프로필에서만 연다(공용 Wi-Fi 등에서는 열지 않음).
        $command = "New-NetFirewallRule -DisplayName '$ruleName' -Direction Inbound -Protocol TCP -LocalPort $($config.port) -Action Allow -Profile Private"
        if (Test-Administrator) {
            if (Confirm-Choice "Windows 방화벽에서 사설망의 TCP $($config.port) 포트를 열까요?") { Invoke-Expression $command | Out-Null; Write-Host "방화벽 규칙을 추가했습니다." }
        } else {
            Write-Host "다른 컴퓨터에서 접속이 안 되면 관리자 PowerShell에서 다음을 실행하세요:" -ForegroundColor Yellow
            Write-Host "  $command"
        }
    }
}

Write-Step "관리자 계정"
$env:WEB_AGENT_MANAGER_DATA_DIR = $config.dataDir
# 데이터 DB가 이미 있으면 이전 설치의 관리자가 있을 가능성이 높아 기본값을 "추가하지 않음"으로 둔다.
$hasDatabase = Test-Path (Join-Path $config.dataDir "web-agent-manager.sqlite")
if ($hasDatabase -and -not (Confirm-Choice "기존 데이터가 있습니다. 관리자 계정을 새로 추가할까요?" $false)) {
    Write-Host "기존 관리자 계정을 사용합니다."
} else {
    # 무인 설치: 두 환경변수가 미리 있으면 묻지 않는다(create-admin.js와 같은 변수). 없으면 대화형으로 받는다.
    $presetPassword = $env:WEB_AGENT_MANAGER_ADMIN_PASSWORD
    $username = if ($env:WEB_AGENT_MANAGER_ADMIN_USERNAME -and $presetPassword) { $env:WEB_AGENT_MANAGER_ADMIN_USERNAME } else { Read-Host "관리자 아이디" }
    $bstr = [IntPtr]::Zero
    try {
        # 비밀번호는 관리자 생성 프로세스 환경에만 잠깐 넘기고 바로 지운다.
        if (-not $presetPassword) {
            $secure = Read-Host "관리자 비밀번호(12자 이상)" -AsSecureString
            $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            $presetPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        }
        $env:WEB_AGENT_MANAGER_ADMIN_USERNAME = $username
        $env:WEB_AGENT_MANAGER_ADMIN_PASSWORD = $presetPassword
        & node.exe (Join-Path $Root "dist/server/scripts/create-admin.js")
        if ($LASTEXITCODE -ne 0) { throw "관리자 계정 생성에 실패했습니다." }
    } finally {
        if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        $presetPassword = $null
        Remove-Item Env:WEB_AGENT_MANAGER_ADMIN_USERNAME -ErrorAction SilentlyContinue
        Remove-Item Env:WEB_AGENT_MANAGER_ADMIN_PASSWORD -ErrorAction SilentlyContinue
    }
}

Write-Step "자동 시작"
$startup = [Environment]::GetFolderPath("Startup")
$shortcutPath = if ($startup) { Join-Path $startup "web-agent-manager.lnk" } else { $null }
if (-not $shortcutPath) {
    Write-Host "시작 프로그램 폴더를 찾지 못해 자동 시작은 건너뜁니다. 필요하면 run-windows-native.cmd를 직접 실행하세요." -ForegroundColor Yellow
} elseif (Test-Path $shortcutPath) {
    Write-Host "로그온 자동 시작이 이미 설정되어 있습니다: $shortcutPath"
} elseif (Confirm-Choice "Windows에 로그온하면 WAM 서버를 자동으로 시작할까요?") {
    # 관리자 권한이 필요 없는 시작 프로그램 폴더 바로가기. 창은 최소화된 상태로 뜬다.
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = "powershell.exe"
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$(Join-Path $PSScriptRoot 'run-windows-native.ps1')`""
    $shortcut.WorkingDirectory = $Root
    $shortcut.WindowStyle = 7
    $shortcut.Save()
    Write-Host "자동 시작을 설정했습니다. 끄려면 이 파일을 지우세요: $shortcutPath"
}

Write-Step "설치 완료"
Write-Host "WAM 주소: $($config.publicUrl)"
Write-Host "메인 WAM에 이 PC를 연결하려면:"
Write-Host "  1. 이 PC의 WAM($($config.publicUrl))에 로그인 → 설정 → 운영 → 컴퓨터 연결 → '이 컴퓨터의 연결 토큰 만들기'"
Write-Host "  2. 메인 WAM의 같은 화면에서 '다른 컴퓨터 추가'에 이 주소와 토큰을 입력"
Write-Host "다시 실행: run-windows-native.cmd"

if (-not $NoStart) {
    Write-Step "서버 시작"
    & (Join-Path $PSScriptRoot "run-windows-native.ps1")
}
