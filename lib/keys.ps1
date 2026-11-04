# Helpers for the experimental auto-continue (Windows). Called by extension.js:
#   keys.ps1 idle                  -> milliseconds since the last keyboard/mouse input
#   keys.ps1 raise "<title part>"  -> brings the VS Code window whose title contains it to the front; prints True/False
#   keys.ps1 type "<sendkeys>"     -> types into the foreground window
param([string]$Action, [string]$Arg = '')

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SbWin {
  [StructLayout(LayoutKind.Sequential)] public struct LII { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII l);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  public static uint IdleMs() {
    LII l = new LII(); l.cbSize = 8; GetLastInputInfo(ref l);
    return (uint)Environment.TickCount - l.dwTime;
  }

  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

  // Any visible window of a Code.exe process whose title contains the folder name (the title
  // format is configurable, so its ending is not checked). Returns ok / notfound / refused.
  public static string Raise(string part) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      StringBuilder s = new StringBuilder(512); GetWindowText(h, s, 512);
      if (!s.ToString().Contains(part)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      try { if (System.Diagnostics.Process.GetProcessById((int)pid).ProcessName != "Code") return true; } catch { return true; }
      found = h; return false;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return "notfound";
    if (IsIconic(found)) ShowWindow(found, 9); // SW_RESTORE
    // Windows only lets the foreground thread hand over focus: borrow its input state and press
    // Alt, which both unlock SetForegroundWindow.
    uint dummy;
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out dummy);
    uint me = GetCurrentThreadId();
    bool attached = fg != me && AttachThreadInput(me, fg, true);
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    BringWindowToTop(found);
    SetForegroundWindow(found);
    if (attached) AttachThreadInput(me, fg, false);
    return GetForegroundWindow() == found ? "ok" : "refused";
  }
}
'@

switch ($Action) {
  'idle'  { [SbWin]::IdleMs() }
  'raise' { [SbWin]::Raise($Arg) }
  'type'  { (New-Object -ComObject WScript.Shell).SendKeys($Arg) }
}
