import { createInterface } from "node:readline"
import { type } from "arktype"
import type { DesktopSyncHostState } from "@filen/shared/desktop"
import { parseSessionBlob } from "@filen/shared/session"
import type { SessionRead } from "../../shared/channels.ts"
import {
	type FromNative,
	fromNativeSchema,
	type MountsOp,
	type NativeOp,
	type NativeOpArgs,
	type SyncOp,
	type ToNative
} from "../../shared/nativeProtocol.ts"
import { errorCode } from "../atomicFile.ts"
import { redact } from "../redact.ts"
import { serialQueue } from "../serial.ts"
import { createCrashHistory } from "./backoff.ts"
import { CALL_TIMEOUT_MS, createRpc, type NativeMountsResult, type NativeResult, type NativeRpc } from "./rpc.ts"

// A host nothing needs any more stops after this long, so a page closed and reopened keeps it.
export const IDLE_STOP_MS = 60_000
// What a stop gives the host to close the engine before it is killed; also what quitting waits at most.
export const SHUTDOWN_TIMEOUT_MS = 25_000
// A sign-in writes the session more than once in a row; the host restarts once for all of them.
export const SESSION_DEBOUNCE_MS = 1000

// The part of Electron's UtilityProcess the supervisor uses; tests pass a fake.
export interface UtilityProcessLike {
	readonly stdout: NodeJS.ReadableStream | null
	readonly stderr: NodeJS.ReadableStream | null
	postMessage(message: ToNative): void
	kill(): boolean
	on(event: "message", listener: (message: unknown) => void): unknown
	on(event: "exit", listener: (code: number) => void): unknown
}

export interface SyncUser {
	userId: string
	rootUuid: string
}

// What the host reports that the supervisor passes on.
export type NativeEvent = Extract<FromNative, { t: "ready" | "overview" | "aggregate" | "activity" | "mounts" | "mountsStats" }>

// What a page listens to: the sync runtime, or the mounts stats.
export type NativeTopic = "overview" | "mounts"

export interface NativeSupervisorDeps {
	fork(): UtilityProcessLike
	vault: { get(): Promise<SessionRead>; clear(): Promise<void> }
	// null: no addon for this build.
	addonPath(): string | null
	// The user's engine directory, created owner-only.
	dirFor(userId: string): Promise<string>
	// The user has work for the host: sync pairs or mounts, or old ones waiting to be imported.
	demand(userId: string): Promise<boolean>
	log: { info(message: string): void; warn(message: string): void }
	onMessage(message: NativeEvent, userId: string): void
	onState(state: DesktopSyncHostState): void
	// The server rejected the session; the vault is cleared already.
	onRevoked(): void
}

export interface NativeSupervisor {
	// Starts or stops the host as the session and demand now say; `reason` is logged.
	ensure(reason: string): void
	// The vault holds `blob` now: another user or changed credentials restart the host with it.
	sessionChanged(blob: string): void
	// Stops the host; the user's engine data stays.
	signedOut(): void
	// Starts the host when needed and waits for it to be ready. With `userId`, only that user's host answers (work
	// begun for one user never reaches the next one's engine).
	call<K extends SyncOp>(op: K, args: NativeOpArgs<K>, userId?: string): Promise<NativeResult<K>>
	// The same for rclone. `timeoutMs` for the calls that wait long (draining an old cache).
	callMounts<K extends MountsOp>(op: K, args: NativeOpArgs<K>, userId?: string, timeoutMs?: number): Promise<NativeMountsResult<K>>
	// A page shows the overview (or the mounts stats): the host streams it and stays up.
	subscribe(on: boolean, topic?: NativeTopic): void
	// After a failure: start again from a clean slate.
	retry(): void
	// The signed-in user, from the vault; null when signed out or unreadable.
	user(): Promise<SyncUser | null>
	state(): DesktopSyncHostState
	// A host process exists.
	active(): boolean
	// For quitting: stops the host for good, killing it after SHUTDOWN_TIMEOUT_MS.
	stop(): Promise<void>
}

// Whether the user has work for the host: true once any source says so, and the later ones are not read.
export async function anyDemand(sources: readonly (() => boolean | Promise<boolean>)[]): Promise<boolean> {
	for (const source of sources) {
		if (await source()) {
			return true
		}
	}

	return false
}

