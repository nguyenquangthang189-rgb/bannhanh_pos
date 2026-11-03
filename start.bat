@echo off
chcp 65001 >nul
cd /d "%~dp0"
title BanNhanh - Dong cua so nay se tat phan mem
if not defined PORT set PORT=3210
rem Ban dong goi co san Node.js trong thu muc runtime; ban ma nguon dung Node.js cai tren may.
set "NODE=%~dp0runtime\node.exe"
if exist "%NODE%" goto have_node
set "NODE=node"
where node >nul 2>nul
if not errorlevel 1 goto have_node
echo Chua cai Node.js. Hay cai ban 22.13 tro len tu https://nodejs.org roi chay lai.
pause
exit /b 1
:have_node
rem Phan mem da chay san thi chi mo trinh duyet, khong chay may chu thu hai.
netstat -an | findstr /r /c:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
  start "" http://localhost:%PORT%
  exit /b 0
)
rem Thu vien doc chu trong anh (OCR). Thieu thi cac chuc nang khac van chay binh thuong.
if not exist "node_modules\tesseract.js" if not exist "runtime\node.exe" call npm install --omit=dev
rem Mo trinh duyet sau 2 giay, khi may chu da san sang.
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%"
"%NODE%" --disable-warning=ExperimentalWarning server\index.js
pause
