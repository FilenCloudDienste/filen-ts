import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fail, runBounded } from "../support.ts"
import type { DesktopOs } from "./os.ts"

// macOS pieces of the deep chains, every tool bounded: the folder chooser (NSOpenPanel, as a sheet on the app's window)
// driven with System Events, which hosted runners allow: their image grants osascript and bash Accessibility and
// AppleEvents to System Events (actions/runner-images configure-tccdb-macos.sh); the drive as the mount table shows
// it (rclone's NFS mount without macFUSE, which hosted runners cannot load); the login keychain's "Filen Safe
// Storage" item; crash reports from ~/Library/Logs/DiagnosticReports; screencapture; SIGTERM as the quit; and the
// uninstall a user does (the app moved out of /Applications).

const TOOL_TIMEOUT_MS = 30_000
const CHOOSER_TIMEOUT_MS = 90_000
const REPORTS = path.join(os.homedir(), "Library", "Logs", "DiagnosticReports")

// Answers the open panel of process "Filen" (a sheet on its window, or a window of its own): Go to Folder
// (Cmd+Shift+G), the path, Return to go there, Return for the panel's default button (Open), which chooses the folder
// it shows. The panel must then be gone. The path comes in as the script's argument, never inside its text.
const CHOOSER = `
on panelOf(theProcess)
	tell application "System Events"
		tell theProcess
			repeat with theWindow in windows
				if exists sheet 1 of theWindow then return sheet 1 of theWindow
			end repeat
			repeat with theWindow in windows
				if exists (button "Open" of theWindow) then return theWindow
			end repeat
		end tell
	end tell
	return missing value
end panelOf

on run argv
	set thePath to item 1 of argv
	with timeout of 60 seconds
		tell application "System Events"
			set theProcess to first process whose name is "Filen"
			set frontmost of theProcess to true
			set thePanel to missing value
			repeat 60 times
				set thePanel to my panelOf(theProcess)
				if thePanel is not missing value then exit repeat
				delay 0.5
			end repeat
			if thePanel is missing value then error "no open panel on Filen's windows within 30 s"
			keystroke "g" using {command down, shift down}
			delay 1
			keystroke thePath
			delay 0.5
			key code 36
			delay 1.5
			key code 36
			repeat 20 times
				if my panelOf(theProcess) is missing value then return "answered: the panel closed"
				delay 0.5
			end repeat
			key code 53
			error "the panel stayed open after the path and Open; cancelled"
		end tell
	end timeout
end run
`

// An error that means the runner gave this process no Accessibility (or AppleEvents to System Events).
function deniedAccess(text: string): boolean {
	return /-1719|-25211|-1743|assistive access|not allowed to send keystrokes|Not authorized to send Apple events/i.test(text)
}

export const macOs: DesktopOs = {
	// No kernel extension loads on hosted runners: the drive mounts only if rclone's NFS mount works there.
	liveDrive: false,
	// Whether System Events answers this process at all, logged for the run (a refusal names itself later too).
	async prepare() {
		const probe = await runBounded(
			"osascript",
			["-e", 'tell application "System Events" to get name of first process'],
			TOOL_TIMEOUT_MS
		)

		console.log(
			`System Events probe: ${probe.status === 0 ? `answered (${probe.stdout.trim()})` : `${probe.timedOut ? "timed out" : `exit ${String(probe.status)}`} ${probe.stderr.trim()}`}`
		)
	},

	async chooseDirectory(_title, dir, evidence) {
		const result = await runBounded("osascript", ["-", dir], CHOOSER_TIMEOUT_MS, { input: CHOOSER })

		console.log(result.stdout.trim())

		if (result.status !== 0) {
			await macOs.screenDump(`${evidence}-failed.png`)

			const why = result.timedOut ? "timed out" : result.stderr.trim()

			fail(
				deniedAccess(why)
					? `osascript has no Accessibility for System Events on this runner: ${why}`
					: `the open panel: ${why} (see ${path.basename(evidence)}-failed.png)`
			)
		}
	},

	driveRoot: drive => drive.mountPoint,

	// The file system type the mount table lists at `root` (nfs for rclone's NFS mount, macfuse with macFUSE).
	async driveMounted(root) {
		const result = await runBounded("mount", [], TOOL_TIMEOUT_MS)
		const real = existsSync(root) ? realpathSync(root) : root
		const line = result.stdout.split("\n").find(entry => entry.includes(` on ${root} (`) || entry.includes(` on ${real} (`))

		return line === undefined ? null : (/ \(([^,)]+)/.exec(line)?.[1] ?? "mounted")
	},

	async sha256Through(file, timeoutMs) {
		const result = await runBounded("shasum", ["-a", "256", file], timeoutMs)

		if (result.status !== 0) {
			fail(`shasum ${file}: ${result.timedOut ? "timed out" : result.stderr.trim()}`)
		}

		return result.stdout.split(" ")[0] ?? ""
	},

	// The login keychain's item Chromium keeps the app's key in (attributes only: the secret is never asked for).
	async secretStoreItems() {
		const result = await runBounded("security", ["find-generic-password", "-s", "Filen Safe Storage"], TOOL_TIMEOUT_MS)

		return result.status === 0 ? ['login keychain "Filen Safe Storage"'] : []
	},

	async processStartMs(pid) {
		const result = await runBounded("ps", ["-o", "lstart=", "-p", String(pid)], TOOL_TIMEOUT_MS)
		const started = Date.parse(result.stdout.trim())

		if (!Number.isFinite(started)) {
			fail(`cannot read when process ${String(pid)} started`)
		}

		return started
	},

	// A crash report macOS wrote for the process (<name>-<date>.ips, its header naming the pid).
	async crashReport(executable, pid) {
		const name = path.basename(executable)

		for (const file of existsSync(REPORTS) ? readdirSync(REPORTS).filter(entry => entry.startsWith(`${name}-`)) : []) {
			const text = readFileSync(path.join(REPORTS, file), "utf8")

			if (new RegExp(`"pid"\\s*:\\s*${String(pid)}\\b`).test(text)) {
				return `${file}\n${text.slice(0, 20_000)}`
			}
		}

		return null
	},

	async screenDump(file) {
		await runBounded("screencapture", ["-x", file], TOOL_TIMEOUT_MS)
	},

	async requestQuit(pids) {
		for (const pid of pids) {
			try {
				process.kill(pid, "SIGTERM")
			} catch {
				// Already gone.
			}
		}
	},

	// What a user does: the app out of /Applications. macOS removes nothing else; what stays is the inventory's.
	async uninstall(target) {
		const app = path.resolve(target.executable, "..", "..", "..")

		rmSync(app, { recursive: true, force: true })

		if (existsSync(app)) {
			fail(`${app} is still there`)
		}

		return `${app} removed (macOS keeps app data, caches and the keychain item; see the inventory)`
	},

	async appProcesses(target) {
		const app = path.resolve(target.executable, "..", "..", "..")
		const result = await runBounded("ps", ["-axo", "pid=,comm="], TOOL_TIMEOUT_MS)

		return result.stdout
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.includes(`${app}/`))
	},

	async forceKill(pids) {
		for (const pid of pids) {
			try {
				process.kill(pid, "SIGKILL")
			} catch {
				// Already gone.
			}
		}
	},

	// An empty directory beside the chain's own, as on Linux.
	legacyDrive(base) {
		const dir = `${base}-mnt`

		mkdirSync(dir, { recursive: true })

		return { setting: dir, root: realpathSync(dir) }
	}
}
