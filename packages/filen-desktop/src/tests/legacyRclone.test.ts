import { describe, expect, it, vi } from "vitest"
import type { ProgramResult } from "../main/mounts/fuse.ts"
import {
	endLegacyDriveRclone,
	isLegacyDriveRclone,
	type LegacyDriveRclone,
	type LegacyRcloneDeps,
	LIST_SCRIPT,
	parseRcloneList,
	type RcloneProcess,
	windowsArgv
} from "../main/mounts/legacyRclone.ts"

const APPDATA = String.raw`C:\Users\Jane Doe\AppData\Roaming`
const USER_DATA = String.raw`${APPDATA}\@filen\desktop`
const DIR = String.raw`${APPDATA}\@filen\network-drive`
const BINARY = String.raw`${DIR}\filen_rclone_win32_x64_1680.exe`
const EXPECTED: LegacyDriveRclone = { dir: DIR, cacheDir: String.raw`${USER_DATA}\networkDrive\cache`, driveLetter: "X" }

// The command line rclone gets from @filen/network-drive 0.9.42 (NetworkDrive.rcloneArgs, spawned through cmd.exe
// with `shell`: the quoted binary and the arguments joined by spaces). 3.0.47's desktop passes `cachePath`
// (<userData>/networkDrive/cache) and `logFilePath` (<appData>/@filen/logs/rclone.log); `filen mount` (@filen/cli)
// passes neither, so the cache is <network-drive>/cache and there is no log file.
function commandLine(options: { mountPoint?: string; cacheDir: string; logFile?: string; readOnly?: boolean }): string {
	return [
		`"${BINARY}"`,
		`mount Filen: "${options.mountPoint ?? "X:"}"`,
		`--config "${DIR}\\rclone.conf"`,
		"--vfs-cache-mode full",
		...(options.readOnly === true ? ["--read-only"] : []),
		`--cache-dir "${options.cacheDir}"`,
		'--vfs-cache-max-size "95Gi"',
		"--vfs-cache-min-free-space 5Gi",
		"--rc",
		'--rc-addr "127.0.0.1:51234"',
		...(options.logFile === undefined ? [] : [`--log-file "${options.logFile}"`]),
		"--devname Filen",
		"--volname \\\\Filen\\\\Filen",
		'-o FileSecurity="D:P(A;;FA;;;WD)"',
		"--network-mode"
	].join(" ")
}

const DESKTOP = commandLine({ cacheDir: EXPECTED.cacheDir, logFile: String.raw`${APPDATA}\@filen\logs\rclone.log` })
const CLI = commandLine({ cacheDir: String.raw`${DIR}\cache` })

function rclone(overrides: Partial<RcloneProcess> = {}): RcloneProcess {
	return { pid: 4242, orphan: true, path: BINARY, commandLine: DESKTOP, ...overrides }
}

describe("windowsArgv", () => {
	it("splits as CommandLineToArgvW does", () => {
		expect(windowsArgv(String.raw`"C:\a b\x.exe" mount  Filen: "X:"`)).toEqual([String.raw`C:\a b\x.exe`, "mount", "Filen:", "X:"])
		expect(windowsArgv(String.raw`a\\b "c\\" d\"e "f""g" ""`)).toEqual([String.raw`a\\b`, "c\\", 'd"e', 'f"g', ""])
		expect(windowsArgv('-o FileSecurity="D:P(A;;FA;;;WD)"\t--network-mode ')).toEqual([
			"-o",
			"FileSecurity=D:P(A;;FA;;;WD)",
			"--network-mode"
		])
	})
})

describe("isLegacyDriveRclone", () => {
	it("matches the rclone 3.0.47's desktop started for the imported letter", () => {
		expect(isLegacyDriveRclone(rclone(), EXPECTED)).toBe(true)
		expect(
			isLegacyDriveRclone(
				rclone({ path: BINARY.toLowerCase(), commandLine: commandLine({ cacheDir: EXPECTED.cacheDir.toUpperCase() }) }),
				EXPECTED
			)
		).toBe(true)
		expect(
			isLegacyDriveRclone(
				rclone({ commandLine: commandLine({ mountPoint: "x", cacheDir: EXPECTED.cacheDir, readOnly: true }) }),
				EXPECTED
			)
		).toBe(true)
	})

	it("never matches the Filen CLI's rclone, same binary, directory and letter", () => {
		expect(isLegacyDriveRclone(rclone({ commandLine: CLI }), EXPECTED)).toBe(false)
	})

	it("never matches one whose parent still runs: a running 3.x app or CLI", () => {
		expect(isLegacyDriveRclone(rclone({ orphan: false }), EXPECTED)).toBe(false)
	})

	it("never matches another letter, another binary or an unreadable process", () => {
		expect(isLegacyDriveRclone(rclone({ commandLine: commandLine({ mountPoint: "Y:", cacheDir: EXPECTED.cacheDir }) }), EXPECTED)).toBe(
			false
		)
		expect(isLegacyDriveRclone(rclone({ path: String.raw`C:\Program Files\Filen\resources\rclone\rclone.exe` }), EXPECTED)).toBe(false)
		expect(isLegacyDriveRclone(rclone({ path: String.raw`${DIR}\rclone.exe` }), EXPECTED)).toBe(false)
		expect(isLegacyDriveRclone(rclone({ path: String.raw`${DIR}\cache\filen_rclone_win32_x64_1680.exe` }), EXPECTED)).toBe(false)
		expect(isLegacyDriveRclone(rclone({ path: null }), EXPECTED)).toBe(false)
		expect(isLegacyDriveRclone(rclone({ commandLine: null }), EXPECTED)).toBe(false)
		expect(
			isLegacyDriveRclone(rclone({ commandLine: `"${BINARY}" serve webdav Filen: --cache-dir "${EXPECTED.cacheDir}"` }), EXPECTED)
		).toBe(false)
		expect(
			isLegacyDriveRclone(rclone({ commandLine: DESKTOP.replace(`${DIR}\\rclone.conf`, String.raw`C:\other\rclone.conf`) }), EXPECTED)
		).toBe(false)
	})
})

