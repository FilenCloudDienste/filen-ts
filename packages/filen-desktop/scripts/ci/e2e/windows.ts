import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { type BoundedResult, fail, powershellBounded, psQuote } from "../support.ts"
import type { DesktopOs } from "./os.ts"

// Windows pieces of the deep chains, all through bounded PowerShell: the folder chooser (the common IFileDialog in
// pick-folders mode) driven with UI Automation, the drive as a WinFsp letter, DPAPI for secure storage (no store items:
// Chromium keeps its key in userData/Local State), WER LocalDumps for crash evidence, a screen capture, closing the
// window as the graceful quit, and the app's own NSIS uninstaller.

const TOOL_TIMEOUT_MS = 60_000
const CHOOSER_TIMEOUT_MS = 90_000
export const DUMP_DIR = "C:\\filen-e2e-dumps"

function output(result: BoundedResult, what: string): string {
	if (result.status !== 0) {
		fail(`${what}: ${result.timedOut ? "timed out" : `exit ${String(result.status)}`} ${result.stderr.trim().slice(-1000)}`)
	}

	return result.stdout.trim()
}

async function ps(what: string, script: string, timeoutMs = TOOL_TIMEOUT_MS): Promise<string> {
	return output(await powershellBounded(script, timeoutMs), what)
}

// The dialog, driven through Win32 messages, which need neither focus nor the foreground (UI Automation's view of this
// dialog proved incomplete, then unfocusable): it is the visible top-level #32770 window with the title. Its "Folder:"
// box is the edit with control id 1152 among its descendants, else the Edit inside its ComboBoxEx32 (id 1148). The
// path is typed in (WM_CHAR, so the dialog's model of the name follows; WM_SETTEXT alone left it empty) and read back;
// then Select Folder (BM_CLICK on control 1), else Enter in the box, else WM_COMMAND IDOK, each given 5 s to close the
// window. The answer counts only once the window is gone; a window still there is cancelled (WM_COMMAND IDCANCEL), so
// the app's call returns. Each step says what it found, for the log.
const WIN32 = `
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FilenE2eDialog {
	delegate bool EnumProc(IntPtr hwnd, IntPtr param);
	[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr param);
	[DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr param);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
	[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
	[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
	[DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr hwnd);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wParam, string lParam);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wParam, StringBuilder lParam);
	[DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
	[DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr dialog, int id);
	[DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
	const uint WM_SETTEXT = 0x000C, WM_GETTEXT = 0x000D, WM_COMMAND = 0x0111, WM_CHAR = 0x0102, WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, BM_CLICK = 0x00F5;
	const int VK_RETURN = 0x0D;
	static string Class(IntPtr hwnd) { var name = new StringBuilder(256); GetClassName(hwnd, name, 256); return name.ToString(); }
	public static IntPtr Dialog(string title) {
		IntPtr found = IntPtr.Zero;
		EnumWindows((hwnd, param) => {
			if (Class(hwnd) != "#32770" || !IsWindowVisible(hwnd)) return true;
			var text = new StringBuilder(512);
			GetWindowText(hwnd, text, 512);
			if (text.ToString() != title) return true;
			found = hwnd;
			return false;
		}, IntPtr.Zero);
		return found;
	}
	public static IntPtr FolderBox(IntPtr dialog) {
		IntPtr byId = IntPtr.Zero, comboEx = IntPtr.Zero;
		EnumChildWindows(dialog, (hwnd, param) => {
			string cls = Class(hwnd);
			int id = GetDlgCtrlID(hwnd);
			if (cls == "Edit" && id == 1152 && byId == IntPtr.Zero) byId = hwnd;
			if (cls == "ComboBoxEx32" && id == 1148 && comboEx == IntPtr.Zero) comboEx = hwnd;
			return true;
		}, IntPtr.Zero);
		if (byId != IntPtr.Zero) return byId;
		if (comboEx == IntPtr.Zero) return IntPtr.Zero;
		IntPtr combo = FindWindowEx(comboEx, IntPtr.Zero, "ComboBox", null);
		return combo == IntPtr.Zero ? IntPtr.Zero : FindWindowEx(combo, IntPtr.Zero, "Edit", null);
	}
	// Typed, not set: WM_CHAR per character makes the edit notify its owners as a keyboard does, so the dialog's own
	// model of the name follows (WM_SETTEXT changes only the text). Cleared first; returns what the box then holds.
	public static string TypeText(IntPtr edit, string value) {
		SendMessage(edit, WM_SETTEXT, IntPtr.Zero, "");
		foreach (char c in value) SendMessage(edit, WM_CHAR, (IntPtr)c, (IntPtr)1);
		var text = new StringBuilder(32768);
		SendMessage(edit, WM_GETTEXT, (IntPtr)32768, text);
		return text.ToString();
	}
	public static bool Click(IntPtr button) { return PostMessage(button, BM_CLICK, IntPtr.Zero, IntPtr.Zero); }
	public static bool Enter(IntPtr edit) {
		return PostMessage(edit, WM_KEYDOWN, (IntPtr)VK_RETURN, (IntPtr)1) && PostMessage(edit, WM_KEYUP, (IntPtr)VK_RETURN, (IntPtr)unchecked((int)0xC0000001));
	}
	public static IntPtr Button(IntPtr dialog, int id) { return GetDlgItem(dialog, id); }
	public static bool Command(IntPtr dialog, int id) { return PostMessage(dialog, WM_COMMAND, (IntPtr)id, IntPtr.Zero); }
	public static string Describe(IntPtr hwnd) { return Class(hwnd) + " id " + GetDlgCtrlID(hwnd); }
}
`

