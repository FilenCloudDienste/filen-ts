import { existsSync } from "node:fs"
import { fail } from "../support.ts"
import type { Target } from "../targets.ts"
import { chooseDirectory, coreReport, keyringItems, mountedType, processStartMs, screenDump, sha256Through, uninstallDeb } from "./linux.ts"
import { windowsOs } from "./windows.ts"

// What the deep chains need from the desktop they run on, behind one interface per OS (linux.ts, windows.ts): the
// native folder chooser, the drive as the OS sees it, the secret store, quitting the app, crash evidence, screenshots
// and uninstalling the way a user does. Every call is bounded.

export interface DriveLocation {
	mountPoint: string | null
	driveLetter: string | null
}

export interface DesktopOs {
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
}

const linuxOs: DesktopOs = {
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
	}
}

export function osFor(target: Target): DesktopOs {
	switch (target.platform) {
		case "linux":
			return linuxOs
		case "win":
			return windowsOs
		default:
			return fail(`no deep chain support on ${target.platform} yet`)
	}
}
