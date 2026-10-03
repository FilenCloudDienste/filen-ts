import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BootSplashPhase } from "@/lib/bootSplash"

// bootSdk reports each completed phase to the splash, in order, and none past a failure.
const { boot, advanceBootSplash, isOpfsApiAvailable } = vi.hoisted(() => ({
	boot: vi.fn<() => Promise<unknown>>(),
	advanceBootSplash: vi.fn<(phase: BootSplashPhase) => void>(),
	isOpfsApiAvailable: vi.fn(() => true)
}))

vi.mock("@/lib/bootSplash", () => ({ advanceBootSplash }))
vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { boot, setClientConfig: () => Promise.resolve() },
	threadCount: () => 2
}))
vi.mock("@/lib/storage/adapter", () => ({ storage: () => Promise.resolve({}), kvGetJson: () => Promise.resolve(null) }))
vi.mock("@/lib/storage/capability", () => ({ isOpfsApiAvailable }))
vi.mock("@/lib/sdk/session", () => ({ persistSession: vi.fn(), resumeSession: () => Promise.resolve(false) }))
vi.mock("@/queries/client", () => ({ queryClient: {} }))
vi.mock("@/queries/persist", () => ({ restorePersistedQueries: vi.fn(), purgePersistedQueries: () => Promise.resolve() }))

import { bootSdk } from "@/lib/sdk/boot"

beforeEach(() => {
	boot.mockResolvedValue({ ok: true, threads: 2 })
	isOpfsApiAvailable.mockReturnValue(true)
})

describe("bootSdk splash phases", () => {
	it("advances engine, storage and session in order before ready", async () => {
		await bootSdk()

		expect(advanceBootSplash.mock.calls).toEqual([["engine"], ["storage"], ["session"]])
	})

	it("advances nothing past a failed engine boot", async () => {
		boot.mockResolvedValue({ ok: false, reason: "pool", detail: "no threads" })

		await bootSdk()

		expect(advanceBootSplash).not.toHaveBeenCalled()
	})

	it("stops after the engine when storage is unavailable", async () => {
		isOpfsApiAvailable.mockReturnValue(false)

		await bootSdk()

		expect(advanceBootSplash.mock.calls).toEqual([["engine"]])
	})
})
