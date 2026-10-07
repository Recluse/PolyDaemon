<#
inject-keys.ps1 — type Text (then Enter) into the console owned by ProcId, via
AttachConsole + WriteConsoleInput. Needs no window focus and can't leak keystrokes
elsewhere — the same mechanism launch-ws.ps1 uses for its Enter-nudge.

Used by the bot to drive in-session slash commands (e.g. /effort) on a window that
lives on THIS machine: the bridge delivers Telegram text as a normal prompt, NOT as
a slash command, so the only way to actually run "/effort high" in a live session is
to type it into the TUI.

  inject-keys.ps1 -ProcId 12345 -Text "/effort high"

ProcId must be a process attached to the target console (the window's claude pid is
ideal; it shares the cmd console). Cross-machine note: AttachConsole is local-only,
so this runs where the window is — today the bot is co-located; post-cutover the
launch-agent will run it.
#>
param(
  [Parameter(Mandatory = $true)][int]$ProcId,
  [Parameter(Mandatory = $true)][string]$Text,
  [int]$EnterDelayMs = 350,   # pause after typing so the TUI renders the command before Enter
  # Some slash commands pop a confirm dialog after submission (notably /effort when
  # switching to a cache-invalidating tier: "Change effort level? 1. Yes / 2. No",
  # default = Yes). If the visible screen matches this regex within the poll window,
  # press Enter once more to confirm the default (Yes) option. Empty disables it.
  [string]$ConfirmRegex = 'Change effort level|switch to '
)

$ErrorActionPreference = 'Stop'

Add-Type -ErrorAction Stop @"
using System; using System.Runtime.InteropServices; using System.Text;
public class ConType {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateFile(
    string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct KEY_EVENT_RECORD {
    public int bKeyDown; public ushort wRepeatCount; public ushort wVirtualKeyCode;
    public ushort wVirtualScanCode; public char uChar; public uint dwControlKeyState;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT_RECORD {
    public ushort EventType; public KEY_EVENT_RECORD KeyEvent;
  }
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct CONSOLE_SCREEN_BUFFER_INFO {
    public COORD dwSize; public COORD dwCursorPosition; public ushort wAttributes;
    public SMALL_RECT srWindow; public COORD dwMaximumWindowSize;
  }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool WriteConsoleInput(
    IntPtr h, INPUT_RECORD[] recs, uint len, out uint written);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleScreenBufferInfo(
    IntPtr h, out CONSOLE_SCREEN_BUFFER_INFO info);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool ReadConsoleOutputCharacter(
    IntPtr h, [Out] StringBuilder buf, uint len, COORD coord, out uint read);

  static IntPtr conin = (IntPtr)(-1);
  static void One(ushort vk, char ch) {
    var recs = new INPUT_RECORD[2];
    recs[0].EventType = 1; // KEY_EVENT
    recs[0].KeyEvent.bKeyDown = 1; recs[0].KeyEvent.wRepeatCount = 1;
    recs[0].KeyEvent.wVirtualKeyCode = vk; recs[0].KeyEvent.uChar = ch;
    recs[1] = recs[0]; recs[1].KeyEvent.bKeyDown = 0;
    uint w; WriteConsoleInput(conin, recs, 2, out w);
  }
  // Attach to pid's console, type every char of `text` (no Enter), detach.
  public static string Type(uint pid, string text) {
    FreeConsole();
    if (!AttachConsole(pid)) return "AttachConsole failed: " + Marshal.GetLastWin32Error();
    try {
      conin = CreateFile("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (conin == (IntPtr)(-1)) return "CONIN$ open failed: " + Marshal.GetLastWin32Error();
      foreach (char c in text) { short v = VkKeyScan(c); One((ushort)(v & 0xFF), c); }
      return "ok";
    } finally { FreeConsole(); conin = (IntPtr)(-1); }
  }
  // Separate Enter press (after a delay) so the slash-command palette has rendered.
  public static string Enter(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return "AttachConsole failed: " + Marshal.GetLastWin32Error();
    try {
      conin = CreateFile("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (conin == (IntPtr)(-1)) return "CONIN$ open failed: " + Marshal.GetLastWin32Error();
      One(0x0D, '\r');
      return "ok";
    } finally { FreeConsole(); conin = (IntPtr)(-1); }
  }
  // Visible viewport text (so a confirm dialog can be detected before pressing Enter
  // again). Reads only srWindow rows — never stale scrollback. "" on any failure.
  public static string ReadScreen(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return "";
    try {
      IntPtr h = CreateFile("CONOUT$", 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero); // GENERIC_READ
      if (h == (IntPtr)(-1)) return "";
      CONSOLE_SCREEN_BUFFER_INFO info;
      if (!GetConsoleScreenBufferInfo(h, out info)) return "";
      int top = info.srWindow.Top;
      int rows = info.srWindow.Bottom - info.srWindow.Top + 1;
      if (rows <= 0) { top = 0; rows = info.dwSize.Y; }
      int cells = info.dwSize.X * rows;
      if (cells <= 0 || cells > 2000000) return "";
      var sb = new StringBuilder(cells);
      uint read; COORD origin; origin.X = 0; origin.Y = (short)top;
      if (!ReadConsoleOutputCharacter(h, sb, (uint)cells, origin, out read)) return "";
      return sb.ToString(0, (int)read);
    } finally { FreeConsole(); }
  }
}
"@

$t = [ConType]::Type([uint32]$ProcId, $Text)
Start-Sleep -Milliseconds $EnterDelayMs
$e = [ConType]::Enter([uint32]$ProcId)

# Confirm dialog (screen-guarded): only press Enter again when the dialog is actually
# on screen, so we never send a stray Enter into the prompt. The default-selected
# option is "Yes", so a single Enter confirms it.
$confirmed = 'no-dialog'
if ($ConfirmRegex) {
  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Milliseconds 250
    $screen = [ConType]::ReadScreen([uint32]$ProcId)
    if ($screen -and $screen -match $ConfirmRegex) {
      $confirmed = [ConType]::Enter([uint32]$ProcId)
      break
    }
  }
}
try { Write-Output "inject pid=$ProcId type=$t enter=$e confirm=$confirmed" } catch {}
