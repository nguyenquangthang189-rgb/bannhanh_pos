# Tao anh hoa don nhap mau de kiem thu OCR: ban in thang, ban giong anh chup (nghieng, mo, toi mot goc)
# va ban khong co duong ke bang.
# Chay: powershell -ExecutionPolicy Bypass -File test\fixtures\make-invoice-images.ps1
# Luu file dang UTF-8 co BOM de PowerShell 5.1 doc dung chu tieng Viet.
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$out = $PSScriptRoot

function U([string]$s) { $s }

$title  = U 'PHIẾU GIAO HÀNG'
$seller = U 'Công ty TNHH Phân phối Minh Phát'
$number = U 'Số: PG-1024    Ngày 02/11/2026'
$header = @('STT', (U 'Tên hàng'), (U 'ĐVT'), (U 'Số lượng'), (U 'Đơn giá'), (U 'Thành tiền'))
$rows = @(
  @('1', (U 'Pepsi lon 330ml'), 'lon', '24', '7.000', '168.000'),
  @('2', (U 'Mì Hảo Hảo tôm chua cay'), (U 'gói'), '100', '3.200', '320.000'),
  @('3', (U 'Nước rửa chén Sunlight 750g'), 'chai', '12', '26.000', '312.000'),
  @('4', (U 'Sữa tươi Vinamilk 1L'), (U 'hộp'), '6', '29.000', '174.000')
)
$total    = U 'Tổng cộng: 974.000'
$discount = U 'Chiết khấu: 4.000'
$pay      = U 'Tổng thanh toán: 970.000'

function Draw-Invoice([string]$file, [bool]$photo, [bool]$ruled = $true) {
  $w = 1400; $h = 1000
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $g.Clear([System.Drawing.Color]::White)
  if ($photo) { $g.Clear([System.Drawing.Color]::FromArgb(236, 233, 226)); $g.TranslateTransform(30, -10); $g.RotateTransform(1.2) }
  $ink = [System.Drawing.Brushes]::Black
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::Black), 2
  $big = New-Object System.Drawing.Font 'Arial', 30, ([System.Drawing.FontStyle]::Bold)
  $f = New-Object System.Drawing.Font 'Arial', 22
  $fb = New-Object System.Drawing.Font 'Arial', 22, ([System.Drawing.FontStyle]::Bold)
  $g.DrawString($seller, $fb, $ink, 60, 40)
  $g.DrawString($title, $big, $ink, 480, 100)
  $g.DrawString($number, $f, $ink, 470, 160)
  $cols = @(60, 150, 690, 820, 1010, 1180, 1350)
  $y = 240; $rowH = 62
  $lines = 2 + $rows.Count
  if ($ruled) {
    for ($i = 0; $i -lt $lines; $i++) { $g.DrawLine($pen, $cols[0], $y + $i * $rowH, $cols[-1], $y + $i * $rowH) }
    foreach ($x in $cols) { $g.DrawLine($pen, $x, $y, $x, $y + ($lines - 1) * $rowH) }
  }
  for ($c = 0; $c -lt $header.Count; $c++) { $g.DrawString($header[$c], $fb, $ink, $cols[$c] + 10, $y + 14) }
  for ($r = 0; $r -lt $rows.Count; $r++) {
    for ($c = 0; $c -lt $header.Count; $c++) { $g.DrawString($rows[$r][$c], $f, $ink, $cols[$c] + 10, $y + ($r + 1) * $rowH + 16) }
  }
  $yt = $y + ($lines - 1) * $rowH + 30
  $g.DrawString($total, $fb, $ink, 900, $yt)
  $g.DrawString($discount, $f, $ink, 900, $yt + 45)
  $g.DrawString($pay, $fb, $ink, 900, $yt + 90)
  $g.Dispose()
  if ($photo) {
    # Lam mo nhe (thu nho roi phong to), nen JPEG chat luong thap, roi phu bong toi dan ve mot goc
    # nhu anh chup duoi den. Ban cuoi luu PNG vi trinh duyet cung gui PNG len may chu.
    $small = New-Object System.Drawing.Bitmap $bmp, ([int]($w * 0.6)), ([int]($h * 0.6))
    $blur = New-Object System.Drawing.Bitmap $small, $w, $h
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $params = New-Object System.Drawing.Imaging.EncoderParameters 1
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 60L
    $ms = New-Object System.IO.MemoryStream
    $blur.Save($ms, $codec, $params)
    $photoBmp = New-Object System.Drawing.Bitmap ([System.Drawing.Image]::FromStream($ms))
    $pg = [System.Drawing.Graphics]::FromImage($photoBmp)
    $shade = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Point 0, 0), (New-Object System.Drawing.Point $w, $h), ([System.Drawing.Color]::FromArgb(0, 0, 0, 0)), ([System.Drawing.Color]::FromArgb(110, 40, 30, 10))
    $pg.FillRectangle($shade, 0, 0, $w, $h)
    $pg.Dispose()
    $photoBmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $small.Dispose(); $blur.Dispose(); $photoBmp.Dispose(); $ms.Dispose()
  } else {
    $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  }
  $bmp.Dispose()
}

Draw-Invoice (Join-Path $out 'hoa-don-in.png') $false
Draw-Invoice (Join-Path $out 'hoa-don-chup.png') $true
Draw-Invoice (Join-Path $out 'hoa-don-khong-ke.png') $false $false
'ok'
