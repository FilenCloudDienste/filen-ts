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

// The dialog is an owned window, which UI Automation lists under its owner (the app's window), not at the desktop's
// top: it is searched among all descendants as a Window named by its title. Its "Folder:" box is the dialog's
// file-name edit (AutomationId 1152 on every Windows to date; else the edit named "Folder:", else its last edit) and
// "Select Folder" its OK button (AutomationId 1, else the button of that name): the full path in the box, then the
// button, selects that folder. Value and Invoke patterns need no focus; where a pattern is refused, the keyboard does
// the same (the box has focus when the dialog opens). Each step says what it found, for the log.
function chooserScript(title: string, dir: string): string {
	return `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
$A = [System.Windows.Automation.AutomationElement]
$C = [System.Windows.Automation.ControlType]
$scope = [System.Windows.Automation.TreeScope]
function Prop($property, $value) { New-Object System.Windows.Automation.PropertyCondition($property, $value) }
function Keys($text) { [System.Windows.Forms.SendKeys]::SendWait(($text -replace '([+^%~(){}\\[\\]])', '{$1}')) }
$deadline = (Get-Date).AddSeconds(60)
$byTitle = New-Object System.Windows.Automation.AndCondition((Prop $A::ControlTypeProperty $C::Window), (Prop $A::NameProperty ${psQuote(title)}))
$dialog = $null
while ($null -eq $dialog -and (Get-Date) -lt $deadline) {
	$dialog = $A::RootElement.FindFirst($scope::Descendants, $byTitle)
	if ($null -eq $dialog) { Start-Sleep -Milliseconds 500 }
}
if ($null -eq $dialog) { throw ${psQuote(`no window titled "${title}" within 60 s`)} }
"dialog: pid $($dialog.Current.ProcessId), class $($dialog.Current.ClassName)"
$edit = $null
while ($null -eq $edit -and (Get-Date) -lt $deadline) {
	$edits = @($dialog.FindAll($scope::Descendants, (Prop $A::ControlTypeProperty $C::Edit)))
	$edit = @($edits | Where-Object { $_.Current.AutomationId -eq '1152' })[0]
	if ($null -eq $edit) { $edit = @($edits | Where-Object { $_.Current.Name -like 'Folder*' })[0] }
	if ($null -eq $edit -and $edits.Count -gt 0) { $edit = $edits[-1] }
	if ($null -eq $edit) { Start-Sleep -Milliseconds 500 }
}
if ($null -eq $edit) { throw 'the dialog has no Folder box' }
"folder box: id '$($edit.Current.AutomationId)', name '$($edit.Current.Name)'"
$typed = $false
try {
	$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue(${psQuote(dir)})
	"folder set through ValuePattern"
} catch {
	$dialog.SetFocus()
	$edit.SetFocus()
	Keys ${psQuote(dir)}
	$typed = $true
	"folder typed with the keyboard: $($_.Exception.Message)"
}
$buttons = @($dialog.FindAll($scope::Descendants, (Prop $A::ControlTypeProperty $C::Button)))
$button = @($buttons | Where-Object { $_.Current.AutomationId -eq '1' })[0]
if ($null -eq $button) { $button = @($buttons | Where-Object { $_.Current.Name -eq 'Select Folder' })[0] }
if ($null -ne $button -and -not $typed) {
	try {
		$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
		"answered with '$($button.Current.Name)'"
		return
	} catch { "the button refused Invoke: $($_.Exception.Message)" }
}
$edit.SetFocus()
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
"answered with Enter"
`
}

export const windowsOs: DesktopOs = {
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
	}
}
