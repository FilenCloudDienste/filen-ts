import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { crc32, deflateSync } from "node:zlib"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { errorMessage, fail, run, runBounded, waitFor } from "../support.ts"
import { linuxExe } from "../targets.ts"

// Linux desktop session pieces of the deep chains: the GTK folder chooser driven with xdotool under Xvfb (no window
// manager, so focus is set on the window itself), mounts, the keyring and the package manager. Every tool runs
// bounded.

const TOOL_TIMEOUT_MS = 30_000
const DIALOG_TIMEOUT_MS = 60_000

async function xdotool(args: string[]): Promise<string> {
	const result = await runBounded("xdotool", args, TOOL_TIMEOUT_MS)

	if (result.status !== 0) {
		fail(`xdotool ${args.join(" ")}: ${result.timedOut ? "timed out" : `exit ${String(result.status)}`} ${result.stderr.trim()}`)
	}

	return result.stdout.trim()
}

async function windowsNamed(title: string): Promise<string[]> {
	const result = await runBounded("xdotool", ["search", "--onlyvisible", "--name", `^${title}$`], TOOL_TIMEOUT_MS)

	return result.status === 0 ? result.stdout.split("\n").filter(line => line.trim() !== "") : []
}

// An X window dump of a 24-bit TrueColor screen (Xvfb's: 32 bits per pixel, ZPixmap) as a PNG.
export function xwdToPng(xwd: Buffer): Buffer {
	const field = (index: number) => xwd.readUInt32BE(index * 4)
	const [headerSize, width, height, byteOrder, bitsPerPixel, bytesPerLine, colors] = [
		field(0),
		field(4),
		field(5),
		field(7),
		field(11),
		field(12),
		field(19)
	]

	if (bitsPerPixel !== 32) {
		fail(`an X window dump with ${String(bitsPerPixel)} bits per pixel`)
	}

	const pixels = headerSize + colors * 12
	const raw = Buffer.alloc(height * (1 + width * 3))

	for (let y = 0; y < height; y++) {
		const row = y * (1 + width * 3)

		for (let x = 0; x < width; x++) {
			const at = pixels + y * bytesPerLine + x * 4
			const target = row + 1 + x * 3

			// LSBFirst stores B, G, R, pad; MSBFirst pad, R, G, B.
			raw[target] = xwd[byteOrder === 0 ? at + 2 : at + 1] ?? 0
			raw[target + 1] = xwd[byteOrder === 0 ? at + 1 : at + 2] ?? 0
			raw[target + 2] = xwd[byteOrder === 0 ? at : at + 3] ?? 0
		}
	}

	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4)
		const crc = Buffer.alloc(4)
		const body = Buffer.concat([Buffer.from(type, "latin1"), data])

		length.writeUInt32BE(data.length)
		crc.writeUInt32BE(crc32(body))

		return Buffer.concat([length, body, crc])
	}
	const header = Buffer.alloc(13)

	header.writeUInt32BE(width, 0)
	header.writeUInt32BE(height, 4)
	header.set([8, 2, 0, 0, 0], 8)

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0))
	])
}

// The whole Xvfb screen as a PNG for the artifacts; the raw dump is kept when it cannot be converted.
export async function screenDump(file: string): Promise<void> {
	const dump = file.replace(/\.png$/, ".xwd")

	if ((await runBounded("xwd", ["-root", "-silent", "-out", dump], TOOL_TIMEOUT_MS)).status !== 0) {
		return
	}

	try {
		writeFileSync(file, xwdToPng(readFileSync(dump)))
		rmSync(dump, { force: true })
	} catch (error) {
		console.log(`screen dump ${path.basename(dump)} kept unconverted: ${errorMessage(error)}`)
	}
}

async function closedWithin(title: string, timeoutMs: number): Promise<boolean> {
	return waitFor("the dialog to close", timeoutMs, async () => ((await windowsNamed(title)).length === 0 ? true : null), 500).catch(
		() => false
	)
}

