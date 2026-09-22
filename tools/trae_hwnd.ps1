# 枚举微信顶层窗口（物理坐标），输出 hwnd/类名/标题
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WeEnum {
  public static List<string> Found = new List<string>();
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  public static void Run() {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    EnumWindows(new EnumProc(Cb), IntPtr.Zero);
  }
  public static bool Cb(IntPtr h, IntPtr l) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    string name = null;
    try {
      var p = System.Diagnostics.Process.GetProcessById((int)pid);
      if (p != null) name = p.ProcessName;
    } catch {}
    if (name == "TRAE SOLO CN" && IsWindowVisible(h)) {
      var cls = new StringBuilder(128); GetClassName(h, cls, 128);
      var txt = new StringBuilder(128); GetWindowText(h, txt, 128);
      Found.Add(h.ToInt64() + "  [" + cls + "]  '" + txt + "'");
    }
    return true;
  }
}
'@
[WeEnum]::Run()
if ([WeEnum]::Found.Count -eq 0) { Write-Host "no visible Weixin windows" }
[WeEnum]::Found | ForEach-Object { Write-Host $_ }
