@echo off
chcp 65001 >nul
rem 더블클릭으로 실행해도 결과·오류가 보이도록 항상 멈춘다(#153 규칙).
setlocal
set "SCRIPT=%~dp0build-desktop-windows.ps1"
if not exist "%SCRIPT%" (
  echo [web-agent-manager] build-desktop-windows.ps1 파일을 찾을 수 없습니다. git 저장소 폴더의 packaging 안에서 실행하세요.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" echo [web-agent-manager] 오류로 종료되었습니다(코드 %CODE%). 위 메시지를 확인하세요.
pause
exit /b %CODE%
