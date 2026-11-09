import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"

// The cross-tab reload after a cache clear: other tabs reload when idle and ask while busy; the clearing tab carries
// its outcome over its own reload.

const mocks = vi.hoisted(() => ({
	busy: false,
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() })
}))

vi.mock("@/lib/unloadGuard", () => ({ hasUnloadHold: () => mocks.busy }))
vi.mock("sonner", () => ({ toast: mocks.toast }))

const channels = new Set<FakeChannel>()

class FakeChannel {
	private readonly listeners = new Set<(event: MessageEvent) => void>()

	public readonly name: string

	public constructor(name: string) {
		this.name = name
		channels.add(this)
	}

	public addEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
		this.listeners.add(listener)
	}

	public removeEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
		this.listeners.delete(listener)
	}

	public postMessage(data: unknown): void {
		for (const other of channels) {
			if (other !== this && other.name === this.name) {
				for (const listener of other.listeners) {
					listener({ data } as MessageEvent)
				}
			}
		}
	}
}

const reload = vi.fn()
const stored = new Map<string, string>()

async function openTab(): Promise<typeof import("@/features/settings/lib/cacheReload")> {
	vi.resetModules()

	return await import("@/features/settings/lib/cacheReload")
}

beforeEach(() => {
	channels.clear()
	stored.clear()
	reload.mockReset()
	mocks.busy = false
	mocks.toast.mockReset()
	mocks.toast.success.mockReset()
	vi.stubGlobal("BroadcastChannel", FakeChannel)
	vi.stubGlobal("location", { reload })
	vi.stubGlobal("sessionStorage", {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => stored.set(key, value),
		removeItem: (key: string) => stored.delete(key)
	})
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("cache clear reload", () => {
	it("reloads an idle other tab, and the clearing tab after it", async () => {
		const other = await openTab()
		const stop = other.onCachesClearedElsewhere()
		const clearing = await openTab()

		expect(clearing.finishWithReload([{ kind: "success", message: "Caches cleared" }])).toBe(true)
		expect(reload).toHaveBeenCalledTimes(2)
		stop()
	})

	it("asks a busy other tab instead of reloading it", async () => {
		const other = await openTab()

		other.onCachesClearedElsewhere()
		mocks.busy = true

		const clearing = await openTab()

		// The clearing tab is busy too: it asks, and shows its outcome now.
		expect(clearing.finishWithReload([{ kind: "success", message: "Caches cleared" }])).toBe(false)
		expect(reload).not.toHaveBeenCalled()
		expect(mocks.toast).toHaveBeenCalledWith("Caches were cleared in another tab. Reload this tab to finish.", expect.any(Object))
		expect(mocks.toast).toHaveBeenCalledWith("Caches cleared. Reload to finish.", expect.any(Object))
		expect(mocks.toast.success).toHaveBeenCalledWith("Caches cleared")
	})

	it("ignores a message it does not know", async () => {
		const other = await openTab()

		other.onCachesClearedElsewhere()
		new FakeChannel("filen.caches.v1").postMessage({ kind: "somethingElse" })

		expect(reload).not.toHaveBeenCalled()
	})

	it("carries the outcome over the reload, once", async () => {
		const tab = await openTab()

		tab.finishWithReload([{ kind: "error", message: "Couldn't clear Thumbnails" }])

		const reloaded = await openTab()

		expect(reloaded.takeReportsAfterReload()).toEqual([{ kind: "error", message: "Couldn't clear Thumbnails" }])
		expect(reloaded.takeReportsAfterReload()).toEqual([])
	})
})
