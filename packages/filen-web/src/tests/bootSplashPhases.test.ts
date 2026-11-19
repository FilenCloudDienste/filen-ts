import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { BootSplashPhase } from "@/lib/bootSplash"
import { opfsUnavailableError } from "@/lib/storage/errors"

// bootSdk reports each completed phase to the splash, in order, and none past a failure. Each failure maps to its own
// boot reason, and every exit settles the whenBootReady() gate.
const { boot, advanceBootSplash, isOpfsApiAvailable, storage, session } = vi.hoisted(() => {
	class SessionUnreadableError extends Error {}

	return {
		boot: vi.fn<() => Promise<unknown>>(),
		advanceBootSplash: vi.fn<(phase: BootSplashPhase) => void>(),
		isOpfsApiAvailable: vi.fn(() => true),
		storage: vi.fn<() => Promise<unknown>>(),
		session: {
			SessionUnreadableError,
			clearSessionOutsideKv: vi.fn(() => Promise.resolve()),
			discardUnreadableSession: vi.fn(() => Promise.resolve()),
			persistSession: vi.fn(),
			resumeSession: vi.fn<() => Promise<boolean>>()
		}
	}
})

vi.mock("@/lib/bootSplash", () => ({ advanceBootSplash }))
vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { boot, setClientConfig: () => Promise.resolve() },
	threadCount: () => 2
}))
vi.mock("@/lib/storage/adapter", () => ({ storage, kvGetJson: () => Promise.resolve(null) }))
vi.mock("@/lib/storage/capability", () => ({ isOpfsApiAvailable }))
vi.mock("@/lib/sdk/session", () => session)
vi.mock("@/queries/client", () => ({ queryClient: {} }))
vi.mock("@/queries/persist", () => ({ restorePersistedQueries: vi.fn(), purgePersistedQueries: () => Promise.resolve() }))

// whenBootReady() is one module-level promise settled once, so each test boots a fresh module graph: the gate starts
// unsettled and the store read is the one that boot writes to.
async function loadBoot(): Promise<{ boot: typeof import("@/lib/sdk/boot"); store: typeof import("@/stores/boot") }> {
	vi.resetModules()

	const [bootModule, store] = await Promise.all([import("@/lib/sdk/boot"), import("@/stores/boot")])

	store.useBootStore.setState({ phase: "idle" })

	return { boot: bootModule, store }
}

// Whether the gate settles without anything else running first: a gate left unsettled stays false past a macrotask.
async function gateSettled(gate: Promise<void>): Promise<boolean> {
	let settled = false

	void gate.then(() => {
		settled = true
	})

	await new Promise(resolve => setTimeout(resolve, 0))

	return settled
}

// The first transform of boot's module graph is slow; later re-imports reuse it, so a test's own budget times its boot.
beforeAll(async () => {
	await import("@/lib/sdk/boot")
}, 60_000)

beforeEach(() => {
	boot.mockReset()
	boot.mockResolvedValue({ ok: true, threads: 2 })
	isOpfsApiAvailable.mockReturnValue(true)
	storage.mockReset()
	storage.mockResolvedValue({})
	session.resumeSession.mockReset()
	session.resumeSession.mockResolvedValue(false)
})

describe("bootSdk splash phases", () => {
	it("advances engine, storage and session in order before ready", async () => {
		const { boot: bootModule, store } = await loadBoot()

		await bootModule.bootSdk()

		expect(advanceBootSplash.mock.calls).toEqual([["engine"], ["storage"], ["session"]])
		expect(store.useBootStore.getState().phase).toBe("ready")
		expect(await gateSettled(bootModule.whenBootReady())).toBe(true)
	})

	it("advances nothing past a failed engine boot", async () => {
		boot.mockResolvedValue({ ok: false, reason: "pool", detail: "no threads" })
		const { boot: bootModule } = await loadBoot()

		await bootModule.bootSdk()

		expect(advanceBootSplash).not.toHaveBeenCalled()
	})

	it("stops after the engine when storage is unavailable", async () => {
		isOpfsApiAvailable.mockReturnValue(false)
		const { boot: bootModule } = await loadBoot()

		await bootModule.bootSdk()

		expect(advanceBootSplash.mock.calls).toEqual([["engine"]])
	})
})

