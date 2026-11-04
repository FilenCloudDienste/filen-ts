import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { closeSync, createReadStream, createWriteStream, existsSync, openSync, readSync, statSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as WebReadableStream } from "node:stream/web"
import { setTimeout as sleep } from "node:timers/promises"
import { hashFile } from "../feed.ts"

// Shared plumbing for the desktop e2e scripts (scripts/ci/e2e.ts): commands, bounded waits, the loopback feed and
// reading versions out of installed apps. Node built-ins only, so a bare runner (or container) needs nothing else.

export class TestFailure extends Error {}

export function fail(message: string): never {
	throw new TestFailure(message)
}

// A waitFor that reached its deadline; what its probe throws stays that error.
export class WaitTimeout extends TestFailure {}

// The time from `from` to `to` (ms since the epoch, or any two marks on one clock), for a report.
export function seconds(from: number, to: number): string {
	return `${((to - from) / 1000).toFixed(1)} s`
}

// For a .catch after waitFor: a timeout stands for `value`, and anything else (the probe's own error) goes on.
export function onTimeout<T>(value: T): (error: unknown) => T {
	return error => {
		if (error instanceof WaitTimeout) {
			return value
		}

		throw error
	}
}

export function section(title: string): void {
	console.log(`\n== ${title}`)
}

export interface RunOptions {
	allowFailure?: boolean
	env?: NodeJS.ProcessEnv
	cwd?: string
	// Windows only: the arguments reach the program exactly as given (cmd.exe /s /c "..." command lines).
	verbatim?: boolean
	// Logged instead of the command line (an encoded script, say).
	display?: string
}

export interface RunResult {
	status: number | null
	stdout: string
	stderr: string
}

export function run(command: string, args: readonly string[], options: RunOptions = {}): RunResult {
	console.log(`$ ${options.display ?? `${command} ${args.join(" ")}`}`)

	const result = spawnSync(command, args, {
		encoding: "utf8",
		env: options.env ?? process.env,
		cwd: options.cwd ?? process.cwd(),
		windowsVerbatimArguments: options.verbatim ?? false,
		maxBuffer: 64 * 1024 * 1024
	})

	if (result.error) {
		fail(`${command}: ${result.error.message}`)
	}

	if (result.status !== 0 && options.allowFailure !== true) {
		fail(`${command} exited with ${String(result.status)}: ${`${result.stderr}\n${result.stdout}`.trim().slice(-4000)}`)
	}

	return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
 * Polls until the probe returns a value (anything but null/undefined) and returns it; fails at the deadline. Every
 * wait in the tests goes through here, so nothing depends on a fixed sleep being long enough.
 */
export async function waitFor<T>(
	what: string,
	timeoutMs: number,
	probe: () => T | null | undefined | Promise<T | null | undefined>,
	intervalMs = 2000
): Promise<T> {
	const deadline = Date.now() + timeoutMs

	for (;;) {
		const value = await probe()

		if (value !== null && value !== undefined) {
			return value
		}

		if (Date.now() >= deadline) {
			throw new WaitTimeout(`timed out after ${String(Math.round(timeoutMs / 1000))} s waiting for ${what}`)
		}

		await sleep(intervalMs)
	}
}

export interface BoundedResult extends RunResult {
	timedOut: boolean
}

/**
 * A command that must never hold up the harness (system tools that can block on a daemon or a prompt): after
 * `timeoutMs` its whole process group is killed, and the result says it timed out instead of the run hanging. With
 * `onStdout`, stdout goes to it as raw bytes (a file's content) and the result's stdout stays empty.
 */
export async function runBounded(
	command: string,
	args: readonly string[],
	timeoutMs: number,
	options: { env?: NodeJS.ProcessEnv; input?: string; cwd?: string; display?: string; onStdout?: (chunk: Buffer) => void } = {}
): Promise<BoundedResult> {
	console.log(`$ ${options.display ?? `${command} ${args.join(" ")}`}`)

	const group = process.platform !== "win32"
	const child = spawn(command, args, {
		detached: group,
		stdio: "pipe",
		env: options.env ?? process.env,
		cwd: options.cwd ?? process.cwd()
	})

	// Never logged: the input may be a secret (rclone obscure reads one). Without one, stdin is at its end at once.
	child.stdin.end(options.input)

	let stdout = ""
	let stderr = ""
	let timedOut = false

	const { onStdout } = options

	if (onStdout === undefined) {
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk
		})
	} else {
		child.stdout.on("data", onStdout)
	}
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk
	})

	let grace: NodeJS.Timeout | undefined
	const status = await new Promise<number | null>(resolve => {
		const timer = setTimeout(() => {
			timedOut = true

			try {
				if (group && child.pid !== undefined) {
					process.kill(-child.pid, "SIGKILL")
				} else if (child.pid !== undefined) {
					// Windows has no process groups: the whole tree goes (PowerShell's own children, a dialog it waits on).
					const killed = spawnSync("taskkill.exe", ["/T", "/F", "/PID", String(child.pid)], { encoding: "utf8", timeout: 30_000 })

					console.log(`taskkill /T /F /PID ${String(child.pid)}: ${killed.error?.message ?? `exit ${String(killed.status)}`}`)
					child.kill("SIGKILL")
				}
			} catch {
				// Already gone.
			}

			// A process outside the group can keep the pipes open after the kill (fileproviderctl hands its work to a
			// daemon), so the wait ends shortly after the timeout whether or not they close.
			grace = setTimeout(() => {
				child.stdout.destroy()
				child.stderr.destroy()
				resolve(null)
			}, 2000)
		}, timeoutMs)

		child.once("error", error => {
			clearTimeout(timer)
			stderr += error.message
			resolve(null)
		})
		child.once("close", code => {
			clearTimeout(timer)
			resolve(code)
		})
	})

	clearTimeout(grace)

	return { status, stdout, stderr, timedOut }
}

