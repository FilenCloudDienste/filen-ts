import { spawn, spawnSync } from "node:child_process"
import { fail, powershellArgs, powershellEnv, psQuote } from "../support.ts"

// A Windows file held open with no sharing ([IO.File]::Open(path, mode, 'ReadWrite', 'None')), as an editor or an
// antivirus scan holds one: nobody else can read, write, rename or delete it until the handle closes. The holder is a
// PowerShell process that keeps the handle while its stdin is open; it answers `hash` (the sha256 of what the file
// holds, read through its own handle, since nothing else can read it) and lets go on `release` or when stdin closes.
// With `fill`, it creates the file itself and writes that file's bytes into it, so the file is never readable by
// anyone else, not even for a moment. For the file-lock check (chains/fileLockCheck.ts). Every wait is bounded, and the
// holder is killed with its tree once it outlives its cap.

const START_TIMEOUT_MS = 60_000
const ANSWER_TIMEOUT_MS = 60_000
const EXIT_TIMEOUT_MS = 30_000
// No lock outlives this, whatever the check does.
const MAX_HOLD_MS = 20 * 60 * 1000

export interface FileLock {
	readonly path: string
	// sha256 (hex) of the file's bytes, through the holder's handle.
	hash(): Promise<string>
	// Closes the handle; resolves once the holder exited. Safe to call twice.
	release(): Promise<void>
}

export function lockScript(file: string, fill: string | null): string {
	return [
		`$file = [IO.File]::Open(${psQuote(file)}, '${fill === null ? "Open" : "CreateNew"}', 'ReadWrite', 'None')`,
		...(fill === null
			? []
			: [`$bytes = [IO.File]::ReadAllBytes(${psQuote(fill)})`, "$file.Write($bytes, 0, $bytes.Length)", "$file.Flush($true)"]),
		"[Console]::Out.WriteLine('locked')",
		"[Console]::Out.Flush()",
		"while ($true) {",
		"\t$line = [Console]::In.ReadLine()",
		"\tif ($null -eq $line -or $line -eq 'release') { break }",
		"\tif ($line -eq 'hash') {",
		"\t\t$file.Position = 0",
		"\t\t$digest = [Security.Cryptography.SHA256]::Create().ComputeHash($file)",
		"\t\t[Console]::Out.WriteLine('sha256 ' + ([BitConverter]::ToString($digest) -replace '-', '').ToLowerInvariant())",
		"\t\t[Console]::Out.Flush()",
		"\t}",
		"}",
		"$file.Close()"
	].join("\n")
}

// Locks `file` (an existing one, or with `fill` a new one holding that file's bytes); resolves once it is held.
export async function lockFile(file: string, fill: string | null = null): Promise<FileLock> {
	if (process.platform !== "win32") {
		fail("file locks without sharing are a Windows check")
	}

	const child = spawn("powershell.exe", powershellArgs(lockScript(file, fill)), { stdio: "pipe", env: powershellEnv() })
	let buffered = ""
	let stderr = ""
	const lines: string[] = []
	let waiting: (() => void) | null = null
	let exited = false
	const exit = new Promise<void>(resolve => {
		child.once("exit", () => {
			exited = true
			waiting?.()
			resolve()
		})
	})
	const kill = () => {
		if (!exited && child.pid !== undefined) {
			spawnSync("taskkill.exe", ["/T", "/F", "/PID", String(child.pid)], { timeout: 30_000 })
		}
	}
	const cap = setTimeout(kill, MAX_HOLD_MS)

	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		buffered += chunk

		const parts = buffered.split(/\r?\n/)

		buffered = parts.pop() ?? ""
		lines.push(...parts.map(line => line.trim()).filter(line => line !== ""))
		waiting?.()
	})
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk
	})
	child.once("error", error => {
		stderr += error.message
	})

	// The next line starting with `prefix`, within `timeoutMs`.
	const line = async (prefix: string, timeoutMs: number): Promise<string> => {
		const deadline = Date.now() + timeoutMs

		for (;;) {
			const at = lines.findIndex(candidate => candidate.startsWith(prefix))

			if (at !== -1) {
				return lines.splice(0, at + 1).at(-1) ?? ""
			}

			if (exited || Date.now() >= deadline) {
				fail(
					`the lock holder of ${file} ${exited ? "exited" : "did not answer"} (waiting for "${prefix}"): ${stderr.trim().slice(-500)}`
				)
			}

			await new Promise<void>(resolve => {
				const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()))

				waiting = () => {
					clearTimeout(timer)
					resolve()
				}
			})
			waiting = null
		}
	}

	const release = async () => {
		if (!exited) {
			child.stdin.end("release\n")

			const timer = setTimeout(kill, EXIT_TIMEOUT_MS)

			await exit
			clearTimeout(timer)
		}

		clearTimeout(cap)
	}

	try {
		await line("locked", START_TIMEOUT_MS)
	} catch (error) {
		kill()
		clearTimeout(cap)

		throw error
	}

	return {
		path: file,
		async hash() {
			child.stdin.write("hash\n")

			return (await line("sha256 ", ANSWER_TIMEOUT_MS)).slice("sha256 ".length)
		},
		release
	}
}