describe("parseRcloneList", () => {
	it("takes PowerShell's JSON and nothing else", () => {
		expect(parseRcloneList("[]")).toEqual([])
		expect(parseRcloneList(JSON.stringify([{ ...rclone(), extra: 1 }]))).toEqual([rclone()])
		expect(parseRcloneList("")).toBeNull()
		expect(parseRcloneList(JSON.stringify({ pid: 1 }))).toBeNull()
		expect(parseRcloneList(JSON.stringify([{ ...rclone(), pid: "1" }]))).toBeNull()
	})
})

describe("endLegacyDriveRclone", () => {
	const DRIVE = { enabled: true, mountPoint: "X:", readOnly: false }

	function setup(platform: NodeJS.Platform, listed: ProgramResult) {
		const gone = new Set<number>()
		const deps = {
			platform,
			userData: USER_DATA,
			env: { SystemRoot: String.raw`C:\Windows` },
			run: vi.fn((_file: string, _args: readonly string[]) => Promise.resolve(listed)),
			kill: vi.fn((pid: number, signal?: number) => {
				if (gone.has(pid)) {
					throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
				}

				if (signal === undefined) {
					gone.add(pid)
				}
			}),
			log: { info: vi.fn(), warn: vi.fn() }
		} satisfies LegacyRcloneDeps

		return deps
	}

	const list = (...processes: RcloneProcess[]): ProgramResult => ({ code: 0, stdout: JSON.stringify(processes) })

	it("ends only 3.0.47's desktop rclone, from one PowerShell listing, and logs it", async () => {
		const deps = setup("win32", list(rclone({ pid: 7, commandLine: CLI }), rclone({ pid: 8 }), rclone({ pid: 9, orphan: false })))

		await endLegacyDriveRclone(deps, DRIVE)

		expect(deps.run).toHaveBeenCalledTimes(1)
		expect(deps.run).toHaveBeenCalledWith(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			LIST_SCRIPT
		])
		expect(deps.kill.mock.calls.filter(([, signal]) => signal === undefined)).toEqual([[8]])
		expect(deps.log.info).toHaveBeenCalledWith(
			"mounts: ended the rclone 3.0.47 left running on X: (pid 8, filen_rclone_win32_x64_1680.exe)"
		)
		expect(deps.log.info).toHaveBeenCalledWith("mounts: 2 other filen rclone left alone (not 3.0.47's drive on X:)")
		expect(deps.log.warn).not.toHaveBeenCalled()
	})

	it("looks for nothing off Windows or where the old drive was off", async () => {
		for (const [platform, drive] of [
			["linux", DRIVE],
			["darwin", DRIVE],
			["win32", { ...DRIVE, enabled: false }],
			["win32", { enabled: true, mountPoint: "C:" }],
			["win32", undefined]
		] as const) {
			const deps = setup(platform, list(rclone()))

			await endLegacyDriveRclone(deps, drive)
			expect(deps.run).not.toHaveBeenCalled()
			expect(deps.kill).not.toHaveBeenCalled()
		}
	})

	it("ends nothing when the listing failed", async () => {
		for (const listed of [
			{ code: 1, stdout: "" },
			{ code: 0, stdout: "not json" }
		]) {
			const deps = setup("win32", listed)

			await endLegacyDriveRclone(deps, DRIVE)
			expect(deps.kill).not.toHaveBeenCalled()
			expect(deps.log.warn).toHaveBeenCalledTimes(1)
		}
	})

	it("warns and goes on when ending it is refused", async () => {
		const deps = setup("win32", list(rclone()))

		deps.kill.mockImplementationOnce(() => {
			throw Object.assign(new Error("kill EPERM"), { code: "EPERM" })
		})
		await endLegacyDriveRclone(deps, DRIVE)
		expect(deps.log.warn).toHaveBeenCalledWith("mounts: the rclone 3.0.47 left running on X: was not ended: EPERM")
	})
})
