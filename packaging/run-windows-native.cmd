@echo off
chcp 65001 >nul
rem 더블클릭으로 실행해도 결과·오류가 보이도록 항상 멈춘다(#153). 음수 종료 코드(PowerShell 시작 실패 등)도 표시한다.
setlocal
set "SCRIPT=%~dp0run-windows-native.ps1"
if not exist "%SCRIPT%" (
  echo [web-agent-manager] run-windows-native.ps1 파일을 찾을 수 없습니다. zip 압축을 모두 푼 폴더에서 실행하세요.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" echo [web-agent-manager] 오류로 종료되었습니다(코드 %CODE%). 위 메시지를 확인하세요.
pause
exit /b %CODE%
