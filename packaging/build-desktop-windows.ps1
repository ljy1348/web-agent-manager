# web-agent-manager Windows 데스크톱 앱(exe) 직접 빌드 (#156)
# GitHub Actions(release-desktop.yml)의 Windows 빌드 단계를 이 PC에서 그대로 실행한다: npm ci → npm run build →
# 서버용 node.exe 복사 → electron-builder --win. 결과는 release\desktop\ 아래 설치형 exe와 압축만 풀면 되는 zip이다.
# 배포 zip이 아니라 git clone 또는 GitHub 소스 zip(전체 소스) 폴더에서 실행해야 한다. PowerShell 5.1용으로 UTF-8 BOM으로 저장한다.
param(
    [switch]$SkipInstall,      # 이미 npm ci를 마쳤으면 의존성 설치를 건너뛴다
    [switch]$DirOnly,          # 테스트용: 설치 파일·zip 압축 없이 release\desktop\win-unpacked만 만든다(빠름)
    [switch]$ServerOnly        # 테스트용: 서버·웹 코드만 다시 빌드해 기존 win-unpacked에 덮어쓴다(가장 빠름, electron\ 변경은 반영 안 됨)
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Write-Step([string]$Message) { Write-Host ""; Write-Host "== $Message" -ForegroundColor Cyan }

# 외부 명령을 실행하고 실패하면 단계 이름과 함께 멈춘다.
function Invoke-Checked([string]$Step, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Step 단계가 실패했습니다(종료 코드 $LASTEXITCODE). 위 메시지를 확인하세요." }
}

$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root

Write-Step "소스 폴더 확인"
foreach ($required in @("package.json", "package-lock.json", "electron\main.cjs", "src")) {
    if (-not (Test-Path (Join-Path $Root $required))) {
        throw "$required 이(가) 없습니다. 배포 zip이 아니라 git clone·GitHub 소스 zip 폴더의 packaging\build-desktop-windows.cmd로 실행하세요."
    }
}
Write-Host "폴더: $Root"
# 브랜치·커밋 표시는 안내용이다. GitHub 소스 zip으로 받으면 .git이 없으므로 건너뛴다.
# PowerShell 5.1은 Stop 설정에서 네이티브 명령의 stderr를 리디렉션하면 오류로 바꾸므로, 실패해도 빌드를 멈추지 않는다.
if ((Test-Path (Join-Path $Root ".git")) -and (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    try {
        $branch = (& git.exe rev-parse --abbrev-ref HEAD 2>$null)
        $commit = (& git.exe log -1 --format="%h %s" 2>$null)
        Write-Host "브랜치: $branch"
        Write-Host "커밋: $commit"
    } catch { Write-Host "git 정보를 읽지 못했습니다(빌드와 무관)." }
} else {
    Write-Host "git 저장소가 아닙니다(소스 zip). 브랜치 표시만 건너뜁니다."
}

Write-Step "Node.js 확인"
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js 22 이상이 필요합니다. https://nodejs.org 에서 LTS를 설치하거나 'winget install OpenJS.NodeJS.LTS' 후 새 창에서 다시 실행하세요." }
$major = [int]((& node.exe -p "process.versions.node.split('.')[0]").Trim())
if ($major -lt 22) { throw "Node.js $major 버전입니다. 22 이상이 필요합니다." }
if ((& node.exe -p "process.arch").Trim() -ne "x64") { throw "x64 Node.js가 필요합니다(설치 파일에 같은 node.exe를 넣습니다)." }
# Volta·nvm 등은 PATH의 node.exe가 대리 실행 파일(shim)이므로, 설치 파일에는 실제 실행 파일 경로를 넣는다.
$realNode = (& node.exe -p "process.execPath").Trim()
if (-not (Test-Path $realNode)) { throw "실제 node.exe 경로를 찾지 못했습니다: $realNode" }
Write-Host "node: $realNode ($(& node.exe --version))"
if ($realNode -ne $node.Source) { Write-Host "(PATH의 $($node.Source)는 대리 실행 파일이라 실제 경로를 씁니다)" }

if (-not $SkipInstall) {
    Write-Step "의존성 설치 (npm ci)"
    Invoke-Checked "npm ci" { & npm.cmd ci }
}

Write-Step "웹·서버 빌드 (npm run build)"
Invoke-Checked "npm run build" { & npm.cmd run build }

# 서버·웹 파일은 asarUnpack으로 앱 패키지 밖(resources\app.asar.unpacked\dist)에 풀려 있어 그 폴더만 바꾸면 된다.
if ($ServerOnly) {
    $unpackedDist = Join-Path $Root "release\desktop\win-unpacked\resources\app.asar.unpacked\dist"
    if (-not (Test-Path $unpackedDist)) { throw "기존 win-unpacked가 없습니다. 먼저 -DirOnly 또는 전체 빌드를 한 번 하세요." }
    if (Get-Process web-agent-manager -ErrorAction SilentlyContinue) { throw "web-agent-manager가 실행 중입니다. 트레이의 '종료'로 끈 뒤 다시 실행하세요(파일이 잠겨 있음)." }
    Write-Step "서버·웹 코드만 교체"
    Remove-Item $unpackedDist -Recurse -Force
    Copy-Item (Join-Path $Root "dist") $unpackedDist -Recurse
    Write-Host "교체함: $unpackedDist"
    Write-Host "release\desktop\win-unpacked\web-agent-manager.exe를 실행하세요."
    return
}

# 설치된 앱이 Node 설치 없이 서버를 띄우도록, 네이티브 모듈을 설치한 바로 그 node.exe를 넣는다(버전 일치).
Write-Step "서버용 node.exe 포함"
$nodeDir = Join-Path $Root "build-resources\win-node"
New-Item -ItemType Directory -Force $nodeDir | Out-Null
Copy-Item $realNode (Join-Path $nodeDir "node.exe") -Force
Write-Host "복사함: $realNode"

Write-Step "설치 파일 만들기 (electron-builder --win)"
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
if ($DirOnly) {
    Invoke-Checked "electron-builder" { & npx.cmd electron-builder --win --dir --publish never }
} else {
    Invoke-Checked "electron-builder" { & npx.cmd electron-builder --win --publish never }
}

Write-Step "완료"
$outDir = Join-Path $Root "release\desktop"
Get-ChildItem $outDir -File | Where-Object { $_.Extension -in ".exe", ".zip" } | ForEach-Object { Write-Host ("{0}  ({1:N0} MB)" -f $_.FullName, ($_.Length / 1MB)) }
Write-Host ""
Write-Host "'web-agent-manager Setup <버전>.exe'는 설치형입니다."
Write-Host "'web-agent-manager-<버전>-win.zip'은 압축을 한 번 풀어 두고 안의 web-agent-manager.exe를 바로 실행합니다(설치 없음)."
Write-Host "이 PC에서 바로 쓰려면 win-unpacked\web-agent-manager.exe를 실행해도 됩니다."
try { Start-Process explorer.exe $outDir } catch { }
