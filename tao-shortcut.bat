@echo off
chcp 65001 >nul
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\create-shortcut.ps1"
if errorlevel 1 (
  echo.
  echo Khong tao duoc shortcut.
) else (
  echo.
  echo Da tao shortcut BanNhanh tren Desktop va trong Start Menu.
)
pause
