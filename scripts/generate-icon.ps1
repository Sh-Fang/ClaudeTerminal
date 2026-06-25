# 生成应用图标：和 titlebar 上的"终端 SVG"同款 —— 圆角窗框 + > 提示符 + 下划线。
# 输出 resources/icon.png（256x256）与 resources/icon.ico（多尺寸 16/32/48/64/128/256）。
# 用法：pwsh -NoProfile -File scripts/generate-icon.ps1

param(
  [int]$Master = 256
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$resDir = Join-Path $repoRoot 'resources'
if (-not (Test-Path $resDir)) { New-Item -ItemType Directory -Force -Path $resDir | Out-Null }

function New-IconBitmap {
  param([int]$Size)

  $bmp = New-Object System.Drawing.Bitmap $Size, $Size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::Transparent)

  $ink = [System.Drawing.Color]::FromArgb(255, 23, 23, 23)
  $stroke = New-Object System.Drawing.Pen $ink, ($Size * 0.083)
  $stroke.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $stroke.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $stroke.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

  # 圆角窗框：viewBox 24×24 → 缩放到 Size，rect (2.5,4)-(21.5,20) rx 2.5
  $scale = $Size / 24.0
  $x = 2.5 * $scale
  $y = 4 * $scale
  $w = 19 * $scale
  $h = 16 * $scale
  $r = 2.5 * $scale * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($x, $y, $r, $r, 180, 90)
  $path.AddArc($x + $w - $r, $y, $r, $r, 270, 90)
  $path.AddArc($x + $w - $r, $y + $h - $r, $r, $r, 0, 90)
  $path.AddArc($x, $y + $h - $r, $r, $r, 90, 90)
  $path.CloseFigure()
  $g.DrawPath($stroke, $path)

  # ">" 提示符 polyline: (6.5,9) - (10,12) - (6.5,15)
  $p1 = New-Object System.Drawing.PointF (6.5 * $scale), (9 * $scale)
  $p2 = New-Object System.Drawing.PointF (10 * $scale), (12 * $scale)
  $p3 = New-Object System.Drawing.PointF (6.5 * $scale), (15 * $scale)
  $g.DrawLine($stroke, $p1, $p2)
  $g.DrawLine($stroke, $p2, $p3)

  # 下划线 line: (12.5,15) - (17.5,15)
  $p4 = New-Object System.Drawing.PointF (12.5 * $scale), (15 * $scale)
  $p5 = New-Object System.Drawing.PointF (17.5 * $scale), (15 * $scale)
  $g.DrawLine($stroke, $p4, $p5)

  $stroke.Dispose()
  $path.Dispose()
  $g.Dispose()
  return $bmp
}

# 主 PNG（256）
$mainBmp = New-IconBitmap -Size $Master
$pngPath = Join-Path $resDir 'icon.png'
$mainBmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "wrote $pngPath"

# 多尺寸 ICO：16/32/48/64/128/256，每张作为 PNG 压缩塞进 ICO
$sizes = @(16, 32, 48, 64, 128, 256)
$bitmaps = @()
foreach ($s in $sizes) {
  if ($s -eq $Master) { $bitmaps += $mainBmp } else { $bitmaps += (New-IconBitmap -Size $s) }
}

$icoPath = Join-Path $resDir 'icon.ico'
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ms
# ICONDIR
$bw.Write([uint16]0)               # reserved
$bw.Write([uint16]1)               # type = 1 (icon)
$bw.Write([uint16]$sizes.Count)    # count

# 每个 PNG 临时编码为字节
$pngBytes = @()
foreach ($bmp in $bitmaps) {
  $tmp = New-Object System.IO.MemoryStream
  $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngBytes += , $tmp.ToArray()
  $tmp.Dispose()
}

# ICONDIRENTRY × N
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $bw.Write([byte]($s -band 0xFF))    # width (256 → 0)
  $bw.Write([byte]($s -band 0xFF))    # height
  $bw.Write([byte]0)                   # colors in palette
  $bw.Write([byte]0)                   # reserved
  $bw.Write([uint16]1)                 # color planes
  $bw.Write([uint16]32)                # bits per pixel
  $bw.Write([uint32]$pngBytes[$i].Length)  # size
  $bw.Write([uint32]$offset)               # offset
  $offset += $pngBytes[$i].Length
}

# 写所有 PNG 数据
foreach ($bytes in $pngBytes) { $bw.Write($bytes) }

[System.IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
$bw.Dispose(); $ms.Dispose()
foreach ($bmp in $bitmaps) { $bmp.Dispose() }
Write-Host "wrote $icoPath"