// Liveness over a window: the probe must hold on every check for the whole duration.
export async function holds(what: string, durationMs: number, probe: () => boolean): Promise<void> {
	const until = Date.now() + durationMs

	while (Date.now() < until) {
		if (!probe()) {
			fail(`${what} stopped holding`)
		}

		await sleep(1000)
	}
}

export interface FeedRequest {
	path: string
	status: number
	bytes: number
}

export interface FeedServer {
	url: string
	requests: FeedRequest[]
	// Lets every stalled response go on from where it stopped (one whose client went away stays ended).
	release(): void
	close(): Promise<void>
}

/**
 * What one request gets instead of the file (the update fault launch, scripts/ci/e2e/updateFaults.ts). Fractions are of
 * the body; the full Content-Length is always announced.
 *
 *   status   that status and no body
 *   body     these bytes instead of the file's (a manifest made up for the request, a truncated file)
 *   cutAt    the socket destroyed once this much is sent
 *   stallAt  nothing more sent once this much is, on a live socket, until release() or the client goes; then the
 *            socket is destroyed, so a stalled download never completes. Only stallAt 0 (headers only: the step gate)
 *            sends the whole body on release()
 *   flipAt   the byte there sent inverted
 */
export interface FeedFault {
	status?: number
	body?: Buffer
	cutAt?: number
	stallAt?: number
	flipAt?: number
}

// The fault for a request, by name and that name's request ordinal (1 for its first); null serves the file as it is.
// `range`: the request asks for a byte range (which the feed never serves).
export type FeedFaultPlan = (request: { name: string; ordinal: number; range: boolean }) => FeedFault | null

// Writes bytes [start, end) of the file or buffer to the response with backpressure, inverting the byte at `flip`.
// False once the client is gone.
async function sendPart(
	response: ServerResponse,
	record: FeedRequest,
	source: string | Buffer,
	start: number,
	end: number,
	flip: number | null
): Promise<boolean> {
	if (start >= end) {
		return !response.destroyed
	}

	const chunks: AsyncIterable<Buffer> | Buffer[] =
		typeof source === "string" ? createReadStream(source, { start, end: end - 1 }) : [source.subarray(start, end)]
	let position = start

	for await (const raw of chunks) {
		if (response.destroyed) {
			return false
		}

		let chunk = raw

		if (flip !== null && flip >= position && flip < position + chunk.length) {
			chunk = Buffer.from(chunk)
			chunk[flip - position] = (chunk[flip - position] ?? 0) ^ 0xff
		}

		position += chunk.length
		record.bytes += chunk.length

		if (!response.write(chunk)) {
			await new Promise<void>(resolve => {
				const done = () => {
					response.off("drain", done)
					response.off("close", done)
					resolve()
				}

				response.once("drain", done)
				response.once("close", done)
			})
		}
	}

	return !response.destroyed
}

/**
 * The update feed on the loopback interface: only the named files in `dir`, whole files only (no Range, so the
 * updater takes its full-download path and every request is one complete transfer that can be asserted on). With
 * `plan`, a request may get a fault instead (FeedFault).
 */
