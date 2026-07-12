import { beforeEach, describe, expect, it, vi } from "vitest"
import { runLogout, type LogoutDeps } from "@/lib/logout"
import { log } from "@/lib/log"

// Every mock records its own label into a shared array by default — the single source of truth the
// ordering assertions below read. Failure tests override a mock's implementation directly (which
// replaces the recording body too), so a failed phase's label deliberately does not appear in
// `calls` — those tests assert via call counts instead, never via `calls`.
function makeHarness() {
	const calls: string[] = []

	const cancelQueries = vi.fn<() => Promise<void>>().mockImplementation(() => {
		calls.push("cancelQueries")
		return Promise.resolve()
	})
	const clearQueryCache = vi.fn<() => void>().mockImplementation(() => {
		calls.push("clearQueryCache")
	})
	const sdkLogout = vi.fn<() => Promise<void>>().mockImplementation(() => {
		calls.push("sdkLogout")
		return Promise.resolve()
	})
	const clearSession = vi.fn<() => Promise<void>>().mockImplementation(() => {
		calls.push("clearSession")
		return Promise.resolve()
	})
	const kvClear = vi.fn<() => Promise<void>>().mockImplementation(() => {
		calls.push("kvClear")
		return Promise.resolve()
	})
	const wipeServiceWorker = vi.fn<() => Promise<void>>().mockImplementation(() => {
		calls.push("wipeServiceWorker")
		return Promise.resolve()
	})
	const broadcast = vi.fn<() => void>().mockImplementation(() => {
		calls.push("broadcast")
	})
	const reload = vi.fn<() => void>().mockImplementation(() => {
		calls.push("reload")
	})

	const deps: LogoutDeps = { cancelQueries, clearQueryCache, sdkLogout, clearSession, kvClear, wipeServiceWorker, broadcast, reload }

	return { deps, calls, cancelQueries, clearQueryCache, sdkLogout, clearSession, kvClear, wipeServiceWorker, broadcast, reload }
}

beforeEach(() => {
	vi.restoreAllMocks()
})

describe("runLogout (injected deps, no worker)", () => {
	it("runs every phase in order: cancel+clear cache, sdk logout, clear session, kv clear, broadcast, reload", async () => {
		const h = makeHarness()

		await runLogout(h.deps)

		expect(h.calls).toEqual([
			"cancelQueries",
			"clearQueryCache",
			"sdkLogout",
			"clearSession",
			"kvClear",
			"wipeServiceWorker",
			"broadcast",
			"reload"
		])
	})

	it("wipes the service worker AFTER the local store wipe and BEFORE the broadcast+reload", async () => {
		const h = makeHarness()

		await runLogout(h.deps)

		const wipeSw = h.calls.indexOf("wipeServiceWorker")

		expect(wipeSw).toBeGreaterThan(h.calls.indexOf("kvClear"))
		expect(wipeSw).toBeLessThan(h.calls.indexOf("broadcast"))
		expect(wipeSw).toBeLessThan(h.calls.indexOf("reload"))
	})

	it("a failing service-worker wipe is isolated and never blocks broadcast+reload", async () => {
		const errorSpy = vi.spyOn(log, "error").mockImplementation(() => undefined)
		const h = makeHarness()
		h.wipeServiceWorker.mockRejectedValue(new Error("worker unreachable"))

		await runLogout(h.deps)

		expect(h.broadcast).toHaveBeenCalledTimes(1)
		expect(h.reload).toHaveBeenCalledTimes(1)
		expect(errorSpy).toHaveBeenCalledWith("logout", expect.stringContaining("wipe-service-worker"), expect.anything())
	})

	it("an async-rejecting phase is logged and never blocks a later phase", async () => {
		const errorSpy = vi.spyOn(log, "error").mockImplementation(() => undefined)
		const h = makeHarness()
		h.sdkLogout.mockRejectedValue(new Error("worker unreachable"))

		await runLogout(h.deps)

		expect(h.clearSession).toHaveBeenCalledTimes(1)
		expect(h.kvClear).toHaveBeenCalledTimes(1)
		expect(h.broadcast).toHaveBeenCalledTimes(1)
		expect(h.reload).toHaveBeenCalledTimes(1)
		expect(errorSpy).toHaveBeenCalledWith("logout", expect.stringContaining("sdk-logout"), expect.anything())
	})

	it("a synchronously-throwing phase is isolated exactly like a rejected one", async () => {
		const errorSpy = vi.spyOn(log, "error").mockImplementation(() => undefined)
		const h = makeHarness()
		h.broadcast.mockImplementation(() => {
			throw new Error("channel closed")
		})

		await runLogout(h.deps)

		expect(h.reload).toHaveBeenCalledTimes(1)
		expect(errorSpy).toHaveBeenCalledWith("logout", expect.stringContaining("broadcast"), expect.anything())
	})

	it("still settles and runs every phase exactly once when every phase fails", async () => {
		vi.spyOn(log, "error").mockImplementation(() => undefined)
		const h = makeHarness()
		h.cancelQueries.mockRejectedValue(new Error("a"))
		h.clearQueryCache.mockImplementation(() => {
			throw new Error("b")
		})
		h.sdkLogout.mockRejectedValue(new Error("c"))
		h.clearSession.mockRejectedValue(new Error("d"))
		h.kvClear.mockRejectedValue(new Error("e"))
		h.wipeServiceWorker.mockRejectedValue(new Error("f"))
		h.broadcast.mockImplementation(() => {
			throw new Error("g")
		})
		h.reload.mockImplementation(() => {
			throw new Error("h")
		})

		await expect(runLogout(h.deps)).resolves.toBeUndefined()

		expect(h.cancelQueries).toHaveBeenCalledTimes(1)
		expect(h.clearQueryCache).toHaveBeenCalledTimes(1)
		expect(h.sdkLogout).toHaveBeenCalledTimes(1)
		expect(h.clearSession).toHaveBeenCalledTimes(1)
		expect(h.kvClear).toHaveBeenCalledTimes(1)
		expect(h.wipeServiceWorker).toHaveBeenCalledTimes(1)
		expect(h.broadcast).toHaveBeenCalledTimes(1)
		expect(h.reload).toHaveBeenCalledTimes(1)
	})
})