// Answers the app's open-directory dialog titled `title` (Chromium's GTK folder chooser) with `dir`, leaving PNGs of
// every step as `<evidence>-<step>.png`. Done when the dialog is gone; what the app made of it is the caller's check.
//
// The location field (Ctrl+L) takes the path; GTK completes a folder with a selected "/", and in a folder chooser a
// folder in that field is the answer. The answer is given with the accept button's mnemonic (Alt+O, "_Open"), not
// Enter: an Enter left the dialog open on the first run and closed it as canceled on the second, and Chromium treats
// Return and Space presses specially around its file dialogs. Enter stays as the last resort.
export async function chooseDirectory(title: string, dir: string, evidence: string): Promise<void> {
	const [window] = await waitFor(`the "${title}" dialog`, DIALOG_TIMEOUT_MS, async () => {
		const found = await windowsNamed(title)

		return found.length > 0 ? found : null
	})

	if (window === undefined) {
		fail(`no "${title}" window`)
	}

	await xdotool(["windowfocus", "--sync", window])
	await xdotool(["key", "--clearmodifiers", "ctrl+l"])
	await xdotool(["type", "--delay", "20", "--clearmodifiers", dir])
	// The completion reads the parent folder asynchronously.
	await sleep(1500)
	await screenDump(`${evidence}-1-typed.png`)

	for (const [step, key] of [
		["2-open", "alt+o"],
		["3-return", "Return"]
	] as const) {
		await xdotool(["windowfocus", "--sync", window])
		await xdotool(["key", "--clearmodifiers", key])

		const closed = await closedWithin(title, 10_000)

		if (closed) {
			return
		}

		await screenDump(`${evidence}-${step}.png`)
	}

	fail(`the "${title}" dialog stayed open after the path and its answer (see ${path.basename(evidence)}-*.png)`)
}

// The file system type mounted at `point`, or null.
export async function mountedType(point: string): Promise<string | null> {
	const result = await runBounded("findmnt", ["--noheadings", "--output", "FSTYPE", "--mountpoint", point], TOOL_TIMEOUT_MS)

	return result.status === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : null
}

// sha256 of a file read through a mount, bounded: a FUSE read can block.
export async function sha256Through(file: string, timeoutMs: number): Promise<string> {
	const result = await runBounded("sha256sum", [file], timeoutMs)

	if (result.status !== 0) {
		fail(`sha256sum ${file}: ${result.timedOut ? "timed out" : result.stderr.trim()}`)
	}

	return result.stdout.split(" ")[0] ?? ""
}

// The secret service items an application stored, by label and attributes only: secret-tool prints the secrets too,
// and those lines are dropped before anything else sees the output.
export async function keyringItems(application: string): Promise<string[]> {
	const result = await runBounded("secret-tool", ["search", "--all", "application", application], TOOL_TIMEOUT_MS)

	return `${result.stdout}\n${result.stderr}`
		.split("\n")
		.filter(line => /^(label|attribute\.)/.test(line.trim()))
		.map(line => line.trim())
}

// What a user does to remove a deb: remove, then purge.
export function uninstallDeb(): void {
	for (const action of ["remove", "purge"]) {
		run("sudo", ["--non-interactive", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", action, "--yes", "filen"])
	}

	if (existsSync("/opt/Filen")) {
		fail("/opt/Filen is still there after apt-get purge")
	}
}

// When process `pid` started, in epoch milliseconds: its start in clock ticks after boot (/proc/<pid>/stat, field 22,
// counted after the parenthesised command name) plus the boot time (/proc/stat btime). USER_HZ is 100 on Linux.
export function processStartMs(pid: number): number {
	const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8")
	const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19])
	const boot = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1])

	if (!Number.isFinite(ticks) || !Number.isFinite(boot)) {
		fail(`cannot read when process ${String(pid)} started`)
	}

	return boot * 1000 + ticks * 10
}

// Where the deep workflow step's kernel.core_pattern writes core dumps: core.<pid>.<crashing thread's name>.<signal>.
export const CORE_DIR = "/tmp/filen-e2e-cores"
const GDB_TIMEOUT_MS = 5 * 60 * 1000

// The crashing thread's stack, every thread's and the mappings (to symbolise the stripped frames offline against the
// release's debug symbols) from process `pid`'s core dump; null when it left none.
export async function coreReport(executable: string, pid: number): Promise<string | null> {
	const core = (existsSync(CORE_DIR) ? readdirSync(CORE_DIR) : []).find(name => name.startsWith(`core.${String(pid)}.`))

	if (core === undefined) {
		return null
	}

	const result = await runBounded(
		"gdb",
		[
			"--batch",
			"--nx",
			"-ex",
			"set pagination off",
			"-ex",
			"bt 64",
			"-ex",
			"thread apply all bt 32",
			"-ex",
			"info proc mappings",
			executable,
			path.join(CORE_DIR, core)
		],
		GDB_TIMEOUT_MS
	)

	return `${core}\n${result.timedOut ? "gdb timed out\n" : ""}${result.stdout}\n${result.stderr}`
}

// Processes whose executable lies below `prefix` (an install's helpers too, rclone say), as "pid exe".
export function processesUnder(prefix: string): string[] {
	const found: string[] = []

	for (const entry of readdirSync("/proc")) {
		if (/^\d+$/.test(entry)) {
			const exe = linuxExe(Number(entry))

			if (exe?.startsWith(prefix) === true) {
				found.push(`${entry} ${exe}`)
			}
		}
	}

	return found
}
