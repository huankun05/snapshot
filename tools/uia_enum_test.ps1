# 对照测试：微信 provider 支持哪种 UIA 枚举方式
param([long]$Hwnd = 526670)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Hwnd)
if (-not $root) { Write-Host "FromHandle failed"; exit 1 }
Write-Host ("root: {0} '{1}'" -f $root.Current.ControlType.ProgrammaticName, $root.Current.Name)

# 1. 普通 FindAll(Children)
$c1 = $root.FindAll([System.Windows.Automation.TreeScope]::Children,
                    [System.Windows.Automation.Condition]::TrueCondition)
Write-Host ("[1] FindAll(Children, TrueCondition)          -> {0}" -f $c1.Count)

# 2. push 模式 CacheRequest + FindAll(Children)  ≈ FindAllBuildCache
$req = New-Object System.Windows.Automation.CacheRequest
$req.TreeScope = [System.Windows.Automation.TreeScope]::Children
$req.Add([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty)
$req.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
$req.Add([System.Windows.Automation.AutomationElement]::NameProperty)
$req.Activate()
$c2 = $root.FindAll([System.Windows.Automation.TreeScope]::Children,
                    [System.Windows.Automation.Condition]::TrueCondition)
Write-Host ("[2] FindAll(Children, TrueCondition)+CacheReq -> {0}" -f $c2.Count)

# 3. RawViewWalker
$rw = [System.Windows.Automation.TreeWalker]::RawViewWalker
$k3 = $rw.GetFirstChild($root)
if ($k3) {
  $r3 = $k3.Current.BoundingRectangle
  Write-Host ("[3] RawViewWalker.GetFirstChild               -> {0} '{1}' rect={2}x{3}" -f `
    $k3.Current.ControlType.ProgrammaticName, $k3.Current.Name, $r3.Width, $r3.Height)
} else {
  Write-Host "[3] RawViewWalker.GetFirstChild               -> null"
}

# 4. ControlViewWalker
$cw = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$k4 = $cw.GetFirstChild($root)
if ($k4) {
  $r4 = $k4.Current.BoundingRectangle
  Write-Host ("[4] ControlViewWalker.GetFirstChild           -> {0} '{1}' rect={2}x{3}" -f `
    $k4.Current.ControlType.ProgrammaticName, $k4.Current.Name, $r4.Width, $r4.Height)
} else {
  Write-Host "[4] ControlViewWalker.GetFirstChild           -> null"
}

# 5. Descendants 全量（参照）
$c5 = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
                    [System.Windows.Automation.Condition]::TrueCondition)
Write-Host ("[5] FindAll(Descendants, TrueCondition)       -> {0}" -f $c5.Count)