function chooserScript(title: string, dir: string): string {
	return `
Add-Type -TypeDefinition @'
${WIN32}
'@
$deadline = (Get-Date).AddSeconds(60)
$dialog = [IntPtr]::Zero
while ($dialog -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) {
	$dialog = [FilenE2eDialog]::Dialog(${psQuote(title)})
	if ($dialog -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 500 }
}
if ($dialog -eq [IntPtr]::Zero) { throw ${psQuote(`no #32770 window titled "${title}" within 60 s`)} }
"dialog: hwnd $dialog"
$edit = [IntPtr]::Zero
while ($edit -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) {
	$edit = [FilenE2eDialog]::FolderBox($dialog)
	if ($edit -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 500 }
}
$closed = $false
function Gone($seconds) {
	$until = (Get-Date).AddSeconds($seconds)
	while ((Get-Date) -lt $until) {
		if (-not [FilenE2eDialog]::IsWindow($dialog)) { return $true }
		Start-Sleep -Milliseconds 250
	}
	return $false
}
if ($edit -eq [IntPtr]::Zero) {
	"no Folder box (Edit 1152, or the Edit in ComboBoxEx32 1148) found"
} else {
	"folder box: $([FilenE2eDialog]::Describe($edit))"
	$read = [FilenE2eDialog]::TypeText($edit, ${psQuote(dir)})
	if ($read -ne ${psQuote(dir)}) {
		"the folder box reads back '$read' after typing"
	} else {
		"folder typed with WM_CHAR"
		$button = [FilenE2eDialog]::Button($dialog, 1)
		if ($button -ne [IntPtr]::Zero) {
			"Select Folder ($([FilenE2eDialog]::Describe($button))) clicked: $([FilenE2eDialog]::Click($button))"
			$closed = Gone 5
		}
		if (-not $closed) {
			"Enter in the folder box: $([FilenE2eDialog]::Enter($edit))"
			$closed = Gone 5
		}
		if (-not $closed) {
			"WM_COMMAND IDOK posted: $([FilenE2eDialog]::Command($dialog, 1))"
			$closed = Gone 5
		}
	}
}
if ($closed) { "the dialog closed"; exit 0 }
[void][FilenE2eDialog]::Command($dialog, 2)
throw 'the dialog was not answered; cancelled'
`
}

// Every process running from an executable below `dir`, as "pid path".
export async function windowsProcessesUnder(dir: string): Promise<string[]> {
	const found = await ps(
		`list the processes under ${dir}`,
		`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith(${psQuote(path.join(dir, path.sep))}, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { "$($_.ProcessId) $($_.ExecutablePath)" }`
	)

	return found.split(/\r?\n/).filter(line => line.trim() !== "")
}

export const windowsOs: DesktopOs = {
	legacyDriveLive: true,
	async prepare() {
		// WER writes a full dump of a crashing Filen.exe here (<exe>.<pid>.dmp), at most ten.
		await ps(
			"register WER LocalDumps",
			`
$key = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps\\Filen.exe'
New-Item -Force -Path $key | Out-Null
New-Item -Force -ItemType Directory -Path ${psQuote(DUMP_DIR)} | Out-Null
Set-ItemProperty -Path $key -Name DumpFolder -Value ${psQuote(DUMP_DIR)} -Type ExpandString
Set-ItemProperty -Path $key -Name DumpType -Value 1 -Type DWord
Set-ItemProperty -Path $key -Name DumpCount -Value 10 -Type DWord
`
		)
	},

	async chooseDirectory(title, dir, evidence) {
		const result = await powershellBounded(chooserScript(title, dir), CHOOSER_TIMEOUT_MS)

		console.log(result.stdout.trim())

		if (result.status !== 0) {
			await windowsOs.screenDump(`${evidence}-failed.png`)
			output(result, `the "${title}" dialog`)
		}
	},

	driveRoot: drive => (drive.driveLetter === null ? null : `${drive.driveLetter}:\\`),

	async driveMounted(root) {
		const format = await ps(
			"read the drive",
			`$drive = New-Object System.IO.DriveInfo(${psQuote(root)}); if ($drive.IsReady) { $drive.DriveFormat } else { '' }`
		)

		return format === "" ? null : format
	},

	async sha256Through(file, timeoutMs) {
		return (await ps(`hash ${file}`, `(Get-FileHash -Algorithm SHA256 -LiteralPath ${psQuote(file)}).Hash`, timeoutMs)).toLowerCase()
	},

	// DPAPI keeps nothing in a store: Chromium's key is userData/Local State's os_crypt.encrypted_key, bound to the user.
	async secretStoreItems(userData) {
		const localState = path.join(userData, "Local State")

		if (!existsSync(localState)) {
			return []
		}

		const state = JSON.parse(readFileSync(localState, "utf8")) as { os_crypt?: { encrypted_key?: unknown } }

		return typeof state.os_crypt?.encrypted_key === "string" ? ["Local State os_crypt.encrypted_key (DPAPI)"] : []
	},

	async processStartMs(pid) {
		return Number(
			await ps("read a start time", `([DateTimeOffset](Get-Process -Id ${String(pid)}).StartTime).ToUnixTimeMilliseconds()`)
		)
	},

	async crashReport(executable, pid) {
		const name = `${path.basename(executable)}.${String(pid)}.dmp`
		const file = path.join(DUMP_DIR, name)

		return existsSync(file) ? `${name}: ${String(statSync(file).size)} bytes (WER full dump in ${DUMP_DIR})` : null
	},

	async screenDump(file) {
		await powershellBounded(
			`
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$area = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $area.Width, $area.Height
[System.Drawing.Graphics]::FromImage($bitmap).CopyFromScreen($area.Left, $area.Top, 0, 0, $bitmap.Size)
$bitmap.Save(${psQuote(file)}, [System.Drawing.Imaging.ImageFormat]::Png)
`,
			TOOL_TIMEOUT_MS
		)
	},

	// No signals: closing the main window is the user's quit while minimizeToTray is off (the window then quits the
	// app). A process without a window to close cannot be quit gracefully here.
	async requestQuit(pids) {
		for (const pid of pids) {
			const closed = await ps(
				"close the window",
				`$p = Get-Process -Id ${String(pid)} -ErrorAction SilentlyContinue; if ($null -eq $p) { 'gone' } else { [string]$p.CloseMainWindow() }`
			)

			if (closed === "False") {
				fail(`process ${String(pid)} has no window to close`)
			}
		}
	},

	// The installed uninstaller as Add or Remove Programs runs it (silently, without --updated, so it deletes the app
	// data); `_?=` keeps it in place and synchronous.
	async uninstall(target) {
		const installDir = path.dirname(target.executable)
		const uninstaller = path.join(installDir, "Uninstall Filen.exe")

		await ps(
			"run the uninstaller",
			`$p = Start-Process -FilePath ${psQuote(uninstaller)} -ArgumentList ${psQuote(`/S _?=${installDir}`)} -Wait -PassThru; "exit $($p.ExitCode)"`,
			5 * 60 * 1000
		)

		const left = [
			...(existsSync(target.executable) ? [target.executable] : []),
			...(target.registeredVersion() === null ? [] : ["the uninstall entry"]),
			...(existsSync(target.userData) ? [target.userData] : []),
			...(existsSync(installDir) ? readdirSync(installDir).filter(name => name !== "Uninstall Filen.exe") : [])
		]

		if (left.length > 0) {
			fail(`left after the uninstaller: ${left.join(", ")}`)
		}

		return "the NSIS uninstaller removed the app, its uninstall entry and its app data"
	},

	appProcesses: async target => windowsProcessesUnder(path.dirname(target.executable)),

	async forceKill(pids) {
		for (const pid of pids) {
			await powershellBounded(`taskkill.exe /F /T /PID ${String(pid)} | Out-Null`, TOOL_TIMEOUT_MS)
		}
	},

	// The old client mounted on a drive letter (its default X:); 4.x imports the letter.
	legacyDrive: () => ({ setting: "X:", root: "X:\\" })
}
