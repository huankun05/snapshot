# 像素收边 · 真实帧重建 + 离线复算的取数步骤
#
# 为什么要「重建」而不是直接用截图：
#   用户那张截图是**开着截图蒙版时**拍的 ⇒
#     ① 洞外被蒙版压暗（rgba(0,0,0,0.40)）→ 原始帧 = 压暗像素 / 0.6
#     ② 洞的边缘被画了 2px 蓝色选框描边 → 会污染「框外参考带」
#     ③ 洞内有放大镜浮窗和尺寸标签 → 局部像素是 UI 不是页面
#   而**算法要吃的是原始帧**（页面本身的样子）。所以这里把 ①②③ 还原：
#     ① 反解压暗  ② 用内侧 3px 回填修补描边  ③ 放大镜/标签区域标记为「不可信」
#
# 用法：
#   pwsh -File tools/_trim_frame.ps1 -Src "<截图.png>" -Hx0 313 -Hy0 198 -Hx1 794 -Hy1 411
param(
  [Parameter(Mandatory = $true)][string]$Src,
  [string]$OutDir = (Join-Path $PSScriptRoot '..\_test'),
  [int]$Hx0 = 313, [int]$Hy0 = 198, [int]$Hx1 = 794, [int]$Hy1 = 411,
  [double]$Dim = 0.6
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $Src)) { throw "找不到截图: $Src" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$img = New-Object System.Drawing.Bitmap $Src
$W = $img.Width; $H = $img.Height

# ── ② 修补洞边缘的选框描边：洞内 3px 环 + 洞外 6px 环，都要修 ──
#    （描边画在洞的边界上：内半落在洞内、外半落在洞外，两边都会污染「框外参考带」）
#    修法：把环上的像素换成「沿最近那条边再往里/往外 10px」处的干净像素。
$RING_IN = 3
$RING_OUT = 6
function RepairOffset([int]$x, [int]$y) {
  # 返回 @(@dx,@dy) —— 采样点相对当前点的偏移（沿最近的那条边）
  $dL = $x - $Hx0; $dR = $Hx1 - 1 - $x; $dT = $y - $Hy0; $dB = $Hy1 - 1 - $y
  $d = $dL; $ax = 'L'; $ay = 'T'
  if ($dR -lt $d) { $d = $dR; $ax = 'R' }
  if ($dT -lt $d) { $d = $dT; $ay = 'T' }
  if ($dB -lt $d) { $d = $dB; $ay = 'B' }
  $dx = 0; $dy = 0
  if ($d -ge 0) {
    # 洞内：往洞中心方向让开 (10 - d)
    if ($ax -eq 'L') { $dx = 10 - $d } elseif ($ax -eq 'R') { $dx = -(10 - $d) }
    if ($ay -eq 'T') { $dy = 10 - $d } elseif ($ay -eq 'B') { $dy = -(10 - $d) }
  } else {
    # 洞外：往洞外方向让开 (10 + d)
    if ($ax -eq 'L') { $dx = -(10 + $d) } elseif ($ax -eq 'R') { $dx = 10 + $d }
    if ($ay -eq 'T') { $dy = -(10 + $d) } elseif ($ay -eq 'B') { $dy = 10 + $d }
  }
  return @($dx, $dy)
}

# ── ①② 逐像素重建原始帧（RGBA，top-down）──
# 先显式转成 32bppArgb：PNG 载入后的 PixelFormat 可能是 24bpp/32bppARGB，
# 直接 LockBits 会拿到带 stride 填充的另一种排布 → 读出来全是错位。
$bmp32 = New-Object System.Drawing.Bitmap $W, $H, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$gfx = [System.Drawing.Graphics]::FromImage($bmp32)
$gfx.DrawImage($img, 0, 0, $W, $H)
$gfx.Dispose()
$img.Dispose()

$rect = New-Object System.Drawing.Rectangle 0, 0, $W, $H
$data = $bmp32.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb))
$stride = $data.Stride
$bytes = New-Object byte[] ($stride * $H)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$bmp32.UnlockBits($data)
Write-Output ("  src={0} stride={1}" -f $W, $stride)

