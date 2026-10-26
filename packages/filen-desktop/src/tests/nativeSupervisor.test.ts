import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopSyncHostState } from "@filen/shared/desktop"
import { BACKOFF_BASE_MS, backoffDelay, BACKOFF_CAP_MS, createCrashHistory, CRASH_WINDOW_MS } from "../main/native/backoff.ts"
import {
	createNativeSupervisor,
	IDLE_STOP_MS,
	SESSION_DEBOUNCE_MS,
	SHUTDOWN_TIMEOUT_MS,
	type NativeSupervisorDeps,
	type UtilityProcessLike
} from "../main/native/supervisor.ts"
import type { SessionRead } from "../shared/channels.ts"
import type { FromNative, ToNative } from "../shared/nativeProtocol.ts"

const ROOT = "3f2b8c1e-6a4d-4e2f-9b7a-1c5d8e9f0a2b"

const SESSION_OF = (userId: string, apiKey = "api-key") =>
	JSON.stringify({
		email: "user@example.com",
		userId: `$bigint:${userId}n`,
		rootUuid: ROOT,
		authInfo: "auth-info",
		privateKey: "private-key",
		apiKey,
		authVersion: 2
	})

class FakeNative extends EventEmitter implements UtilityProcessLike {
	readonly stdout = new PassThrough()
	readonly stderr = null
	readonly sent: ToNative[] = []
	// Answers a shutdown with `stopped`, as the real host does.
	cooperative = true
	killed = false

	postMessage(message: ToNative): void {
		this.sent.push(message)

		if (message.t === "shutdown" && this.cooperative) {
			queueMicrotask(() => this.emit("message", { t: "stopped" }))
		}
	}

	kill(): boolean {
		if (this.killed) {
			return false
		}

		this.killed = true
		queueMicrotask(() => this.emit("exit", 0))

		return true
	}

	reply(message: FromNative | Record<string, unknown>): void {
		this.emit("message", message)
	}

	crash(code = 1): void {
		this.killed = true
		this.emit("exit", code)
	}

	calls(): Extract<ToNative, { t: "call" }>[] {
		return this.sent.filter(message => message.t === "call")
	}
}

function harness(read: SessionRead = { status: "present", blob: SESSION_OF("1") }) {
	const forks: FakeNative[] = []
	const states: DesktopSyncHostState[] = []
	const vault = {
		read,
		get: vi.fn(() => Promise.resolve(vault.read)),
		clear: vi.fn(() => {
			vault.read = { status: "absent" }

			return Promise.resolve()
		})
	}
	const deps = {
		fork: () => {
			const native = new FakeNative()

			forks.push(native)

			return native
		},
		vault,
		addonPath: () => "/app/native/sdk-rs.node",
		dirFor: (userId: string) => Promise.resolve(`/data/sync-engine/${userId}`),
		demand: vi.fn<NativeSupervisorDeps["demand"]>(() => Promise.resolve(true)),
		log: { info: vi.fn(), warn: vi.fn() },
		onMessage: vi.fn<NativeSupervisorDeps["onMessage"]>(),
		onState: (state: DesktopSyncHostState) => {
			states.push(state)
		},
		onRevoked: vi.fn()
	} satisfies NativeSupervisorDeps

	return { supervisor: createNativeSupervisor(deps), forks, states, vault, deps, last: () => forks.at(-1) as FakeNative }
}

async function settle(ms = 0): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms)
}