describe("bootSdk failures", () => {
	it("reports the engine's own reason for a not-ok boot and settles the gate", async () => {
		boot.mockResolvedValue({ ok: false, reason: "pool", detail: "no threads" })
		const { boot: bootModule, store } = await loadBoot()

		await bootModule.bootSdk()

		expect(store.useBootStore.getState()).toMatchObject({ phase: "error", reason: "pool" })
		expect(storage).not.toHaveBeenCalled()
		expect(await gateSettled(bootModule.whenBootReady())).toBe(true)
	})

	it("reports opfs from the capability pre-check without opening storage, and settles the gate", async () => {
		isOpfsApiAvailable.mockReturnValue(false)
		const { boot: bootModule, store } = await loadBoot()

		await bootModule.bootSdk()

		expect(store.useBootStore.getState()).toMatchObject({ phase: "error", reason: "opfs" })
		expect(storage).not.toHaveBeenCalled()
		expect(session.resumeSession).not.toHaveBeenCalled()
		expect(await gateSettled(bootModule.whenBootReady())).toBe(true)
	})

	it("reports opfs when storage fails to open OPFS, and settles the gate", async () => {
		storage.mockRejectedValue(opfsUnavailableError(new Error("no sync access handle")))
		const { boot: bootModule, store } = await loadBoot()

		await bootModule.bootSdk()

		expect(store.useBootStore.getState()).toMatchObject({ phase: "error", reason: "opfs" })
		expect(advanceBootSplash.mock.calls).toEqual([["engine"]])
		expect(session.resumeSession).not.toHaveBeenCalled()
		expect(await gateSettled(bootModule.whenBootReady())).toBe(true)
	})

	it("reports async-runtime for any other storage failure, and settles the gate", async () => {
		storage.mockRejectedValue(new Error("no db leader after 10s"))
		const { boot: bootModule, store } = await loadBoot()

		await bootModule.bootSdk()

		expect(store.useBootStore.getState()).toMatchObject({ phase: "error", reason: "async-runtime" })
		expect(advanceBootSplash.mock.calls).toEqual([["engine"]])
		expect(await gateSettled(bootModule.whenBootReady())).toBe(true)
	})

	it("reports async-runtime when the session resume throws, and settles the gate", async () => {
		session.resumeSession.mockRejectedValue(new Error("runtime gone"))
		const { boot: bootModule, store } = await loadBoot()

		await bootModule.bootSdk()

		expect(store.useBootStore.getState()).toMatchObject({ phase: "error", reason: "async-runtime" })
		expect(await gateSettled(bootModule.whenBootReady())).toBe(true)
	})
})

describe("retrySessionResume failures", () => {
	it("reports async-runtime and leaves the recovery screen when the resume throws a non-unreadable error", async () => {
		const { boot: bootModule, store } = await loadBoot()

		store.useBootStore.setState({ phase: "sessionUnreadable" })
		session.resumeSession.mockRejectedValue(new Error("runtime gone"))

		await expect(bootModule.retrySessionResume(false)).resolves.toBe(true)
		expect(store.useBootStore.getState()).toMatchObject({ phase: "error", reason: "async-runtime" })
	})

	it("stays on the recovery screen while the session is still unreadable", async () => {
		const { boot: bootModule, store } = await loadBoot()

		store.useBootStore.setState({ phase: "sessionUnreadable" })
		session.resumeSession.mockRejectedValue(new session.SessionUnreadableError())

		await expect(bootModule.retrySessionResume(false)).resolves.toBe(false)
		expect(store.useBootStore.getState().phase).toBe("sessionUnreadable")
	})
})
