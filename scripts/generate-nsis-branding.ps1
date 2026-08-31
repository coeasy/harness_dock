$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot 'apps/tauri/src-tauri/icons/app-icon.png'
$outDir = Join-Path $repoRoot 'apps/tauri/src-tauri/icons'

if (-not (Test-Path $source)) { throw "HarnessDock app icon not found: $source" }
Add-Type -AssemblyName System.Drawing

function Write-BrandBitmap([int]$width, [int]$height, [int]$iconSize, [string]$output) {
  $bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $image = [System.Drawing.Image]::FromFile($source)
  try {
    $graphics.Clear([System.Drawing.Color]::White)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $x = [Math]::Floor(($width - $iconSize) / 2)
    $y = [Math]::Floor(($height - $iconSize) / 2)
    $graphics.DrawImage($image, $x, $y, $iconSize, $iconSize)
    $bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Bmp)
  } finally {
    $image.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

Write-BrandBitmap 150 57 48 (Join-Path $outDir 'installer-header.bmp')
Write-BrandBitmap 164 314 128 (Join-Path $outDir 'installer-sidebar.bmp')

Get-Item (Join-Path $outDir 'installer-header.bmp'), (Join-Path $outDir 'installer-sidebar.bmp') | ForEach-Object {
  if ($_.Length -le 0) { throw "Generated NSIS branding image is empty: $($_.FullName)" }
  Write-Host "Generated $($_.FullName) ($($_.Length) bytes)"
}
