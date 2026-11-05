import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { type } from "arktype"
import { errorCode } from "../atomicFile.ts"
import { type FuseContext, type ProgramResult, system32 } from "./fuse.ts"
import { driveLetterOf, legacyDriveLetter } from "./legacyMounts.ts"

// 3.0.47's network drive (@filen/network-drive 0.9.x) on Windows: its rclone outlives the app's tray Exit (app.exit(0))
// with the drive letter mounted. rclone runs through cmd.exe, which libuv's job object kills with the app; rclone, the
// grandchild, breaks away, and the watchdog that would end it dies with its own cmd.exe. 3.0.47's next start ends it
// (taskkill by image name); a 4.x update never starts 3.0.47 again, so the migration ends it before the imported drive
// mounts on that letter. @filen/cli runs the same binary from the same directory (`filen mount`), so only an rclone
// started as 3.0.47's desktop starts it is ended:
//   - its executable is filen_rclone_win32_<arch>_<version>.exe in `<appData>/@filen/network-drive`
//   - `mount Filen: <letter>`, the letter the drive used in 3.x
//   - `--config <network-drive>\rclone.conf` and `--cache-dir <userData>\networkDrive\cache`: the desktop passes its
//     userData's cache (3.0.47 forces localDirPath to `<userData>/networkDrive`), the CLI passes none, so its rclone
//     caches in `<network-drive>\cache`
//   - its parent (cmd.exe) is gone: a running 3.x app or CLI keeps it alive. 3.x cannot run anyway: it shares this
//     app's userData, whose single-instance lock this app holds.

const RCLONE_IMAGE = /^filen_rclone_win32_[a-z0-9]+_\d+\.exe$/i
const RCLONE_LIKE = "filen[_]rclone[_]win32[_]%"
// How long an ended rclone may take to go before the migration touches its cache and letter.
const EXIT_WAIT_MS = 5000
const EXIT_POLL_MS = 100

// Every rclone running from an image of that name, with whether its parent is gone (absent, or a later process that
// took its id): one CIM query, plus one per match for its parent. UTF-8 so that paths outside the code page survive.
export const LIST_SCRIPT = [
	"$ErrorActionPreference = 'Stop';",
	"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
	`$found = @(Get-CimInstance Win32_Process -Filter "Name LIKE '${RCLONE_LIKE}'" | ForEach-Object {`,
	'$parent = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $_.ParentProcessId);',
	"[pscustomobject]@{ pid = [int]$_.ProcessId; orphan = (($null -eq $parent) -or ($parent.CreationDate -gt $_.CreationDate)); path = $_.ExecutablePath; commandLine = $_.CommandLine }",
	"});",
	"ConvertTo-Json -InputObject $found -Compress"
].join(" ")

const processSchema = type({
	pid: "number.integer > 0",
	orphan: "boolean",
	// null: another user's process.
	path: "string | null",
	commandLine: "string | null",
	"+": "delete"
})

const listSchema = processSchema.array()

export type RcloneProcess = typeof processSchema.infer

export interface LegacyDriveRclone {
	// `<appData>/@filen/network-drive`.
	dir: string
	// 3.x's `<userData>/networkDrive/cache`.
	cacheDir: string
	driveLetter: string
}

// The arguments of a Windows command line as CommandLineToArgvW splits them.
export function windowsArgv(line: string): string[] {
	const args: string[] = []
	let current = ""
	let started = false
	let quoted = false
	let i = 0

	while (i < line.length) {
		const char = line.charAt(i)

		if (char === "\\") {
			let end = i

			while (line.charAt(end) === "\\") {
				end++
			}

			const count = end - i

			if (line.charAt(end) === '"') {
				current += "\\".repeat(count >> 1)

				if (count % 2 === 1) {
					current += '"'
					end++
				}
			} else {
				current += "\\".repeat(count)
			}

			started = true
			i = end
		} else if (char === '"') {
			if (quoted && line.charAt(i + 1) === '"') {
				current += '"'
				i += 2
			} else {
				quoted = !quoted
				i++
			}

			started = true
		} else if ((char === " " || char === "\t") && !quoted) {
			if (started) {
				args.push(current)
				current = ""
				started = false
			}

			i++
		} else {
			current += char
			started = true
			i++
		}
	}

	if (started) {
		args.push(current)
	}

	return args
}

