import { existsSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fail, run, runBounded, waitFor } from "../support.ts"

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

// The whole Xvfb screen as a PNG for the artifacts (an X window dump converted by ImageMagick, which the runner image
// ships; the dump itself is kept when the conversion fails).
export async function screenDump(file: string): Promise<void> {
	const dump = file.replace(/\.png$/, ".xwd")

	await runBounded("xwd", ["-root", "-silent", "-out", dump], TOOL_TIMEOUT_MS)

	if ((await runBounded("convert", [`xwd:${dump}`, file], TOOL_TIMEOUT_MS)).status === 0) {
		rmSync(dump, { force: true })
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
