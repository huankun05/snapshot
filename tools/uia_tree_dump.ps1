# UIA 句柄树转储：诊断 ElementFromHandle + FindAll(Children) 钻取断链问题
# 用法：powershell -File tools\uia_tree_dump.ps1 <hwnd> [maxDepth]
param(
  [Parameter(Mandatory = $true)][long]$Hwnd,
  [int]$MaxDepth = 4
)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Import-Module -Name UIAutomation -ErrorAction SilentlyContinue

function Dump([System.Windows.Automation.AutomationElement]$el, [int]$depth, [string]$path) {
  $r = $el.Current.BoundingRectangle
  $rect = if ($r.IsEmpty) { "EMPTY" } else { "{0:0}x{1:0} @{2:0},{3:0}" -f $r.Width, $r.Height, $r.X, $r.Y }
  $name = $el.Current.Name
  if ($name.Length -gt 30) { $name = $name.Substring(0, 30) }
  $indent = '  ' * $depth
  $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children,
                      [System.Windows.Automation.Condition]::TrueCondition)
  $ctype = $el.Current.ControlType.ProgrammaticName -replace 'ControlType.', ''
  Write-Host ("{0}[{1}] '{2}' children={3} rect={4}" -f `
    $indent, $ctype, $name, $kids.Count, $rect)
  if ($depth -ge $MaxDepth) { return }
  for ($i = 0; $i -lt $kids.Count; $i++) {
    Dump $kids.Item($i) ($depth + 1) "$path/$i"
  }
}

$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Hwnd)
if (-not $root) { Write-Host "FromHandle failed"; exit 1 }
Write-Host ("ROOT hwnd=0x{0:X}" -f $Hwnd)
Dump $root 0 ""