$out = New-Object byte[] ($W * $H * 4)
for ($y = 0; $y -lt $H; $y++) {
  for ($x = 0; $x -lt $W; $x++) {
    $si = $y * $stride + $x * 4
    $di = ($y * $W + $x) * 4
    $b = $bytes[$si]; $g = $bytes[$si + 1]; $r = $bytes[$si + 2]
    $inHole = ($x -ge $Hx0 -and $x -lt $Hx1 -and $y -ge $Hy0 -and $y -lt $Hy1)
    # 环带判定：洞内 3px / 洞外 6px 都要修（描边画在边界上，两半都污染）
    $dL = $x - $Hx0; $dR = $Hx1 - 1 - $x; $dT = $y - $Hy0; $dB = $Hy1 - 1 - $y
    $dMin = [Math]::Min([Math]::Min($dL, $dR), [Math]::Min($dT, $dB))
    $needRepair = $false
    if ($inHole) { $needRepair = ($dMin -lt $RING_IN) } else { $needRepair = ($dMin -gt (-$RING_OUT)) }
    if ($needRepair) {
      $off = RepairOffset $x $y
      $ix = [Math]::Min($W - 1, [Math]::Max(0, $x + $off[0]))
      $iy = [Math]::Min($H - 1, [Math]::Max(0, $y + $off[1]))
      $si2 = $iy * $stride + $ix * 4
      $r = $bytes[$si2 + 2]; $g = $bytes[$si2 + 1]; $b = $bytes[$si2]
      # ⚠️ 取样点可能落在洞外（那是被蒙版压暗的）→ 必须跟着反解，
      #    否则会把「压暗色」拷进洞内，污染框外参考带（实测：列 793 尾部两行
      #    变成 (145,146,148)，列剖面 dev 从 0 飙到 296，收边直接失效）。
      $sampleInHole = ($ix -ge $Hx0 -and $ix -lt $Hx1 -and $iy -ge $Hy0 -and $iy -lt $Hy1)
      if (-not $sampleInHole) {
        $r = [Math]::Min(255, [int][Math]::Round($r / $Dim))
        $g = [Math]::Min(255, [int][Math]::Round($g / $Dim))
        $b = [Math]::Min(255, [int][Math]::Round($b / $Dim))
      }
    } elseif (-not $inHole) {
      # 洞外：被蒙版压暗 → 反解
      $r = [Math]::Min(255, [int][Math]::Round($r / $Dim))
      $g = [Math]::Min(255, [int][Math]::Round($g / $Dim))
      $b = [Math]::Min(255, [int][Math]::Round($b / $Dim))
    }
    $out[$di] = $r; $out[$di + 1] = $g; $out[$di + 2] = $b; $out[$di + 3] = 255
  }
}

$bin = Join-Path $OutDir 'trim_frame.bin'
[System.IO.File]::WriteAllBytes($bin, $out)

$spec = [ordered]@{
  w = $W; h = $H
  # 截图是 5120x1440 虚拟桌面缩到 1920x539（0.375）；这里把截图本身当帧 ⇒ sf=1
  sf = 1
  rect = [ordered]@{ x = $Hx0; y = $Hy0; width = ($Hx1 - $Hx0); height = ($Hy1 - $Hy0) }
  expect = [ordered]@{ left = $Hx0; top = $Hy0; right = 645; bottom = $Hy1 }
  note = '截图 1920x539 = 5120x1440 虚拟桌面缩 0.375；洞 = 选框亮区；期望右边收到白色面板右缘 x=645'
}
$json = Join-Path $OutDir 'trim_frame.json'
[System.IO.File]::WriteAllText($json, ($spec | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))
Write-Output "FRAME $bin  ${W}x${H}"
Write-Output "SPEC  $json"
