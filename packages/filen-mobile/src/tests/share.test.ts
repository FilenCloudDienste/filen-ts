import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

const { mockShareAsync, appStateHandlers, emitAppState } = vi.hoisted(() => {
	const appStateHandlers = new Set<(state: string) => void>()

	return {
		mockShareAsync: vi.fn(),
		appStateHandlers,
		emitAppState: (state: string) => {
			for (const handler of [...appStateHandlers]) {
				handler(state)
			}
		}
	}
})

vi.mock("expo-sharing", () => ({ shareAsync: mockShareAsync }))

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// Local react-native mock with a REAL AppState handler registry — the watchdog tests drive
// foreground/background transitions through it (the global alias mock drops handlers).
vi.mock("react-native", () => ({
	AppState: {
		currentState: "active" as string,
		addEventListener: (_type: string, handler: (state: string) => void) => {
			appStateHandlers.add(handler)

			return {
				remove: () => {
					appStateHandlers.delete(handler)
				}
			}
		}
	},
	Platform: {
		OS: "ios" as "ios" | "android",
		select<T>(this: { OS: "ios" | "android" }, specifics: { ios?: T; android?: T; default?: T }): T | undefined {
			return specifics[this.OS] ?? specifics["default"]
		}
	},
	Share: {
		share: vi.fn(async () => ({ action: "sharedAction" as const }))
	}
}))

// Mirror @filen/utils `run`: execute fn with a defer collector, then run the deferred
// callbacks (in reverse) on both success and failure, returning a Result.
vi.mock("@filen/utils", () => ({
	run: async (fn: (defer: (d: () => void) => void) => Promise<unknown>) => {
		const deferred: Array<() => void> = []
		const defer = (d: () => void) => {
			deferred.push(d)
		}

		try {
			const data = await fn(defer)

			for (const d of deferred.reverse()) {
				d()
			}

			return { success: true, data, error: null }
		} catch (error) {
			for (const d of deferred.reverse()) {
				d()
			}

			return { success: false, data: null, error }
		}
	}
}))

import { Platform, Share } from "react-native"
import { shareTmpFile, shareUrl, SHARE_SETTLE_GRACE_MS } from "@/lib/share"
import logger from "@/lib/logger"

describe("shareTmpFile", () => {
	beforeEach(() => {
		appStateHandlers.clear()
		mockShareAsync.mockReset().mockResolvedValue(undefined)
	})

	it("shares the uri with dialogTitle=name and default text/plain mime", async () => {
		const cleanup = vi.fn()
		const result = await shareTmpFile({ uri: "file:///tmp/a.txt", name: "a.txt", cleanup })

		expect(result.success).toBe(true)
		expect(mockShareAsync).toHaveBeenCalledTimes(1)
		expect(mockShareAsync).toHaveBeenCalledWith("file:///tmp/a.txt", {
			mimeType: "text/plain",
			dialogTitle: "a.txt"
		})
	})

	it("uses the provided mimeType when given", async () => {
		const cleanup = vi.fn()

		await shareTmpFile({ uri: "file:///tmp/x.pdf", name: "x.pdf", mimeType: "application/pdf", cleanup })

		expect(mockShareAsync).toHaveBeenCalledWith("file:///tmp/x.pdf", {
			mimeType: "application/pdf",
			dialogTitle: "x.pdf"
		})
	})

	it("runs cleanup after a successful share", async () => {
		const cleanup = vi.fn()

		await shareTmpFile({ uri: "file:///tmp/a.txt", name: "a.txt", cleanup })

		expect(cleanup).toHaveBeenCalledTimes(1)
	})

	it("runs cleanup and returns failure when sharing throws", async () => {
		const cleanup = vi.fn()
		mockShareAsync.mockRejectedValue(new Error("share boom"))

		const result = await shareTmpFile({ uri: "file:///tmp/a.txt", name: "a.txt", cleanup })

		expect(result.success).toBe(false)
		expect(cleanup).toHaveBeenCalledTimes(1)
	})

	it("removes the AppState watchdog subscription once the native promise settles", async () => {
		await shareTmpFile({ uri: "file:///tmp/a.txt", name: "a.txt", cleanup: vi.fn() })

		expect(appStateHandlers.size).toBe(0)
	})
})

