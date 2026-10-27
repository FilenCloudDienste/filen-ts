import { randomBytes } from "node:crypto"
import { createServer } from "node:net"
import type { JsClient, JsRcloneDaemon } from "@filen/sdk-rs"
import { DEFAULT_TUNING, type NativeOpArgs, type NativeOpResult } from "../../shared/nativeProtocol.ts"
import type { NativeSdk } from "../addon.ts"
import { MountsError, pendingRefusal } from "./errors.ts"
import { vfsTuning } from "./reconcile.ts"
import { uploadsOf } from "./stats.ts"

// What the old client's rclone has, once asked to terminate, before it is killed: its own unmount and its watchdog.
export const LEGACY_STOP_GRACE_MS = 10_000
// How long a stopping rclone has to quit before it is killed; its cache keeps what it did not upload.
export const DAEMON_STOP_GRACE_MS = 5000
export const DRAIN_POLL_MS = 2000
const PORT_ATTEMPTS = 3

export interface LegacyContext {
	sdk: NativeSdk
	client: Pick<JsClient, "startRcloneDaemon">
	userAgent: string
	verifyBinary(path: string): Promise<boolean>
	log: { info(message: string): void; warn(message: string): void }
}

// Stops the old client's rclone (any process run from its binaries) and force-unmounts its drive where a stale mount
// is left. Needs no rclone of this app; idempotent: with nothing running or mounted it does nothing.
export async function quiesceLegacy(
	ctx: LegacyContext,
	{ binDir, mountPoints }: NativeOpArgs<"quiesceLegacy">
): Promise<NativeOpResult<"quiesceLegacy">> {
	const stopped = await ctx.sdk.rcloneStopUnder(binDir, LEGACY_STOP_GRACE_MS)
	const unmounted: string[] = []

	for (const mountPoint of mountPoints) {
		try {
			if (await ctx.sdk.rcloneForceUnmount(mountPoint)) {
				unmounted.push(mountPoint)
			}
		} catch (error) {
			ctx.log.warn(`mounts: the previous app's drive was not unmounted: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	return { stopped, unmounted }
}

// A loopback port nothing listens on now.
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer()

		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => {
			const address = server.address()

			server.close(() => {
				if (address === null || typeof address === "string") {
					reject(new Error("no loopback port"))
				} else {
					resolve(address.port)
				}
			})
		})
	})
}

function portInUse(sdk: NativeSdk, error: unknown): boolean {
	return sdk.FilenSdkError.hasInner(error) && sdk.FilenSdkError.getInner(error).rcloneRefusal()?.tag === "PortInUse"
}

// Resolves after `ms`, or at once when `signal` aborts.
function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		const done = () => {
			clearTimeout(timer)
			signal.removeEventListener("abort", done)
			resolve()
		}
		const timer = setTimeout(done, ms)

		signal.addEventListener("abort", done, { once: true })
	})
}

// A serve nothing connects to, so rclone opens the VFS on the cache: loopback, random credentials.
async function serveLoopback(sdk: NativeSdk, daemon: JsRcloneDaemon): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await daemon.startServe({
				protocol: sdk.ServeProtocol.Http,
				host: "127.0.0.1",
				port: await freePort(),
				auth: {
					tag: "Basic",
					inner: { user: `drain-${randomBytes(4).toString("hex")}`, password: randomBytes(32).toString("base64url") }
				},
				readOnly: false
			})

			return
		} catch (error) {
			// Another process took the port between it being found free and rclone binding it.
			if (attempt >= PORT_ATTEMPTS || !portInUse(sdk, error)) {
				throw error
			}
		}
	}
}

// The cache's uploads once nothing is pending, at `deadline`, or on shutdown, whichever comes first.
async function untilDrained(
	daemon: JsRcloneDaemon,
	deadline: number,
	signal: AbortSignal,
	now: () => number
): Promise<NativeOpResult<"drainCache">> {
	for (;;) {
		const uploads = uploadsOf(await daemon.stats())

		if (uploads.pending === 0 || now() >= deadline || signal.aborted) {
			return uploads
		}

		await delay(Math.min(DRAIN_POLL_MS, Math.max(0, deadline - now())), signal)
	}
}

// Uploads what an old cache holds: a temporary rclone on `dir`, whose `Filen` remote is the one the old client keyed
// the cache by, behind a loopback http serve with random credentials that nothing connects to (it only makes rclone
// open the VFS, which queues the cache's dirty files). Polled until nothing is pending or `timeoutMs` passed; rclone is
// stopped and the directory released before this resolves. A cache that reads as uploaded is checked once more
// against rclone's own metadata, which deletes its VFS directories only when no file in them is dirty.
export async function drainCache(
	ctx: LegacyContext,
	{ binary, stateDir, dir, timeoutMs }: NativeOpArgs<"drainCache">,
	signal: AbortSignal,
	now: () => number
): Promise<NativeOpResult<"drainCache">> {
	const { sdk } = ctx

	if (!(await ctx.verifyBinary(binary.path))) {
		throw new MountsError({ code: "binaryInvalid" })
	}

	const options = {
		binaryPath: binary.path,
		stateDir,
		cacheDir: dir,
		userAgent: ctx.userAgent,
		vfs: vfsTuning(DEFAULT_TUNING),
		...(binary.sha256 === null ? {} : { binarySha256: binary.sha256 })
	}
	const daemon = await ctx.client.startRcloneDaemon(options)
	let drained: NativeOpResult<"drainCache">

	try {
		await serveLoopback(sdk, daemon)
		drained = await untilDrained(daemon, now() + timeoutMs, signal, now)
	} finally {
		await daemon.stop({ graceMs: DAEMON_STOP_GRACE_MS }).catch((error: unknown) => {
			ctx.log.warn(`mounts: the draining rclone did not stop cleanly: ${error instanceof Error ? error.message : String(error)}`)
		})
	}

	let { pending } = drained
	const { errored } = drained

	if (pending === 0 && errored === 0) {
		try {
			await sdk.rcloneClearCache(stateDir, dir)
		} catch (error) {
			const dirty = pendingRefusal(sdk, error)

			if (dirty === null) {
				throw error
			}

			pending = dirty
		}
	}

	ctx.log.info(`mounts: drained a previous app's cache (${String(pending)} pending, ${String(errored)} errored)`)

	return { pending, errored }
}
