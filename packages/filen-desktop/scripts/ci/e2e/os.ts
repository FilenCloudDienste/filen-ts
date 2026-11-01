import { existsSync, mkdirSync, realpathSync } from "node:fs"
import path from "node:path"
import { fail } from "../support.ts"
import type { Target } from "../targets.ts"
import {
	chooseDirectory,
	coreReport,
	keyringItems,
	mountedType,
	processesUnder,
	processStartMs,
	screenDump,
	sha256Through,
	uninstallDeb
} from "./linux.ts"
import { macOs } from "./mac.ts"
import { windowsOs } from "./windows.ts"

// What the deep chains need from the desktop they run on, behind one interface per OS (linux.ts, windows.ts): the
// native folder chooser, the drive as the OS sees it, the secret store, quitting the app, crash evidence, screenshots
// and uninstalling the way a user does. Every call is bounded.

// How long the app's directory call may wait for its dialog: what any driver below takes at most (finding the dialog,
// answering it, seeing it close or cancelling it), plus a margin.
export const CHOOSER_BUDGET_MS = 3 * 60 * 1000

export interface DriveLocation {
	mountPoint: string | null
	driveLetter: string | null
}

export interface DesktopOs {
	// Whether the old client (3.0.53) can mount its drive here: it mounts with FUSE-T on macOS, which needs an installer
	// run as an administrator and is not on hosted runners. Where it cannot, its drive settings are migrated all the same.
	readonly legacyDriveLive: boolean
	// Once per chain, before anything launches (crash dump registration, say).
	prepare(): Promise<void>
	// Answers the app's open-directory dialog titled `title` with `dir`; evidence files start with `evidence`.
	chooseDirectory(title: string, dir: string, evidence: string): Promise<void>
	// Where a configured drive is reached: its mount point, or the root of its letter.
	driveRoot(drive: DriveLocation): string | null
	// What is mounted at a drive root (a file system name), or null.
	driveMounted(root: string): Promise<string | null>
	// sha256 of a file read through the drive, bounded (a drive read can block).
	sha256Through(file: string, timeoutMs: number): Promise<string>
	// What the OS secret store holds for the app, by name only (information).
	secretStoreItems(userData: string): Promise<string[]>
	processStartMs(pid: number): Promise<number>
	// The crash report a main process left, or null.
	crashReport(executable: string, pid: number): Promise<string | null>
	screenDump(file: string): Promise<void>
	// Asks the app's main processes to quit gracefully (SIGTERM, or closing the window where there are no signals).
	requestQuit(pids: readonly number[]): Promise<void>
	// Removes the app the way a user does; what the removal itself must have taken is checked, and described.
	uninstall(target: Target): Promise<string>
	// Every process running from the app's install (helpers and rclone included), as "pid path".
	appProcesses(target: Target): Promise<string[]>
	// Ends processes at once (D13: for a tray-only app with neither a window nor a signal to quit it).
	forceKill(pids: readonly number[]): Promise<void>
	// The old client's drive setting under `base` (prepared), and where it is then reached.
	legacyDrive(base: string): { setting: string; root: string }
	// The quarantine attribute on the installed app, or null without one; absent where the OS has no such thing.
	quarantine?(target: Target): Promise<string | null>
}

const linuxOs: DesktopOs = {
	legacyDriveLive: true,
	// Core dumps are set up by the workflow (scripts/ci/deepSession.sh), for the whole D-Bus session.
	prepare: async () => undefined,
	chooseDirectory,
	driveRoot: drive => drive.mountPoint,
	driveMounted: mountedType,
	sha256Through,
	secretStoreItems: () => keyringItems("Filen"),
	processStartMs: async pid => processStartMs(pid),
	crashReport: coreReport,
	screenDump,
	async requestQuit(pids) {
		for (const pid of pids) {
			try {
				process.kill(pid, "SIGTERM")
			} catch {
				// Already gone.
			}
		}
	},
	async uninstall(target) {
		if (target.format !== "deb") {
			fail(`no uninstall for a Linux ${target.format}`)
		}

		uninstallDeb()

		if (existsSync("/etc/apparmor.d/Filen")) {
			fail("/etc/apparmor.d/Filen is still there")
		}

		return "apt-get remove and purge: /opt/Filen and its AppArmor profile gone"
	},
	appProcesses: async target => processesUnder(`${path.dirname(target.executable)}/`),
	async forceKill(pids) {
		for (const pid of pids) {
			try {
				process.kill(pid, "SIGKILL")
			} catch {
				// Already gone.
			}
		}
	},
	// An empty directory beside the chain's own, which 3.x mounts on and 4.x reaches by its real path.
	legacyDrive(base) {
		const dir = `${base}-mnt`

		mkdirSync(dir, { recursive: true })

		return { setting: dir, root: realpathSync(dir) }
	}
}

export function osFor(target: Target): DesktopOs {
	switch (target.platform) {
		case "linux":
			return linuxOs
		case "win":
			return windowsOs
		case "mac":
			return macOs
		default:
			return fail(`no deep chain support on ${target.platform} yet`)
	}
}
