# 生成应用图标（与 titlebar SVG 同款）：输出 resources/icon.png 与多尺寸 icon.ico。
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

  $scale = $Size / 24.0
  $ink = [System.Drawing.Color]::FromArgb(255, 23, 23, 23)        # #171717 (DESIGN ink)
  $white = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)

  # 圆角 ink 黑背景：与 titlebar SVG 同款 (1,2)-(22,20) rx=5.5
  $bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $bgX = 1.0 * $scale
  $bgY = 2.0 * $scale
  $bgW = 22.0 * $scale
  $bgH = 20.0 * $scale
  $bgR = 5.5 * $scale * 2
  $bgPath.AddArc($bgX, $bgY, $bgR, $bgR, 180, 90)
  $bgPath.AddArc($bgX + $bgW - $bgR, $bgY, $bgR, $bgR, 270, 90)
  $bgPath.AddArc($bgX + $bgW - $bgR, $bgY + $bgH - $bgR, $bgR, $bgR, 0, 90)
  $bgPath.AddArc($bgX, $bgY + $bgH - $bgR, $bgR, $bgR, 90, 90)
  $bgPath.CloseFigure()
  $bgBrush = New-Object System.Drawing.SolidBrush $ink
  $g.FillPath($bgBrush, $bgPath)
  $bgBrush.Dispose()
  $bgPath.Dispose()

  # 白色「>」+ 下划线（stroke-width 2.4）
  $strokeWidth = [Math]::Max($Size / 24.0 * 2.4, 1.2)
  $stroke = New-Object System.Drawing.Pen $white, $strokeWidth
  $stroke.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $stroke.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $stroke.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

  $g.DrawLine($stroke, (6.5 * $scale), (9 * $scale), (10 * $scale), (12 * $scale))
  $g.DrawLine($stroke, (10 * $scale), (12 * $scale), (6.5 * $scale), (15 * $scale))
  $g.DrawLine($stroke, (12.5 * $scale), (15 * $scale), (17.5 * $scale), (15 * $scale))

  $stroke.Dispose()
  $g.Dispose()
  return $bmp
}

$mainBmp = New-IconBitmap -Size $Master
$pngPath = Join-Path $resDir 'icon.png'
$mainBmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "wrote $pngPath"

# 多尺寸 ICO：每张作为 PNG 压缩塞进 ICO
$sizes = @(16, 32, 48, 64, 128, 256)
$bitmaps = @()
foreach ($s in $sizes) {
  if ($s -eq $Master) { $bitmaps += $mainBmp } else { $bitmaps += (New-IconBitmap -Size $s) }
}

$icoPath = Join-Path $resDir 'icon.ico'
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ms
$bw.Write([uint16]0)               # reserved
$bw.Write([uint16]1)               # type = 1 (icon)
$bw.Write([uint16]$sizes.Count)    # count

$pngBytes = @()
foreach ($bmp in $bitmaps) {
  $tmp = New-Object System.IO.MemoryStream
  $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngBytes += , $tmp.ToArray()
  $tmp.Dispose()
}

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

foreach ($bytes in $pngBytes) { $bw.Write($bytes) }

[System.IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
$bw.Dispose(); $ms.Dispose()
foreach ($bmp in $bitmaps) { $bmp.Dispose() }
Write-Host "wrote $icoPath"
