import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { closeSync, createReadStream, createWriteStream, existsSync, openSync, readSync, statSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as WebReadableStream } from "node:stream/web"
import { setTimeout as sleep } from "node:timers/promises"
import { hashFile } from "../feed.ts"

// Shared plumbing for the real-install tests (scripts/ci/installTest.ts): commands, bounded waits, the loopback feed
// and reading versions out of installed apps. Node built-ins only, so a bare runner (or container) needs nothing else.

export class TestFailure extends Error {}

export function fail(message: string): never {
	throw new TestFailure(message)
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
}

export interface RunResult {
	status: number | null
	stdout: string
	stderr: string
}

export function run(command: string, args: readonly string[], options: RunOptions = {}): RunResult {
	console.log(`$ ${command} ${args.join(" ")}`)

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
			fail(`timed out after ${String(Math.round(timeoutMs / 1000))} s waiting for ${what}`)
		}

		await sleep(intervalMs)
	}
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
	close(): Promise<void>
}

/**
 * The update feed on the loopback interface: only the named files in `dir`, whole files only (no Range, so the
 * updater takes its full-download path and every request is one complete transfer that can be asserted on).
 */
export async function serveFeed(dir: string, names: readonly string[]): Promise<FeedServer> {
	const allowed = new Set(names)
	const requests: FeedRequest[] = []
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

// A virtual X display for the Electron window on a headless Linux runner; it outlives the app's relaunch.
export async function startXvfb(): Promise<ChildProcess | null> {
	if (process.env["DISPLAY"]) {
		return null
	}

	const display = ":99"
	const xvfb = spawn("Xvfb", [display, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: "ignore" })

	xvfb.on("error", error => {
		console.error(`Xvfb: ${error.message}`)
	})
	process.env["DISPLAY"] = display

	await waitFor("the Xvfb display", 30_000, () => (existsSync("/tmp/.X11-unix/X99") ? true : null), 500)

	return xvfb
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