function ready(native: FakeNative): void {
	native.reply({ t: "ready", pairs: [], reset: false })
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("backoff", () => {
	it("doubles from one second up to the cap", () => {
		expect(backoffDelay(0)).toBe(BACKOFF_BASE_MS)
		expect(backoffDelay(3)).toBe(8 * BACKOFF_BASE_MS)
		expect(backoffDelay(30)).toBe(BACKOFF_CAP_MS)
	})

	it("forgets crashes older than the window", () => {
		const history = createCrashHistory()

		for (let i = 0; i < 4; i++) {
			history.crashed(i)
		}

		expect(history.crashed(4 + CRASH_WINDOW_MS)).toBe(BACKOFF_BASE_MS)
	})
})

describe("createNativeSupervisor", () => {
	it("starts only with session and demand", async () => {
		const { supervisor, forks, deps, vault, states, last } = harness({ status: "absent" })

		supervisor.ensure("test")
		await settle()
		expect(forks).toHaveLength(0)

		vault.read = { status: "present", blob: SESSION_OF("1") }
		deps.demand.mockResolvedValue(false)
		supervisor.ensure("test")
		await settle()
		expect(forks).toHaveLength(0)
		expect(supervisor.state()).toEqual({ state: "off" })

		deps.demand.mockResolvedValue(true)
		supervisor.ensure("test")
		await settle()
		expect(forks).toHaveLength(1)
		expect(last().sent[0]).toEqual({
			t: "init",
			addonPath: "/app/native/sdk-rs.node",
			dir: "/data/sync-engine/1",
			session: SESSION_OF("1"),
			logLevel: "Info"
		})
		expect(supervisor.state()).toEqual({ state: "starting" })

		ready(last())
		expect(states.at(-1)).toEqual({ state: "running" })
		expect(deps.onMessage).toHaveBeenCalledWith({ t: "ready", pairs: [], reset: false }, "1")
	})

	it("unreadable vault never starts or clears", async () => {
		const { supervisor, forks, vault } = harness({ status: "unreadable" })

		supervisor.ensure("launch")
		await settle()
		expect(supervisor.state()).toEqual({ state: "off" })

		supervisor.subscribe(true)
		await settle()
		expect(supervisor.state()).toEqual({ state: "failed", reason: "keychainLocked" })
		expect(forks).toHaveLength(0)
		expect(vault.clear).not.toHaveBeenCalled()

		vault.read = { status: "present", blob: SESSION_OF("1") }
		supervisor.ensure("focus")
		await settle()
		expect(forks).toHaveLength(1)
		expect(vault.clear).not.toHaveBeenCalled()
	})

	it("revoked clears vault and does not restart", async () => {
		const { supervisor, forks, vault, deps, last } = harness()

		supervisor.ensure("launch")
		await settle()
		ready(last())
		last().reply({ t: "authRevoked" })
		await settle()

		expect(last().sent.at(-1)).toEqual({ t: "shutdown" })
		expect(last().killed).toBe(true)
		expect(vault.clear).toHaveBeenCalledOnce()
		expect(deps.onRevoked).toHaveBeenCalledOnce()
		expect(supervisor.state()).toEqual({ state: "off" })

		supervisor.ensure("focus")
		await settle(CRASH_WINDOW_MS)
		expect(forks).toHaveLength(1)
	})

	it("an unauthenticated reply revokes too", async () => {
		const { supervisor, vault, deps, last } = harness()

		supervisor.ensure("launch")
		await settle()
		ready(last())

		const result = supervisor.call("requestPass", { pairId: "1" })

		await settle()
		last().reply({ t: "reply", id: last().calls()[0]?.id ?? -1, ok: false, error: { code: "unauthenticated" } })

		expect(await result).toEqual({ ok: false, error: { code: "unauthenticated" } })
		await settle()
		expect(vault.clear).toHaveBeenCalledOnce()
		expect(deps.onRevoked).toHaveBeenCalledOnce()
	})

	it("session.set for another user restarts with the new dir", async () => {
		const { supervisor, forks, vault, last } = harness()

		supervisor.ensure("launch")
		await settle()
		ready(last())

		const first = last()

		vault.read = { status: "present", blob: SESSION_OF("2") }
		supervisor.sessionChanged(SESSION_OF("2"))
		supervisor.sessionChanged(SESSION_OF("2"))
		await settle(SESSION_DEBOUNCE_MS)

		expect(first.sent.at(-1)).toEqual({ t: "shutdown" })
		expect(first.killed).toBe(true)
		expect(forks).toHaveLength(2)
		expect(last().sent[0]).toMatchObject({ t: "init", dir: "/data/sync-engine/2", session: SESSION_OF("2") })
	})

	it("changed credentials re-seed; the same session does not", async () => {
		const { supervisor, forks, vault, last } = harness()

		supervisor.ensure("launch")
		await settle()
		ready(last())

		supervisor.sessionChanged(SESSION_OF("1"))
		await settle(SESSION_DEBOUNCE_MS)
		expect(forks).toHaveLength(1)

		vault.read = { status: "present", blob: SESSION_OF("1", "new-key") }
		supervisor.sessionChanged(SESSION_OF("1", "new-key"))
		await settle(SESSION_DEBOUNCE_MS)
		expect(forks).toHaveLength(2)
		expect(last().sent[0]).toMatchObject({ dir: "/data/sync-engine/1", session: SESSION_OF("1", "new-key") })
	})

	it("crash loop stops retrying", async () => {
		const { supervisor, forks, states, last } = harness()

		supervisor.ensure("launch")
		await settle()

		for (let crash = 0; crash < 4; crash++) {
			ready(last())
			last().crash()
			expect(states.at(-1)).toEqual({ state: "restarting", retryAt: Date.now() + backoffDelay(crash) })
			await settle(backoffDelay(crash))
			expect(forks).toHaveLength(crash + 2)
		}

		last().crash()
		expect(supervisor.state()).toEqual({ state: "failed", reason: "crashLoop" })
		await settle(CRASH_WINDOW_MS)
		supervisor.ensure("focus")
		await settle()
		expect(forks).toHaveLength(5)

		supervisor.retry()
		await settle()
		expect(forks).toHaveLength(6)
	})

	it("a malformed message kills and restarts the host", async () => {
		const { supervisor, forks, last } = harness()

		supervisor.ensure("launch")
		await settle()
		ready(last())
		last().reply({ t: "overview", pairs: [{ id: 1 }] })
		await settle()

		expect(forks[0]?.killed).toBe(true)
		expect(supervisor.state()).toMatchObject({ state: "restarting" })
		await settle(BACKOFF_BASE_MS)
		expect(forks).toHaveLength(2)
	})

	it("a reply that does not match its call is malformed", async () => {
		const { supervisor, last } = harness()

		supervisor.ensure("launch")
		await settle()
		ready(last())

		const result = supervisor.call("listPairs", {})

		await settle()
		last().reply({ t: "reply", id: last().calls()[0]?.id ?? -1, ok: true, value: "nope" })

		expect(await result).toEqual({ ok: false, error: { code: "hostUnavailable" } })
		expect(last().killed).toBe(true)
	})

	it("a call starts the host and waits for it to be ready", async () => {
		const { supervisor, deps, last } = harness()

		deps.demand.mockResolvedValue(false)

		const result = supervisor.call("listPairs", {})

		await settle()
		ready(last())
		await settle()
		last().reply({ t: "reply", id: last().calls()[0]?.id ?? -1, ok: true, value: [] })
		expect(await result).toEqual({ ok: true, value: [] })

		// Nothing else needs it, so it stops a minute later.
		await settle(IDLE_STOP_MS)
		expect(last().sent.at(-1)).toEqual({ t: "shutdown" })
		expect(supervisor.state()).toEqual({ state: "off" })
	})

	it("a fatal addon load fails without restarting", async () => {
		const { supervisor, forks, last } = harness()

		supervisor.ensure("launch")
		await settle()
		last().reply({ t: "fatal", reason: "addonLoad" })
		await settle(CRASH_WINDOW_MS)

		expect(supervisor.state()).toEqual({ state: "failed", reason: "addonMissing" })
		expect(forks).toHaveLength(1)
	})

	it("subscribing streams the overview once ready", async () => {
		const { supervisor, last } = harness()

		supervisor.subscribe(true)
		await settle()
		expect(last().sent).toHaveLength(1)
		ready(last())
		expect(last().sent.at(-1)).toEqual({ t: "subscribe", overview: true })
		supervisor.subscribe(false)
		expect(last().sent.at(-1)).toEqual({ t: "subscribe", overview: false })
	})

	it("signed out stops the host", async () => {
		const { supervisor, last } = harness()

		supervisor.ensure("launch")
		await settle()
		ready(last())
		supervisor.signedOut()
		await settle()

		expect(last().sent.at(-1)).toEqual({ t: "shutdown" })
		expect(last().killed).toBe(true)
		expect(supervisor.state()).toEqual({ state: "off" })
	})

	it("quit waits for stopped then kills", async () => {
		const { supervisor, last } = harness()

		supervisor.ensure("launch")
		await settle()
		ready(last())
		last().cooperative = false

		let stopped = false

		void supervisor.stop().then(() => {
			stopped = true
		})
		await settle()
		expect(last().sent.at(-1)).toEqual({ t: "shutdown" })
		expect(stopped).toBe(false)
		expect(last().killed).toBe(false)

		last().reply({ t: "stopped" })
		await settle()
		expect(stopped).toBe(true)
		expect(last().killed).toBe(true)
	})

	it("quit kills a host that never stops", async () => {
		const { supervisor, forks, last } = harness()

		supervisor.ensure("launch")
		await settle()
		ready(last())
		last().cooperative = false

		let stopped = false

		void supervisor.stop().then(() => {
			stopped = true
		})
		await settle(SHUTDOWN_TIMEOUT_MS - 1)
		expect(stopped).toBe(false)
		await settle(1)
		expect(stopped).toBe(true)
		expect(last().killed).toBe(true)

		supervisor.ensure("after quit")
		await settle(CRASH_WINDOW_MS)
		expect(forks).toHaveLength(1)
	})

	it("writes the host's output redacted", async () => {
		const { supervisor, deps, last } = harness()

		supervisor.ensure("launch")
		await settle()
		last().stdout.write('opened {"apiKey":"abc123"}\n')
		await settle()

		expect(deps.log.info).toHaveBeenCalledWith('native: opened {"apiKey":[redacted]}')
	})
})
