# 枚举指定 HWND 的 Win32 子窗（类名/可见性）
param([Parameter(Mandatory = $true)][long]$Hwnd)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class ChildEnum {
  public static List<string> Found = new List<string>();
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  public static void Run(IntPtr root) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    EnumChildWindows(root, new EnumProc(Cb), IntPtr.Zero);
  }
  public static bool Cb(IntPtr h, IntPtr l) {
    var cls = new StringBuilder(128); GetClassName(h, cls, 128);
    Found.Add(h.ToInt64() + "  [" + cls + "]  vis=" + IsWindowVisible(h));
    return true;
  }
}
'@
[ChildEnum]::Run([IntPtr]$Hwnd)
if ([ChildEnum]::Found.Count -eq 0) { Write-Host 'no children' }
[ChildEnum]::Found | ForEach-Object { Write-Host $_ }