interface Child {
	proc: UtilityProcessLike
	blob: string
	userId: string
	rpc: NativeRpc
	ready: boolean
	// The exit was asked for (a stop, a fatal the host reported), so it is no crash.
	expected: boolean
	revoked: boolean
	// Settles on `stopped` or exit.
	done: Promise<void>
	finish(): void
}

const UNAVAILABLE = { ok: false, error: { code: "hostUnavailable" } } as const

export function createNativeSupervisor(deps: NativeSupervisorDeps): NativeSupervisor {
	// Starts, stops and restarts run one at a time.
	const serial = serialQueue()
	const crashes = createCrashHistory()
	let state: DesktopSyncHostState = { state: "off" }
	let current: Child | null = null
	const topics: Record<NativeTopic, boolean> = { overview: false, mounts: false }
	let subscribed = false
	let inFlight = 0
	let quitting = false
	// A failure only retry() or another user clears (the keychain one clears itself once the vault reads).
	let stuck = false
	let lastUserId: string | null = null
	let parsed: { blob: string; user: SyncUser | null } | null = null
	let retryTimer: NodeJS.Timeout | undefined
	let idleTimer: NodeJS.Timeout | undefined
	let sessionTimer: NodeJS.Timeout | undefined
	const readyWaiters = new Set<(ready: boolean) => void>()

	function setState(next: DesktopSyncHostState): void {
		if (JSON.stringify(next) === JSON.stringify(state)) {
			return
		}

		state = next
		deps.onState(next)

		if (next.state !== "starting" && next.state !== "restarting") {
			for (const waiter of readyWaiters) {
				waiter(next.state === "running")
			}

			readyWaiters.clear()
		}
	}

	function userOf(blob: string): SyncUser | null {
		if (parsed?.blob !== blob) {
			const session = parseSessionBlob(blob)

			parsed = { blob, user: session === null ? null : { userId: session.userId.toString(), rootUuid: session.rootUuid } }
		}

		return parsed.user
	}

	function readVault(): Promise<SessionRead> {
		return deps.vault.get().catch((): SessionRead => ({ status: "unreadable" }))
	}

	function ensure(reason: string): void {
		void serial(() => evaluate(reason))
	}

	function clearIdle(): void {
		clearTimeout(idleTimer)
		idleTimer = undefined
	}

	function scheduleIdleStop(): void {
		idleTimer ??= setTimeout(() => {
			idleTimer = undefined
			void serial(async () => {
				const child = current

				if (child === null || quitting || subscribed || inFlight > 0 || (await deps.demand(child.userId))) {
					return
				}

				deps.log.info("native: no sync work; stopping")
				await stopChild(child)
				setState({ state: "off" })
			})
		}, IDLE_STOP_MS)
	}

	function send(child: Child, message: ToNative): void {
		try {
			child.proc.postMessage(message)
		} catch {
			// Gone already; its exit is handled.
		}
	}

	async function stopChild(child: Child): Promise<void> {
		child.expected = true
		send(child, { t: "shutdown" })

		let timer: NodeJS.Timeout | undefined

		await Promise.race([
			child.done,
			new Promise<void>(resolve => {
				timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)
			})
		])
		clearTimeout(timer)
		child.proc.kill()
		child.rpc.failAll()

		if (current === child) {
			current = null
			clearIdle()
		}
	}

	async function evaluate(reason: string): Promise<void> {
		if (quitting) {
			return
		}

		const read = await readVault()

		if (read.status === "unreadable") {
			// Never a sign-out: nothing is cleared. Reported once sync was asked for; retried on the next ensure.
			if (current === null && (subscribed || inFlight > 0 || state.state !== "off")) {
				setState({ state: "failed", reason: "keychainLocked" })
			}

			return
		}

		const blob = read.status === "present" ? read.blob : null
		const user = blob === null ? null : userOf(blob)

		if (blob === null || user === null) {
			clearTimeout(retryTimer)
			retryTimer = undefined

			if (current !== null) {
				await stopChild(current)
			}

			setState({ state: "off" })

			return
		}

		if (user.userId !== lastUserId) {
			lastUserId = user.userId
			stuck = false
			crashes.reset()
		}

		// Re-seeding is a restart: the host builds its one client from the session it was started with.
		if (current !== null && current.blob !== blob) {
			deps.log.info("native: session changed; restarting")
			await stopChild(current)
		}

		const wanted = subscribed || inFlight > 0 || (await deps.demand(user.userId))

		if (current !== null) {
			if (wanted) {
				clearIdle()
			} else {
				scheduleIdleStop()
			}

			return
		}

		if (!wanted) {
			clearTimeout(retryTimer)
			retryTimer = undefined

			if (!stuck) {
				setState({ state: "off" })
			}

			return
		}

		if (stuck || retryTimer !== undefined) {
			return
		}

		await start(user, blob, reason)
	}

	async function start(user: SyncUser, blob: string, reason: string): Promise<void> {
		const addonPath = deps.addonPath()

		if (addonPath === null) {
			deps.log.warn("native: no sync addon in this build")
			stuck = true
			setState({ state: "failed", reason: "addonMissing" })

			return
		}

		let dir: string

		try {
			dir = await deps.dirFor(user.userId)
		} catch (error) {
			deps.log.warn(`native: engine directory unavailable: ${errorCode(error)}`)
			crashed(null)

			return
		}

		deps.log.info(`native: starting (${reason})`)
		setState({ state: "starting" })

		let proc: UtilityProcessLike

		try {
			proc = deps.fork()
		} catch (error) {
			deps.log.warn(`native: fork failed: ${errorCode(error)}`)
			crashed(null)

			return
		}

		const { promise: done, resolve: finish } = Promise.withResolvers<void>()
		const child: Child = {
			proc,
			blob,
			userId: user.userId,
			rpc: createRpc(call => send(child, call)),
			ready: false,
			expected: false,
			revoked: false,
			done,
			finish
		}

		current = child
		pipeLines(proc.stdout, deps.log.info)
		pipeLines(proc.stderr, deps.log.warn)
		proc.on("message", message => {
			onMessage(child, message)
		})
		proc.on("exit", code => {
			onExit(child, code)
		})
		send(child, { t: "init", addonPath, dir, session: blob, logLevel: "Info" })
	}

	function pipeLines(stream: NodeJS.ReadableStream | null, write: (message: string) => void): void {
		if (stream !== null) {
			createInterface({ input: stream, crlfDelay: Infinity }).on("line", line => {
				write(`native: ${redact(line)}`)
			})
		}
	}

	// Records a crash and schedules the restart, or gives up on a crash loop.
	function crashed(child: Child | null): void {
		if (child !== null) {
			deps.log.warn("native: exited unexpectedly")
		}

		const delay = crashes.crashed(Date.now())

		if (delay === null) {
			deps.log.warn("native: crashing repeatedly; not restarting")
			stuck = true
			setState({ state: "failed", reason: "crashLoop" })

			return
		}

		setState({ state: "restarting", retryAt: Date.now() + delay })
		retryTimer = setTimeout(() => {
			retryTimer = undefined
			ensure("restart")
		}, delay)
	}

	// Broken output means a broken host: kill it, the exit counts as a crash.
	function broken(child: Child, what: string): void {
		deps.log.warn(`native: ${what}; restarting`)
		child.proc.kill()
	}

	function revoked(child: Child): void {
		if (child.revoked) {
			return
		}

		child.revoked = true
		deps.log.warn("native: the server rejected the session; signing out")
		void serial(async () => {
			await stopChild(child)

			try {
				await deps.vault.clear()
			} catch (error) {
				deps.log.warn(`native: session removal failed: ${errorCode(error)}`)
			}

			setState({ state: "off" })
			deps.onRevoked()
		})
	}

	function onMessage(child: Child, raw: unknown): void {
		const message = fromNativeSchema(raw)

		if (message instanceof type.errors) {
			broken(child, "malformed message")

			return
		}

		if (message.t === "stopped") {
			child.finish()

			return
		}

		if (child !== current || child.revoked) {
			return
		}

		switch (message.t) {
			case "reply":
				if (!child.rpc.settle(message)) {
					broken(child, "malformed reply")
				} else if (!message.ok && message.error.code === "unauthenticated") {
					revoked(child)
				}

				return
			case "authRevoked":
				revoked(child)

				return
			case "fatal":
				deps.log.warn(`native: fatal (${message.reason})`)

				if (message.reason === "addonLoad" || message.reason === "baselineInUse") {
					child.expected = true
					stuck = true
					setState({ state: "failed", reason: message.reason === "addonLoad" ? "addonMissing" : "baselineInUse" })
				}

				child.proc.kill()

				return
			case "ready":
				child.ready = true
				deps.log.info(`native: ready (${message.pairs.length} pairs${message.reset ? ", baseline reset" : ""})`)
				setState({ state: "running" })

				if (subscribed) {
					send(child, { t: "subscribe", ...topics })
				}

				deps.onMessage(message, child.userId)
				ensure("ready")

				return
			default:
				deps.onMessage(message, child.userId)
		}
	}

	function onExit(child: Child, code: number): void {
		child.finish()
		child.rpc.failAll()

		if (child !== current) {
			return
		}

		current = null
		clearIdle()

		if (child.expected || quitting) {
			return
		}

		deps.log.warn(`native: exit code ${code}`)
		crashed(child)
	}

	function ready(): boolean {
		return current?.ready === true
	}

	// Starts the host when needed and waits for it to be ready, then calls through its rpc.
	async function invoke<R>(
		op: NativeOp,
		userId: string | undefined,
		through: (rpc: NativeRpc) => Promise<R>
	): Promise<R | typeof UNAVAILABLE> {
		inFlight++

		try {
			if (!ready()) {
				await serial(() => evaluate(`call ${op}`))

				const pending = state.state === "starting" || state.state === "restarting"

				if (!ready() && !(pending && (await waitReady()))) {
					return UNAVAILABLE
				}
			}

			const child = current

			return child?.ready === true && (userId === undefined || child.userId === userId) ? await through(child.rpc) : UNAVAILABLE
		} finally {
			inFlight--

			if (inFlight === 0 && !subscribed) {
				ensure("call settled")
			}
		}
	}

	function waitReady(): Promise<boolean> {
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				readyWaiters.delete(settle)
				resolve(false)
			}, CALL_TIMEOUT_MS)
			const settle = (ready: boolean) => {
				clearTimeout(timer)
				resolve(ready)
			}

			readyWaiters.add(settle)
		})
	}

	return {
		ensure,
		sessionChanged: blob => {
			clearTimeout(sessionTimer)
			sessionTimer = undefined

			if (current?.blob !== blob) {
				sessionTimer = setTimeout(() => {
					sessionTimer = undefined
					ensure("session")
				}, SESSION_DEBOUNCE_MS)
			}
		},
		signedOut: () => {
			clearTimeout(sessionTimer)
			sessionTimer = undefined
			void serial(async () => {
				clearTimeout(retryTimer)
				retryTimer = undefined

				if (current !== null) {
					deps.log.info("native: signed out; stopping")
					await stopChild(current)
				}

				stuck = false
				lastUserId = null
				crashes.reset()
				setState({ state: "off" })
			})
		},
		call: (op, args, userId) => invoke(op, userId, rpc => rpc.call(op, args)),
		callMounts: (op, args, userId, timeoutMs) => invoke(op, userId, rpc => rpc.callMounts(op, args, timeoutMs)),
		subscribe: (on, topic = "overview") => {
			if (on === topics[topic]) {
				return
			}

			topics[topic] = on
			subscribed = topics.overview || topics.mounts

			if (current?.ready === true) {
				send(current, { t: "subscribe", ...topics })
			}

			ensure(on ? `subscribed (${topic})` : `unsubscribed (${topic})`)
		},
		retry: () => {
			stuck = false
			crashes.reset()
			clearTimeout(retryTimer)
			retryTimer = undefined
			ensure("retry")
		},
		user: async () => {
			const read = await readVault()

			return read.status === "present" ? userOf(read.blob) : null
		},
		state: () => state,
		active: () => current !== null,
		stop: () => {
			quitting = true
			clearTimeout(sessionTimer)
			clearTimeout(retryTimer)
			clearIdle()

			return serial(async () => {
				if (current !== null) {
					await stopChild(current)
				}
			})
		}
	}
}