// The chooser's activity result can be dropped on Android (issue #77): expo-sharing's promise
// then never settles, which would hang the wrapper — cleanup unreached, presentation
// coordination (privacy cover / biometric re-lock) suppressed for the rest of the process.
describe("shareTmpFile — settle watchdog (dropped activity result)", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		appStateHandlers.clear()
		vi.mocked(logger.warn).mockClear()
		// Never settles — the wedged-module scenario.
		mockShareAsync.mockReset().mockReturnValue(new Promise<void>(() => {}))
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("settles (resolves) once the app has been back in the foreground for the grace period", async () => {
		const cleanup = vi.fn()
		const promise = shareTmpFile({ uri: "file:///tmp/logs.zip", name: "logs.zip", cleanup })

		// Flush delay → shareAsync fires and the watchdog subscribes.
		await vi.advanceTimersByTimeAsync(100)

		expect(mockShareAsync).toHaveBeenCalledTimes(1)
		expect(appStateHandlers.size).toBe(1)

		// The share sheet opens (app leaves foreground), the user finishes and returns.
		emitAppState("background")
		emitAppState("active")

		await vi.advanceTimersByTimeAsync(SHARE_SETTLE_GRACE_MS)

		const result = await promise

		expect(result.success).toBe(true)
		expect(cleanup).toHaveBeenCalledTimes(1)
		expect(appStateHandlers.size).toBe(0)
		expect(logger.warn).toHaveBeenCalled()
	})

	it("re-arms instead of firing while the user is still away in the share target", async () => {
		const cleanup = vi.fn()
		const promise = shareTmpFile({ uri: "file:///tmp/logs.zip", name: "logs.zip", cleanup })

		await vi.advanceTimersByTimeAsync(100)

		emitAppState("background")
		emitAppState("active")

		// Halfway through the grace the user jumps into the share target (backgrounds again) —
		// the pending timer must be disarmed, not fire mid-share.
		await vi.advanceTimersByTimeAsync(SHARE_SETTLE_GRACE_MS / 2)
		emitAppState("background")
		await vi.advanceTimersByTimeAsync(SHARE_SETTLE_GRACE_MS * 2)

		expect(cleanup).not.toHaveBeenCalled()

		// Final return: one full grace period later the wrapper settles.
		emitAppState("active")
		await vi.advanceTimersByTimeAsync(SHARE_SETTLE_GRACE_MS)

		const result = await promise

		expect(result.success).toBe(true)
		expect(cleanup).toHaveBeenCalledTimes(1)
	})

	it("the native settle wins when it arrives within the grace window (no watchdog warn)", async () => {
		let resolveShare: () => void = () => {}

		mockShareAsync.mockReset().mockReturnValue(
			new Promise<void>(resolve => {
				resolveShare = resolve
			})
		)

		const promise = shareTmpFile({ uri: "file:///tmp/a.txt", name: "a.txt", cleanup: vi.fn() })

		await vi.advanceTimersByTimeAsync(100)

		emitAppState("background")
		emitAppState("active")

		// The real activity result lands before the grace elapses.
		await vi.advanceTimersByTimeAsync(SHARE_SETTLE_GRACE_MS / 2)
		resolveShare()

		const result = await promise

		expect(result.success).toBe(true)
		expect(appStateHandlers.size).toBe(0)
		expect(logger.warn).not.toHaveBeenCalled()
	})
})

describe("shareUrl", () => {
	const URL = "https://drive.filen.io/d/abc#key"

	beforeEach(() => {
		appStateHandlers.clear()
		mockShareAsync.mockReset()
		vi.mocked(Share.share).mockReset().mockResolvedValue({ action: "sharedAction" })
		Platform.OS = "ios"
	})

	it("shares via the iOS `url` field on iOS", async () => {
		Platform.OS = "ios"

		await shareUrl(URL)

		expect(Share.share).toHaveBeenCalledTimes(1)
		expect(Share.share).toHaveBeenCalledWith({ url: URL })
	})

	it("shares via the `message` field on Android (Android ignores the url field)", async () => {
		Platform.OS = "android"

		await shareUrl(URL)

		expect(Share.share).toHaveBeenCalledTimes(1)
		expect(Share.share).toHaveBeenCalledWith({ message: URL })
	})

	it("never routes a url through expo-sharing (file-only on Android)", async () => {
		Platform.OS = "android"

		await shareUrl(URL)

		expect(mockShareAsync).not.toHaveBeenCalled()
	})

	it("propagates a rejection so the caller surfaces it", async () => {
		vi.mocked(Share.share).mockRejectedValue(new Error("share boom"))

		await expect(shareUrl(URL)).rejects.toThrow("share boom")
	})
})
