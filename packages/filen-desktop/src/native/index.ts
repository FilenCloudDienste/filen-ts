import { type } from "arktype"
import {
	type FromNative,
	isMountsOp,
	type NativeError,
	type NativeFatalReason,
	type NativeInit,
	type NativeOpArgs,
	type NativeOpResult,
	type SyncOp,
	type ToNative,
	toNativeSchema
} from "../shared/nativeProtocol.ts"
import { loadAddon, type NativeSdk, type SyncEngine } from "./addon.ts"
import { clientFromSession } from "./client.ts"
import { createConvergence } from "./convergence.ts"
import { openEngine } from "./engine.ts"
import { classify } from "./errors.ts"
import { createHostEngine, type HostEngine, type OpHandlers, toNativePair } from "./ops.ts"
import { createPlanRegistry } from "./plans.ts"
import { createRuntimeFeed, type RuntimeFeed } from "./reducer.ts"

// The native host: a utility process that owns the account's one SDK client and sync engine and runs every engine call
// main asks for. Everything crossing to main is validated there; what comes in is validated here.

// How long a shutdown waits for the engine to close (a transfer in flight finishes first); main kills at 25 s.
const CLOSE_TIMEOUT_MS = 20_000

// The part of Electron's parentPort the host uses.
export interface HostPort {
	on(event: "message", listener: (message: { data: unknown }) => void): unknown
	postMessage(message: FromNative): void
}

function run<K extends SyncOp>(ops: OpHandlers, op: K, args: NativeOpArgs<K>): Promise<NativeOpResult<K>> {
	return ops[op](args)
}

// The id of a call that failed validation, so it still gets its one reply.
const callIdSchema = type({ t: "'call'", id: "0 <= number.integer <= 9007199254740991" })