export async function serveFeed(dir: string, names: readonly string[], plan?: FeedFaultPlan): Promise<FeedServer> {
	const allowed = new Set(names)
	const requests: FeedRequest[] = []
	const ordinals = new Map<string, number>()
	const stalled = new Set<() => void>()

	const faulted = async (
		request: IncomingMessage,
		response: ServerResponse,
		record: FeedRequest,
		file: string,
		fault: FeedFault
	): Promise<void> => {
		if (fault.status !== undefined) {
			record.status = fault.status
			response.writeHead(fault.status).end()

			return
		}

		const source = fault.body ?? file
		const size = fault.body?.length ?? statSync(file).size
		const at = (fraction: number) => Math.min(size, Math.max(0, Math.floor(size * fraction)))
		const stop = fault.cutAt ?? fault.stallAt
		const first = stop === undefined ? size : at(stop)
		const flip = fault.flipAt === undefined ? null : Math.min(at(fault.flipAt), size - 1)

		record.status = 200
		response.writeHead(200, {
			"Content-Length": size,
			"Content-Type": record.path.endsWith(".yml") ? "text/yaml" : "application/octet-stream",
			"Accept-Ranges": "none",
			"Cache-Control": "no-store"
		})
		response.flushHeaders()

		if (request.method === "HEAD") {
			response.end()

			return
		}

		if (!(await sendPart(response, record, source, 0, first, flip))) {
			return
		}

		if (fault.cutAt !== undefined) {
			response.socket?.destroy()

			return
		}

		if (fault.stallAt !== undefined) {
			await new Promise<void>(resolve => {
				const go = () => {
					stalled.delete(go)
					response.off("close", go)
					resolve()
				}

				stalled.add(go)
				response.once("close", go)
			})

			// The rest of a half-sent file would let the client finish a valid download long after its fault.
			if (fault.stallAt > 0) {
				response.destroy()

				return
			}
		}

		if (await sendPart(response, record, source, first, size, flip)) {
			response.end()
		}
	}

	const server = createServer((request, response) => {
		const name = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname.replace(/^\/+/, ""))
		const file = path.join(dir, name)
		const record: FeedRequest = { path: name, status: 404, bytes: 0 }

		requests.push(record)

		if (request.method !== "GET" && request.method !== "HEAD") {
			record.status = 405
			response.writeHead(405).end()

			return
		}

		if (!allowed.has(name) || !existsSync(file)) {
			response.writeHead(404).end()

			return
		}

		const ordinal = (ordinals.get(name) ?? 0) + 1

		ordinals.set(name, ordinal)

		const fault = plan?.({ name, ordinal, range: request.headers.range !== undefined }) ?? null

		if (fault !== null) {
			faulted(request, response, record, file, fault).catch(() => {
				response.destroy()
			})

			return
		}

		const size = statSync(file).size

		record.status = 200
		response.writeHead(200, {
			"Content-Length": size,
			"Content-Type": name.endsWith(".yml") ? "text/yaml" : "application/octet-stream",
			"Accept-Ranges": "none",
			"Cache-Control": "no-store"
		})

		if (request.method === "HEAD") {
			response.end()

			return
		}

		const stream = createReadStream(file)

		stream.on("data", chunk => {
			record.bytes += chunk.length
		})
		stream.pipe(response)
	})

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", resolve)
	})

	const { port } = server.address() as AddressInfo

	return {
		url: `http://127.0.0.1:${String(port)}/`,
		requests,
		release: () => {
			for (const go of [...stalled]) {
				go()
			}
		},
		close: () =>
			new Promise<void>(resolve => {
				server.closeAllConnections()
				server.close(() => resolve())
			})
	}
}

// The `version` of the package.json packed into an app.asar (the asar header is a JSON index after two pickled sizes).
export function asarVersion(asarPath: string): string {
	const fd = openSync(asarPath, "r")

	try {
		const head = Buffer.alloc(16)

		readSync(fd, head, 0, 16, 0)

		const headerSize = head.readUInt32LE(4)
		const jsonSize = head.readUInt32LE(12)
		const json = Buffer.alloc(jsonSize)

		readSync(fd, json, 0, jsonSize, 16)

		const header = JSON.parse(json.toString("utf8")) as { files?: Record<string, { size?: number; offset?: string }> }
		const entry = header.files?.["package.json"]

		if (entry?.size === undefined || entry.offset === undefined) {
			fail(`${asarPath} has no package.json`)
		}

		const data = Buffer.alloc(entry.size)

		readSync(fd, data, 0, entry.size, 8 + headerSize + Number(entry.offset))

		const { version } = JSON.parse(data.toString("utf8")) as { version?: unknown }

		if (typeof version !== "string") {
			fail(`${asarPath}: package.json has no version`)
		}

		return version
	} finally {
		closeSync(fd)
	}
}

