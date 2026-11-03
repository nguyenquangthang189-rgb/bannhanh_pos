# Tao shortcut BanNhanh tro toi start.bat, tren Desktop va trong Start Menu cua nguoi dung hien tai.
# Tao lai se ghi de shortcut cu, nen chay lai duoc sau khi chuyen thu muc phan mem.
param([string]$OutDir = '')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$appDir = (Get-Item -LiteralPath (Join-Path $PSScriptRoot '..')).FullName
$dirs = if ($OutDir) { @($OutDir) } else { @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) }

$shell = New-Object -ComObject WScript.Shell
$created = foreach ($dir in $dirs) {
  $path = Join-Path $dir 'BanNhanh.lnk'
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = Join-Path $appDir 'start.bat'
  $link.WorkingDirectory = $appDir
  $link.IconLocation = (Join-Path $appDir 'public\icon.ico') + ',0'
  $link.Description = 'BanNhanh - Ban hang va ke toan'
  $link.WindowStyle = 7 # thu nho cua so may chu xuong thanh tac vu
  $link.Save()
  $path
}
ConvertTo-Json -InputObject @($created) -Compress
