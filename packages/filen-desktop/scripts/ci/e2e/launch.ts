import type { ChildProcess } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { freePort } from "../support.ts"
import { detached, type Target } from "../targets.ts"

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

// What a check adds to a launch (a proxy's settings, say): variables over the harness's own environment, and arguments
// after the debugging ones.
export interface LaunchExtra {
	env?: NodeJS.ProcessEnv
	args?: readonly string[]
}

// Starts the installed app with its renderer's debugging port on the loopback interface (and, with `inspect`, the main
// process's Node inspector, which only 3.x honours). With `output`, Chromium's logging is on and the app's stdout and
// stderr are appended to that file: where a CHECK, a V8 fatal error or a Node fatal error says why the app died. With
// `via`, the executable is started through that command (a wrapper that runs it, such as sudo with another group), in
// the environment the format's own launch would give it.
export async function launchDebuggable(
	target: Target,
	inspect = false,
	output?: string,
	via?: readonly string[],
	extra: LaunchExtra = {}
): Promise<Launched> {
	const debugPort = await freePort()
	const inspectPort = inspect ? await freePort() : null
	const args = [
		`--remote-debugging-port=${String(debugPort)}`,
		...(inspectPort === null ? [] : [`--inspect=127.0.0.1:${String(inspectPort)}`]),
		...(extra.args ?? [])
	]

	console.log(`launch ${[...(via ?? []), target.executable, ...args].join(" ")}`)

	const fd = output === undefined ? undefined : openSync(output, "a", 0o600)
	let child: ChildProcess

	try {
		const env = { ...process.env, ...(fd === undefined ? {} : { ELECTRON_ENABLE_LOGGING: "1" }), ...extra.env }
		const [command, ...prefix] = via ?? []

		child =
			command === undefined
				? target.launch(env, args, fd)
				: detached(command, [...prefix, target.executable, ...args], target.launchEnv(env), fd)
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