// Downloads a public file once and checks it against a pinned sha512; a cached copy is reused only if it matches.
export async function downloadPinned(url: string, destination: string, sha512: string): Promise<void> {
	if ((await hashFile(destination))?.sha512 === sha512) {
		console.log(`${destination}: cached copy matches`)

		return
	}

	await mkdir(path.dirname(destination), { recursive: true })
	console.log(`downloading ${url}`)

	const response = await fetch(url)

	if (!response.ok || !response.body) {
		fail(`${url}: HTTP ${String(response.status)}`)
	}

	await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), createWriteStream(destination))

	const actual = await hashFile(destination)

	if (actual?.sha512 !== sha512) {
		fail(`${url}: sha512 does not match the pinned release value`)
	}
}

/**
 * Windows PowerShell (5.1) with the script passed as -EncodedCommand (base64 UTF-16LE), which no quoting layer between
 * Node and powershell.exe can alter.
 *
 * - Every error stops the script and exits 1 ($ErrorActionPreference Stop); a probe that may miss passes
 *   -ErrorAction SilentlyContinue itself. Otherwise it ends in `exit 0`: with -Command the exit code is the status ($?)
 *   of the last statement, which a missed probe made 1.
 * - PSModulePath is dropped: the CI steps run in PowerShell 7, whose module path makes 5.1 fail to load its own
 *   Microsoft.PowerShell.Security (Get-AuthenticodeSignature), an error that otherwise leaves stdout empty.
 */
export function encodePowerShell(script: string): string {
	return Buffer.from(
		`$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n${script}\nexit 0\n`,
		"utf16le"
	).toString("base64")
}

export function powershellArgs(script: string): string[] {
	return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)]
}

export function powershellEnv(): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"))
}

export function powershell(script: string, options: Pick<RunOptions, "allowFailure"> = {}): RunResult {
	const result = run("powershell.exe", powershellArgs(script), { ...options, env: powershellEnv(), display: `powershell.exe ${script}` })

	if (result.stderr.trim() !== "") {
		console.log(`powershell.exe stderr: ${powershellErrorText(result.stderr).slice(-2000)}`)
	}

	return result
}

// A virtual X display for the Electron window on a headless Linux runner; it outlives the app's relaunch.
export async function startXvfb(): Promise<ChildProcess | null> {
	if (process.env["DISPLAY"]) {
		return null
	}

	const display = ":99"
	const xvfb = spawn("Xvfb", [display, "-screen", "0", "1920x1200x24", "-nolisten", "tcp"], { stdio: "ignore" })

	xvfb.on("error", error => {
		console.error(`Xvfb: ${error.message}`)
	})
	process.env["DISPLAY"] = display

	await waitFor("the Xvfb display", 30_000, () => (existsSync("/tmp/.X11-unix/X99") ? true : null), 500)

	return xvfb
}

// A TCP port free on the loopback interface right now, for a debugging switch of an app about to start.
export async function freePort(): Promise<number> {
	const server = createServer()

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", resolve)
	})

	const { port } = server.address() as AddressInfo

	await new Promise<void>(resolve => server.close(() => resolve()))

	return port
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

// powershell(), bounded (runBounded): for scripts that wait on the desktop (a dialog, a window) or a slow device. Its
// stderr comes back as readable text (powershellErrorText).
export async function powershellBounded(script: string, timeoutMs: number): Promise<BoundedResult> {
	const result = await runBounded("powershell.exe", powershellArgs(script), timeoutMs, {
		env: powershellEnv(),
		display: `powershell.exe ${script.trim().split("\n")[0] ?? ""} …`
	})

	return { ...result, stderr: powershellErrorText(result.stderr) }
}

// PowerShell writes its error stream to a redirected stderr as CLIXML ("#< CLIXML" and <S S="Error"> records, line
// breaks as _x000D__x000A_); the text of those records, or the stderr as it is when it is no CLIXML.
export function powershellErrorText(stderr: string): string {
	if (!stderr.trimStart().startsWith("#< CLIXML")) {
		return stderr.trim()
	}

	const entities: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }

	return [...stderr.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
		.map(match =>
			(match[1] ?? "")
				.replace(/_x([0-9A-Fa-f]{4})_/g, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16)))
				.replace(/&(lt|gt|amp|quot|apos);/g, (_all, name: string) => entities[name] ?? "")
		)
		.join("")
		.trim()
}

// A PowerShell single-quoted literal of `value`.
export function psQuote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`
}
