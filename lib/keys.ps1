# Helpers for the experimental auto-continue (Windows). Called by extension.js:
#   keys.ps1 idle                  -> milliseconds since the last keyboard/mouse input
#   keys.ps1 raise "<title part>"  -> brings the VS Code window whose title contains it to the front; prints True/False
#   keys.ps1 type "<sendkeys>"     -> types into the foreground window
#   keys.ps1 screen                -> ok / saver / locked
#   keys.ps1 wake | saver          -> ends / starts the screen saver
#   keys.ps1 monitoroff            -> turns the screen off
#   keys.ps1 awake                 -> keeps the computer from sleeping until this process is ended
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

  [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint a, uint b, ref bool v, uint c);
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint f, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int i, StringBuilder s, int n, out int need);

  // locked: the sign-in screen (keys can't reach any window); saver: a screen saver is running;
  // ok: the normal desktop.
  public static string Screen() {
    IntPtr d = OpenInputDesktop(0, false, 0x0001); // DESKTOP_READOBJECTS
    if (d == IntPtr.Zero) return "locked";
    StringBuilder s = new StringBuilder(256); int need;
    GetUserObjectInformation(d, 2, s, 512, out need); // UOI_NAME
    CloseDesktop(d);
    if (!s.ToString().Equals("Default", StringComparison.OrdinalIgnoreCase)) return s.ToString() == "Screen-saver" ? "saver" : "locked";
    bool running = false;
    SystemParametersInfo(0x0072, 0, ref running, 0); // SPI_GETSCREENSAVERRUNNING
    return running ? "saver" : "ok";
  }

  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static void MonitorOff() { PostMessage((IntPtr)0xFFFF, 0x0112, (IntPtr)0xF170, (IntPtr)2); } // SC_MONITORPOWER off

  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);
}
'@

# The screen saver set in Personalization (e.g. scrnsave.scr, a black screen).
function Get-SaverExe { (Get-ItemProperty 'HKCU:\Control Panel\Desktop' -ErrorAction SilentlyContinue).'SCRNSAVE.EXE' }
# Its process is named with the extension (scrnsave.scr), so match the file name.
function Get-SaverProcess {
  $exe = Get-SaverExe
  if (-not $exe) { return $null }
  $file = [IO.Path]::GetFileName($exe)
  Get-Process | Where-Object { $_.Name -eq $file -or $_.Name -eq [IO.Path]::GetFileNameWithoutExtension($file) }
}

switch ($Action) {
  'idle'  { [SbWin]::IdleMs() }
  'raise' { [SbWin]::Raise($Arg) }
  'type'  { (New-Object -ComObject WScript.Shell).SendKeys($Arg) }
  'screen' {
    $s = [SbWin]::Screen()
    if ($s -eq 'ok' -and (Get-SaverProcess)) { $s = 'saver' }
    $s
  }
  # Ends the screen saver without input, so the idle time keeps counting.
  'wake'  {
    if (-not (Get-SaverExe)) { 'nosaver'; break }
    $p = Get-SaverProcess
    if (-not $p) { 'notfound'; break }
    $p | Stop-Process -Force -ErrorAction SilentlyContinue
    'ok'
  }
  'monitoroff' { [SbWin]::MonitorOff(); 'ok' }
  # Keeps the computer from sleeping (the screen may still turn off) while this process runs.
  'awake' {
    [void][SbWin]::SetThreadExecutionState([uint32]2147483649) # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    # Ends by itself when the VS Code process that started it is gone (crash, kill).
    while (-not $Arg -or (Get-Process -Id ([int]$Arg) -ErrorAction SilentlyContinue)) { Start-Sleep -Seconds 30 }
  }
  # Starts the screen saver again right away.
  'saver' {
    $exe = Get-SaverExe
    if ($exe) { Start-Process -FilePath $exe -ArgumentList '/s'; 'ok' } else { 'nosaver' }
  }
}