function samePath(a: string | undefined, b: string): boolean {
	const trim = (value: string) => path.win32.normalize(value).replace(/\\+$/, "").toLowerCase()

	return a !== undefined && trim(a) === trim(b)
}

function optionValue(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name)

	return index === -1 ? undefined : args[index + 1]
}

// Whether `process` is the rclone 3.0.47's desktop left running for `expected` (see the top of this file).
export function isLegacyDriveRclone(process: RcloneProcess, expected: LegacyDriveRclone): boolean {
	if (!process.orphan || process.path === null || process.commandLine === null) {
		return false
	}

	if (!samePath(path.win32.dirname(process.path), expected.dir) || !RCLONE_IMAGE.test(path.win32.basename(process.path))) {
		return false
	}

	const [, command, remote, mountPoint, ...options] = windowsArgv(process.commandLine)

	return (
		command === "mount" &&
		remote === "Filen:" &&
		mountPoint !== undefined &&
		driveLetterOf(mountPoint) === expected.driveLetter &&
		samePath(optionValue(options, "--config"), path.win32.join(expected.dir, "rclone.conf")) &&
		samePath(optionValue(options, "--cache-dir"), expected.cacheDir)
	)
}

export function parseRcloneList(stdout: string): RcloneProcess[] | null {
	let json: unknown

	try {
		json = JSON.parse(stdout)
	} catch {
		return null
	}

	const list = listSchema(json)

	return list instanceof type.errors ? null : list
}

export interface LegacyRcloneDeps {
	platform: NodeJS.Platform
	userData: string
	env: FuseContext["env"]
	run(file: string, args: readonly string[]): Promise<ProgramResult>
	// Throws ESRCH once the process is gone.
	kill(pid: number, signal?: number): void
	log: { info(message: string): void; warn(message: string): void }
}

function alive(deps: LegacyRcloneDeps, pid: number): boolean {
	try {
		deps.kill(pid, 0)

		return true
	} catch {
		return false
	}
}

// Ends the rclone 3.0.47's desktop left running for its drive (`networkDrive`: the stashed drive settings) and waits
// briefly until it is gone. Windows only, only where the drive was on; never rejects.
export async function endLegacyDriveRclone(deps: LegacyRcloneDeps, networkDrive: unknown): Promise<void> {
	const driveLetter = deps.platform === "win32" ? legacyDriveLetter(networkDrive) : null

	if (driveLetter === null) {
		return
	}

	const expected: LegacyDriveRclone = {
		dir: path.win32.join(path.win32.dirname(deps.userData), "network-drive"),
		cacheDir: path.win32.join(deps.userData, "networkDrive", "cache"),
		driveLetter
	}
	const listed = await deps.run(system32(deps, "WindowsPowerShell", "v1.0", "powershell.exe"), [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		LIST_SCRIPT
	])
	const found = listed.code === 0 ? parseRcloneList(listed.stdout) : null

	if (found === null) {
		deps.log.warn(`mounts: the processes were not listed (exit ${String(listed.code)}); a 3.0.47 rclone is not looked for`)

		return
	}

	const matching = found.filter(candidate => isLegacyDriveRclone(candidate, expected))
	const ended: number[] = []

	for (const candidate of matching) {
		try {
			deps.kill(candidate.pid)
			ended.push(candidate.pid)
			deps.log.info(
				`mounts: ended the rclone 3.0.47 left running on ${driveLetter}: (pid ${String(candidate.pid)}, ${path.win32.basename(candidate.path ?? "")})`
			)
		} catch (error) {
			deps.log.warn(`mounts: the rclone 3.0.47 left running on ${driveLetter}: was not ended: ${errorCode(error)}`)
		}
	}

	const others = found.length - matching.length

	if (others > 0) {
		deps.log.info(`mounts: ${String(others)} other filen rclone left alone (not 3.0.47's drive on ${driveLetter}:)`)
	}

	for (let waited = 0; waited < EXIT_WAIT_MS && ended.some(pid => alive(deps, pid)); waited += EXIT_POLL_MS) {
		await sleep(EXIT_POLL_MS)
	}
}