export function startHost(port: HostPort, exit: (code: number) => void): void {
	let phase: "waiting" | "starting" | "ready" | "stopping" = "waiting"
	let sdk: NativeSdk | null = null
	let feed: RuntimeFeed | null = null
	let engine: SyncEngine | null = null
	let host: HostEngine | null = null
	let subscribed = false
	let revoked = false
	const plans = createPlanRegistry()
	const abort = new AbortController()

	// Read through a call: the phase changes in other handlers while init awaits.
	function stopping(): boolean {
		return phase === "stopping"
	}

	function post(message: FromNative): void {
		port.postMessage(message)
	}

	function fatal(reason: NativeFatalReason, error?: unknown): void {
		const detail = error === undefined || sdk === null ? "" : `: ${describe(classify(sdk, error))}`

		console.error(`fatal (${reason})${detail}`)
		post({ t: "fatal", reason })
	}

	function describe(error: NativeError | "unauthenticated"): string {
		return error === "unauthenticated" ? error : error.message === undefined ? error.code : `${error.code}: ${error.message}`
	}

	// The server no longer takes the session: main signs out and stops the host; nothing new starts meanwhile.
	function authRevoked(): void {
		if (!revoked) {
			revoked = true
			console.error("the server rejected the session")
			post({ t: "authRevoked" })
		}
	}

	async function init(message: NativeInit): Promise<void> {
		phase = "starting"

		let addon: NativeSdk

		try {
			addon = loadAddon(message.addonPath)
			addon.init()
		} catch (error) {
			console.error(`addon not loaded: ${error instanceof Error ? error.message : String(error)}`)
			fatal("addonLoad")

			return
		}

		sdk = addon

		const session = clientFromSession(addon, message.session, message.logLevel)

		if (session === null) {
			fatal("session")

			return
		}

		const runtime = createRuntimeFeed(addon, { post, onAuthFailed: authRevoked })
		const convergence = createConvergence()

		feed = runtime
		runtime.subscribe(subscribed)

		try {
			const opened = await openEngine(addon, session.client, message.dir, {
				cache: convergence,
				sync: {
					onEvents: events => {
						runtime.events(events)
					},
					onWatchStatus: (pairId, status) => {
						runtime.watchStatus(pairId, status)

						if (status.state === addon.WatchState.Stopped || status.state === addon.WatchState.PairRemoved) {
							host?.watchEnded(pairId)
						}
					}
				}
			})

			if ("fatal" in opened) {
				fatal(opened.fatal, opened.error)

				return
			}

			engine = opened.engine

			// A shutdown may have come in while the engine opened.
			if (stopping()) {
				return
			}

			const current = createHostEngine({
				sdk: addon,
				engine: opened.engine,
				rootUuid: session.rootUuid,
				feed: runtime,
				plans,
				convergence,
				signal: abort.signal
			})

			host = current

			const pairs = await current.watchAll(error => {
				const failure = classify(addon, error)

				if (failure === "unauthenticated") {
					authRevoked()
				} else {
					console.error(`a watch did not start: ${describe(failure)}`)
				}
			})

			if (stopping()) {
				return
			}

			phase = "ready"
			console.log(`ready (${String(pairs.length)} pairs${opened.reset ? ", baseline reset" : ""})`)
			post({ t: "ready", pairs: pairs.map(info => toNativePair(addon, info)), reset: opened.reset })
		} catch (error) {
			if (classify(addon, error) === "unauthenticated") {
				authRevoked()
			} else {
				fatal("open", error)
			}
		}
	}

	async function call(message: Extract<ToNative, { t: "call" }>): Promise<void> {
		const reply = (error: NativeError) => {
			post({ t: "reply", id: message.id, ok: false, error })
		}

		if (phase !== "ready" || host === null || sdk === null) {
			reply({ code: "hostUnavailable" })

			return
		}

		if (revoked) {
			reply({ code: "unauthenticated" })

			return
		}

		// This host runs no rclone yet.
		if (isMountsOp(message.op)) {
			reply({ code: "unknown", message: "mounts are not available" })

			return
		}

		try {
			post({ t: "reply", id: message.id, ok: true, value: await run(host.ops, message.op, message.args) })
		} catch (error) {
			const failure = classify(sdk, error)

			if (failure === "unauthenticated") {
				authRevoked()
				reply({ code: "unauthenticated" })
			} else {
				reply(failure)
			}
		}
	}

	async function shutdown(): Promise<void> {
		if (phase === "stopping") {
			return
		}

		phase = "stopping"
		abort.abort()
		feed?.stop()
		plans.releaseAll()

		if (engine !== null) {
			let timer: NodeJS.Timeout | undefined

			await Promise.race([
				engine.close().catch((error: unknown) => {
					console.error(`engine close failed: ${sdk === null ? String(error) : describe(classify(sdk, error))}`)
				}),
				new Promise<void>(resolve => {
					timer = setTimeout(() => {
						console.error("engine close timed out")
						resolve()
					}, CLOSE_TIMEOUT_MS)
				})
			])
			clearTimeout(timer)
		}

		post({ t: "stopped" })
		setImmediate(() => {
			exit(0)
		})
	}

	port.on("message", ({ data }) => {
		const message = toNativeSchema(data)

		if (message instanceof type.errors) {
			// Never the validation summary: it can quote the values, the session among them.
			console.error("rejected a malformed message")

			const malformedCall = callIdSchema(data)

			if (!(malformedCall instanceof type.errors)) {
				post({ t: "reply", id: malformedCall.id, ok: false, error: { code: "unknown", message: "invalid call" } })
			}

			return
		}

		switch (message.t) {
			case "init":
				if (phase === "waiting") {
					void init(message)
				}

				return
			case "call":
				void call(message)

				return
			case "subscribe":
				subscribed = message.overview
				feed?.subscribe(message.overview)

				return
			case "shutdown":
				void shutdown()

				return
		}
	})
}

startHost(process.parentPort, code => {
	process.exit(code)
})
