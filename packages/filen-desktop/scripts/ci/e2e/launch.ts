import type { ChildProcess } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { freePort } from "../support.ts"
import type { Target } from "../targets.ts"

export interface Exit {
	code: number | null
	signal: NodeJS.Signals | null
}

export interface Launched {
	child: ChildProcess
	debugPort: number
	inspectPort: number | null
	exited: Promise<Exit>
}

// Starts the installed app with its renderer's debugging port on the loopback interface (and, with `inspect`, the main
// process's Node inspector, which only 3.x honours). With `output`, Chromium's logging is on and the app's stdout and
// stderr are appended to that file: where a CHECK, a V8 fatal error or a Node fatal error says why the app died.
export async function launchDebuggable(target: Target, inspect = false, output?: string): Promise<Launched> {
	const debugPort = await freePort()
	const inspectPort = inspect ? await freePort() : null
	const args = [
		`--remote-debugging-port=${String(debugPort)}`,
		...(inspectPort === null ? [] : [`--inspect=127.0.0.1:${String(inspectPort)}`])
	]

	console.log(`launch ${target.executable} ${args.join(" ")}`)

	const fd = output === undefined ? undefined : openSync(output, "a", 0o600)
	let child: ChildProcess

	try {
		child = target.launch(fd === undefined ? { ...process.env } : { ...process.env, ELECTRON_ENABLE_LOGGING: "1" }, args, fd)
	} finally {
		// The child holds its own copy.
		if (fd !== undefined) {
			closeSync(fd)
		}
	}

	const exited = new Promise<Exit>(resolve => {
		child.once("exit", (code, signal) => resolve({ code, signal }))
	})

	return { child, debugPort, inspectPort, exited }
}

// The exit, or null if the process is still running after `timeoutMs`. The timer is what keeps the event loop alive
// meanwhile (the child is unref'd), so it is never unref'd itself.
export async function exitWithin(launched: Launched, timeoutMs: number): Promise<Exit | null> {
	let timer: NodeJS.Timeout | undefined

	try {
		return await Promise.race([
			launched.exited,
			new Promise<null>(resolve => {
				timer = setTimeout(() => resolve(null), timeoutMs)
			})
		])
	} finally {
		clearTimeout(timer)
	}
}
