"use strict";

const { spawn } = require("child_process");

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WF {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public static bool TryGetDwmBounds(IntPtr hwnd, out RECT rect) {
    rect = new RECT();
    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    int hr = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, System.Runtime.InteropServices.Marshal.SizeOf(typeof(RECT)));
    return hr == 0;
  }

  public static double GetScaleFactor(IntPtr hwnd) {
    uint dpi = GetDpiForWindow(hwnd);
    if (dpi == 0) dpi = 96;
    return dpi / 96.0;
  }

  public static void ToLogical(ref RECT rect, double sf) {
    if (sf == 1.0) return;
    rect.Left   = (int)System.Math.Floor(rect.Left   / sf);
    rect.Top    = (int)System.Math.Floor(rect.Top    / sf);
    rect.Right  = (int)System.Math.Floor(rect.Right  / sf);
    rect.Bottom = (int)System.Math.Floor(rect.Bottom / sf);
  }
}
'@
if (-not ('WF' -as [type])) { Add-Type -TypeDefinition $src -Language CSharp }
$fg = [int64][WF]::GetForegroundWindow()

$result = New-Object System.Collections.Generic.List[object]
foreach ($p in [System.Diagnostics.Process]::GetProcesses()) {
  try {
    $h = $p.MainWindowHandle
  } catch { continue }
  if ($h -eq [IntPtr]::Zero) { continue }
  if (-not [WF]::IsWindowVisible($h)) { continue }
  $len = [WF]::GetWindowTextLength($h)
  if ($len -le 0) { continue }
  $sb = New-Object System.Text.StringBuilder ($len + 1)
  [void][WF]::GetWindowText($h, $sb, $sb.Capacity)
  $title = $sb.ToString()
  if ([string]::IsNullOrWhiteSpace($title)) { continue }
  $rect = New-Object WF+RECT
  $useRect = $rect
  $dwmOk = [WF]::TryGetDwmBounds($h, [ref]$rect)
  if ($dwmOk) {
    $useRect = $rect
  } else {
    if (-not [WF]::GetWindowRect($h, [ref]$rect)) { continue }
    $useRect = $rect
  }
  $sf = [WF]::GetScaleFactor($h)
  [WF]::ToLogical([ref]$useRect, $sf)
  $w = $useRect.Right - $useRect.Left
  $hgt = $useRect.Bottom - $useRect.Top
  if ($w -le 0 -or $hgt -le 0) { continue }
  if ($useRect.Left -le -10000 -or $useRect.Top -le -10000) { continue }
  $result.Add([pscustomobject]@{
    id = [int64]$h
    title = $title
    bounds = @{ x = $useRect.Left; y = $useRect.Top; width = $w; height = $hgt }
  })
}
ConvertTo-Json -InputObject @{ foreground = $fg; windows = $result } -Compress -Depth 5
`;

let inflight = null;
let cache = { ts: 0, list: [], foregroundId: 0 };
const CACHE_TTL_MS = 80;

function listWindowsAsync() {
  const now = Date.now();
  if (now - cache.ts < CACHE_TTL_MS) return Promise.resolve(cache);
  if (inflight) return inflight;

  inflight = new Promise((resolve) => {
    const ps = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        PS_SCRIPT,
      ],
      { windowsHide: true },
    );

    let stdout = "";
    let stderr = "";
    ps.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    ps.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    ps.on("error", (err) => {
      inflight = null;
      console.warn("[window-finder-ps] spawn error:", err.message);
      resolve(cache);
    });
    ps.on("close", () => {
      inflight = null;
      const text = stdout.trim();
      if (!text) {
        if (stderr)
          console.warn("[window-finder-ps] stderr:", stderr.slice(0, 400));
        resolve(cache);
        return;
      }
      try {
        const parsed = JSON.parse(text);
        const wins = parsed.windows;
        const list = Array.isArray(wins) ? wins : wins ? [wins] : [];
        const foregroundId = Number(parsed.foreground) || 0;
        cache = { ts: Date.now(), list, foregroundId };
        resolve(cache);
      } catch (err) {
        console.warn(
          "[window-finder-ps] parse error:",
          err.message,
          "text head:",
          text.slice(0, 200),
        );
        resolve(cache);
      }
    });
  });

  return inflight;
}

function snapshot() {
  return cache;
}

const DWM_HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Runtime.InteropServices;
public static class DWMH {
  [DllImport("dwmapi.dll")]
  public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
  [DllImport("user32.dll")]
  public static extern uint GetDpiForWindow(IntPtr hwnd);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public static bool TryGetLogicalBounds(IntPtr hwnd, out RECT logical) {
    logical = new RECT();
    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    RECT physical;
    int hr = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out physical, Marshal.SizeOf(typeof(RECT)));
    if (hr != 0) return false;
    uint dpi = GetDpiForWindow(hwnd);
    if (dpi == 0) dpi = 96;
    double sf = dpi / 96.0;
    logical.Left   = (int)Math.Floor(physical.Left   / sf);
    logical.Top    = (int)Math.Floor(physical.Top    / sf);
    logical.Right  = (int)Math.Floor(physical.Right  / sf);
    logical.Bottom = (int)Math.Floor(physical.Bottom / sf);
    return true;
  }
}
'@
if (-not ('DWMH' -as [type])) { Add-Type -TypeDefinition $src -Language CSharp }
$rect = New-Object DWMH+RECT
$hwnd = [IntPtr]::new([int64]$args[0])
$ok = [DWMH]::TryGetLogicalBounds($hwnd, [ref]$rect)
if ($ok) {
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  Write-Output "$($rect.Left),$($rect.Top),$w,$h"
}
`;

function getDwmBounds(hwnd) {
  return new Promise((resolve) => {
    const ps = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        DWM_HELPER_SCRIPT,
        String(hwnd),
      ],
      { windowsHide: true },
    );

    let stdout = "";
    ps.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    ps.on("error", () => resolve(null));
    ps.on("close", () => {
      const text = stdout.trim();
      if (!text) {
        resolve(null);
        return;
      }
      const parts = text.split(",");
      if (parts.length !== 4) {
        resolve(null);
        return;
      }
      const [x, y, w, h] = parts.map(Number);
      if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h)) {
        resolve(null);
        return;
      }
      resolve({ x, y, width: w, height: h });
    });
  });
}

module.exports = {
  listWindowsAsync,
  snapshot,
  getDwmBounds,
};
