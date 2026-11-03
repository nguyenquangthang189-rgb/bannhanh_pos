# Dong goi BanNhanh thanh mot file .zip chay duoc tren may Windows 64-bit chua cai gi:
# kem san Node.js (runtime\node.exe) va cac thu vien (node_modules). Khong kem du lieu cua cua hang.
# Chay: dong-goi.bat, hoac powershell -ExecutionPolicy Bypass -File scripts\build-package.ps1
param([string]$OutDir = '')

$ErrorActionPreference = 'Stop'
$app = (Get-Item -LiteralPath (Join-Path $PSScriptRoot '..')).FullName
$pkg = Get-Content -LiteralPath (Join-Path $app 'package.json') -Raw | ConvertFrom-Json
if (-not $OutDir) { $OutDir = Join-Path $app 'dist' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$node = (Get-Command node -ErrorAction Stop).Source
$nodeVersion = (& $node -v).Trim()
$arch = (& $node -p 'process.arch').Trim()
if ($arch -ne 'x64') { throw "Can Node.js ban x64 de dong goi (dang co $arch)" }
if (-not (Test-Path -LiteralPath (Join-Path $app 'node_modules\tesseract.js'))) { throw 'Thieu thu vien. Hay chay "npm install" truoc khi dong goi' }

$name = "BanNhanh-$($pkg.version)-win-x64"
$stage = Join-Path $OutDir $name
$zip = Join-Path $OutDir "$name.zip"
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

foreach ($dir in 'server', 'public', 'scripts', 'node_modules') {
  Copy-Item -LiteralPath (Join-Path $app $dir) -Destination $stage -Recurse
}
foreach ($file in 'package.json', 'package-lock.json', 'start.bat', 'tao-shortcut.bat', 'README.md') {
  Copy-Item -LiteralPath (Join-Path $app $file) -Destination $stage
}
Remove-Item -LiteralPath (Join-Path $stage 'scripts\build-package.ps1')
Move-Item -LiteralPath (Join-Path $stage 'scripts\HUONG-DAN-CAI-DAT.txt') -Destination $stage

$runtime = New-Item -ItemType Directory -Path (Join-Path $stage 'runtime')
Copy-Item -LiteralPath $node -Destination $runtime
$license = Join-Path (Split-Path $node) 'LICENSE'
if (Test-Path -LiteralPath $license) { Copy-Item -LiteralPath $license -Destination (Join-Path $runtime 'LICENSE-nodejs.txt') }
Set-Content -LiteralPath (Join-Path $runtime 'VERSION.txt') -Value "Node.js $nodeVersion $arch" -Encoding ASCII

# tar.exe cua Windows 10 tro len tao duoc file .zip, nhanh hon Compress-Archive.
& (Join-Path $env:SystemRoot 'System32\tar.exe') -a -c -f $zip -C $OutDir $name
if ($LASTEXITCODE -ne 0) { throw 'Nen file zip that bai' }

$sizeMb = [math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 1)
Write-Output "Da tao: $zip ($sizeMb MB, Node.js $nodeVersion)"
Write-Output "Thu muc chua nen: $stage"
