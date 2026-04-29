'use strict';

const { spawn } = require('child_process');

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

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@
if (-not ('WF' -as [type])) { Add-Type -TypeDefinition $src -Language CSharp }

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
  if (-not [WF]::GetWindowRect($h, [ref]$rect)) { continue }
  $w = $rect.Right - $rect.Left
  $hgt = $rect.Bottom - $rect.Top
  if ($w -le 0 -or $hgt -le 0) { continue }
  if ($rect.Left -le -10000 -or $rect.Top -le -10000) { continue }
  $result.Add([pscustomobject]@{
    id = [int64]$h
    title = $title
    bounds = @{ x = $rect.Left; y = $rect.Top; width = $w; height = $hgt }
  })
}
ConvertTo-Json -InputObject $result -Compress -Depth 4
`;

let inflight = null;
let cache = { ts: 0, list: [] };
const CACHE_TTL_MS = 80;

function listWindowsAsync() {
  const now = Date.now();
  if (now - cache.ts < CACHE_TTL_MS) return Promise.resolve(cache.list);
  if (inflight) return inflight;

  inflight = new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', PS_SCRIPT
    ], { windowsHide: true });

    let stdout = '';
    let stderr = '';
    ps.stdout.on('data', (d) => { stdout += d.toString(); });
    ps.stderr.on('data', (d) => { stderr += d.toString(); });
    ps.on('error', (err) => {
      inflight = null;
      console.warn('[window-finder-ps] spawn error:', err.message);
      resolve(cache.list);
    });
    ps.on('close', () => {
      inflight = null;
      const text = stdout.trim();
      if (!text) {
        if (stderr) console.warn('[window-finder-ps] stderr:', stderr.slice(0, 400));
        resolve(cache.list);
        return;
      }
      try {
        const parsed = JSON.parse(text);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        cache = { ts: Date.now(), list };
        resolve(list);
      } catch (err) {
        console.warn('[window-finder-ps] parse error:', err.message, 'text head:', text.slice(0, 200));
        resolve(cache.list);
      }
    });
  });

  return inflight;
}

function snapshot() {
  return cache.list;
}

module.exports = {
  listWindowsAsync,
  snapshot
};
