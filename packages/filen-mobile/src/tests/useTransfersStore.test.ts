import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))
vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

import { useTransfersStore, type Transfer } from "@/features/transfers/store/useTransfers.store"

function makeUploadFileTransfer(id: string, size: number, bytesTransferred = 0, paused = false): Transfer {
	return {
		id,
		size,
		bytesTransferred,
		startedAt: Date.now(),
		paused,
		type: "uploadFile",
		errors: { upload: [], scan: [], unknown: [] },
		localFileOrDir: {},
		parent: {}
	} as unknown as Transfer
}

function makeDownloadFileTransfer(id: string, size: number, bytesTransferred = 0, paused = false): Transfer {
	return {
		id,
		size,
		bytesTransferred,
		startedAt: Date.now(),
		paused,
		type: "downloadFile",
		errors: { download: [], scan: [], unknown: [] },
		item: {},
		destination: {}
	} as unknown as Transfer
}

function makeDownloadDirectoryTransfer(id: string, size: number, bytesTransferred = 0, paused = false): Transfer {
	return {
		id,
		size,
		bytesTransferred,
		startedAt: Date.now(),
		paused,
		type: "downloadDirectory",
		knownFiles: 0,
		knownDirectories: 0,
		directoryQueryProgress: { bytesTransferred: 9999999, totalBytes: 9999999 },
		errors: { download: [], scan: [], unknown: [] },
		item: {},
		destination: {}
	} as unknown as Transfer
}

function makeUploadDirectoryTransfer(id: string, size: number, bytesTransferred = 0, paused = false): Transfer {
	return {
		id,
		size,
		bytesTransferred,
		startedAt: Date.now(),
		paused,
		type: "uploadDirectory",
		knownFiles: 0,
		knownDirectories: 0,
		errors: { upload: [], scan: [], unknown: [] },
		localFileOrDir: {},
		parent: {}
	} as unknown as Transfer
}

function resetStore(): void {
	useTransfersStore.setState({
		transfers: [],
		stats: { progress: 0, speed: 0, count: 0 }
	})
	// Setting transfers via the public API runs the cleanup that clears the
	// internal interval timer + module-level samples buffer.
	useTransfersStore.getState().setTransfers([])
}

describe("useTransfersStore", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
		resetStore()
	})

	afterEach(() => {
		resetStore()
		vi.useRealTimers()
	})

	describe("initial state", () => {
		it("starts with all zeros and no transfers", () => {
			const state = useTransfersStore.getState()

			expect(state.transfers).toEqual([])
			expect(state.stats).toEqual({ progress: 0, speed: 0, count: 0 })
		})
	})

	describe("count + progress", () => {
		it("count reflects the number of active transfers", () => {
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 1000)])

			expect(useTransfersStore.getState().stats.count).toBe(1)

			// Advance past the 100ms throttle window before the next setTransfers
			// so its stats recompute is actually allowed to run.
			vi.advanceTimersByTime(150)
			useTransfersStore.getState().setTransfers(prev => [...prev, makeUploadFileTransfer("b", 2000)])

			expect(useTransfersStore.getState().stats.count).toBe(2)
		})

		it("progress is bytesTransferred / size, clamped to [0, 1]", () => {
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 1000, 250)])

			expect(useTransfersStore.getState().stats.progress).toBe(0.25)

			// SDK keeps reporting bytes — bump and skip the throttle window so the
			// next setTransfers actually recomputes.
			vi.advanceTimersByTime(150)
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 1000, 1500)])

			expect(useTransfersStore.getState().stats.progress).toBe(1)
		})

		it("progress is 0 when all transfers have size 0", () => {
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("z", 0, 0)])

			expect(useTransfersStore.getState().stats.progress).toBe(0)
			expect(useTransfersStore.getState().stats.count).toBe(1)
		})
	})

	describe("transfer type variants", () => {
		it("downloadFile: stats count and progress computed from bytesTransferred/size, not directoryQueryProgress", () => {
			useTransfersStore.getState().setTransfers([makeDownloadFileTransfer("dl", 2000, 1000)])

			const stats = useTransfersStore.getState().stats

			expect(stats.count).toBe(1)
			expect(stats.progress).toBe(0.5)
		})

		it("downloadDirectory: directoryQueryProgress bytes are excluded; only top-level bytesTransferred/size count", () => {
			// directoryQueryProgress has a huge value — it must not contaminate totalBytesTransferred
			const transfer = makeDownloadDirectoryTransfer("dldir", 4000, 2000)
			useTransfersStore.getState().setTransfers([transfer])

			const stats = useTransfersStore.getState().stats

			expect(stats.count).toBe(1)
			// Progress uses only the top-level bytesTransferred (2000) / size (4000)
			expect(stats.progress).toBe(0.5)
		})

		it("uploadDirectory: stats computed from top-level bytesTransferred/size", () => {
			useTransfersStore.getState().setTransfers([makeUploadDirectoryTransfer("updir", 3000, 750)])

			const stats = useTransfersStore.getState().stats

			expect(stats.count).toBe(1)
			expect(stats.progress).toBe(0.25)
		})

		it("mixed transfer types: count and progress aggregate correctly", () => {
			useTransfersStore
				.getState()
				.setTransfers([
					makeUploadFileTransfer("uf", 1000, 500),
					makeDownloadFileTransfer("df", 1000, 250),
					makeUploadDirectoryTransfer("ud", 1000, 750)
				])

			const stats = useTransfersStore.getState().stats

			// count = 3
			expect(stats.count).toBe(3)
			// totalBytes = 3000, transferred = 1500 → progress = 0.5
			expect(stats.progress).toBeCloseTo(0.5)
		})
	})

	describe("speed smoothing", () => {
		it("reports bytes per SECOND, not bytes per millisecond", () => {
			// Add a transfer at t=0.
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 100000, 0)])

			// Advance 3s in 100ms steps, growing bytesTransferred by 100 each tick.
			// Total: 3000 bytes over 3 seconds = exactly 1000 bytes/sec.
			for (let i = 1; i <= 30; i++) {
				vi.advanceTimersByTime(100)
				useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 100000, i * 100)])
			}

			const speed = useTransfersStore.getState().stats.speed

			// Allow some tolerance for the leading baseline sample skew.
			expect(speed).toBeGreaterThan(900)
			expect(speed).toBeLessThan(1100)
		})

		it("smooths over a bursty pattern: speed stays positive within the rolling window after a burst", () => {
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 1000000, 0)])

			// Burst at t=1000ms (100 KB arrives all at once)
			vi.advanceTimersByTime(1000)
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 1000000, 100000)])

			const speedRightAfterBurst = useTransfersStore.getState().stats.speed
			expect(speedRightAfterBurst).toBeGreaterThan(0)

			// 1 second of silence — the burst sample is still inside the 5s rolling
			// window, so speed must remain positive. The backstop interval fires
			// every 100ms to advance the window; we verify this produces a positive
			// speed (not zero) because the burst delta is still in-window.
			vi.advanceTimersByTime(1000)

			const speedAfterSilence = useTransfersStore.getState().stats.speed
			expect(speedAfterSilence).toBeGreaterThan(0)
			// Speed must be less than or equal to the right-after-burst reading
			// because no new bytes arrived — the window is diluting the burst.
			expect(speedAfterSilence).toBeLessThanOrEqual(speedRightAfterBurst)
		})

		it("decays toward 0 once a burst rolls fully out of the rolling window", () => {
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 1000000, 0)])

			// Burst at t=100ms
			vi.advanceTimersByTime(100)
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 1000000, 100000)])

			// Wait long enough for the burst sample to age fully out of the window.
			// The backstop interval pushes zero-delta samples that crowd the burst
			// out. Window is 5s; advance well past it.
			vi.advanceTimersByTime(6000)

			expect(useTransfersStore.getState().stats.speed).toBe(0)
		})

		it("returns 0 when every transfer is paused", () => {
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 1000, 0)])

			// Build up a non-zero speed first
			for (let i = 1; i <= 10; i++) {
				vi.advanceTimersByTime(100)
				useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 1000, i * 50)])
			}

			expect(useTransfersStore.getState().stats.speed).toBeGreaterThan(0)

			// Now mark the only transfer as paused. Advance time so the throttle
			// allows the recompute to fire.
			vi.advanceTimersByTime(150)
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 1000, 500, true)])

			expect(useTransfersStore.getState().stats.speed).toBe(0)
		})

		it("mixed paused/active transfers: speed reflects the active subset, not zero", () => {
			// Two transfers, both initially active
			useTransfersStore
				.getState()
				.setTransfers([makeUploadFileTransfer("active", 100000, 0), makeUploadFileTransfer("paused", 100000, 0)])

			// Make active progress and advance past throttle on each step
			for (let i = 1; i <= 10; i++) {
				vi.advanceTimersByTime(100)
				useTransfersStore.getState().setTransfers([
					makeUploadFileTransfer("active", 100000, i * 1000),
					makeUploadFileTransfer("paused", 100000, 0, true) // paused stays frozen
				])
			}

			const stats = useTransfersStore.getState().stats
			// pausedCount (1) < transfers.length (2) → speed must be computed
			expect(stats.speed).toBeGreaterThan(0)
			// count is still 2 (paused transfers are counted in count)
			expect(stats.count).toBe(2)
		})

		it("does not blip negative or spike when a transfer completes and is removed", () => {
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 1000, 0), makeUploadFileTransfer("b", 1000, 0)])

			// Both transfers progress for 2 seconds.
			for (let i = 1; i <= 20; i++) {
				vi.advanceTimersByTime(100)
				useTransfersStore
					.getState()
					.setTransfers([makeUploadFileTransfer("a", 1000, i * 50), makeUploadFileTransfer("b", 1000, i * 50)])
			}

			const speedBefore = useTransfersStore.getState().stats.speed
			expect(speedBefore).toBeGreaterThan(0)

			// Transfer "a" completes and gets removed; total bytes briefly drops.
			vi.advanceTimersByTime(100)
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("b", 1000, 1000)])

			const speedAfterCompletion = useTransfersStore.getState().stats.speed

			// Never negative, never a wild spike. The clamped-delta algorithm should
			// prevent the removal of "a" from causing a negative speed reading.
			// A tight bound of 20% captures genuine regressions while allowing the
			// normal post-completion speed settling.
			expect(speedAfterCompletion).toBeGreaterThanOrEqual(0)
			expect(speedAfterCompletion).toBeLessThanOrEqual(speedBefore * 1.2)
		})
	})

	describe("throttle guard", () => {
		it("a second setTransfers within <100ms returns stale stats without recomputing", () => {
			// First call at t=0: sets up the batch and produces initial stats.
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 1000, 0)])
			const statsAfterFirst = useTransfersStore.getState().stats

			// Advance only 50ms — still inside the 100ms throttle window.
			vi.advanceTimersByTime(50)

			// Second call with significantly different bytesTransferred. The throttle
			// should return the stale stats object unchanged.
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 1000, 900)])
			const statsAfterSecond = useTransfersStore.getState().stats

			// The stale stats object reference must be the same — no new object was
			// allocated (Zustand shallow comparison treats same-reference as no-op).
			expect(statsAfterSecond).toBe(statsAfterFirst)
			// Progress should still reflect the first call's bytes, not 900.
			expect(statsAfterSecond.progress).toBe(0)
		})

		it("after throttle window expires, setTransfers recomputes stats", () => {
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 1000, 0)])
			const statsAfterFirst = useTransfersStore.getState().stats

			// Advance well past the 100ms throttle window.
			vi.advanceTimersByTime(150)
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 1000, 500)])
			const statsAfterSecond = useTransfersStore.getState().stats

			// A recompute happened — the object must be different and progress updated.
			expect(statsAfterSecond).not.toBe(statsAfterFirst)
			expect(statsAfterSecond.progress).toBe(0.5)
		})

		it("functional updater combined with throttle short-circuit: previous transfers threaded correctly", () => {
			// Prime with one transfer, advance past throttle.
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 1000, 0)])
			vi.advanceTimersByTime(150)

			// Use functional updater to append — count and progress should reflect both.
			useTransfersStore.getState().setTransfers(prev => [...prev, makeUploadFileTransfer("b", 1000, 500)])

			const stats = useTransfersStore.getState().stats

			expect(stats.count).toBe(2)
			// totalBytes=2000, transferred=500 → 0.25
			expect(stats.progress).toBe(0.25)

			// Now call again within the 100ms window with a functional updater.
			// The previous transfers array must be threaded through even though stats
			// won't be recomputed.
			vi.advanceTimersByTime(50)
			useTransfersStore.getState().setTransfers(prev => prev.map(t => ({ ...t, bytesTransferred: 800 })))

			// Stats object is stale (throttled), but transfers in store must be updated.
			const transfers = useTransfersStore.getState().transfers
			expect(transfers).toHaveLength(2)
			expect(transfers.every(t => t.bytesTransferred === 800)).toBe(true)
		})
	})

	describe("idle cleanup", () => {
		it("clears the backstop interval when the last transfer is removed", () => {
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 1000, 0)])

			// One pending interval should be scheduled.
			expect(vi.getTimerCount()).toBe(1)

			useTransfersStore.getState().setTransfers([])

			expect(vi.getTimerCount()).toBe(0)
			expect(useTransfersStore.getState().stats).toEqual({ progress: 0, speed: 0, count: 0 })
		})

		it("returns the same stats object reference when called repeatedly with no transfers", () => {
			const initialStats = useTransfersStore.getState().stats

			useTransfersStore.getState().setTransfers([])

			// Second redundant clear should not allocate a new stats object — selectors
			// subscribed via useShallow shouldn't be forced to re-render on no-op churn.
			expect(useTransfersStore.getState().stats).toBe(initialStats)
		})

		it("stats identity-preservation: second setTransfers([]) after first already reset counters returns the same reference", () => {
			// Add transfers, then remove them so stats reset to zeroes.
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 1000, 0)])
			useTransfersStore.getState().setTransfers([])

			const statsAfterFirstClear = useTransfersStore.getState().stats
			expect(statsAfterFirstClear).toEqual({ progress: 0, speed: 0, count: 0 })

			// Second clear — the branch that returns state.stats when already zeroed.
			useTransfersStore.getState().setTransfers([])

			expect(useTransfersStore.getState().stats).toBe(statsAfterFirstClear)
		})

		it("re-initializes speed state after a completed batch: first speed reading of new batch is not inflated", () => {
			// First batch: transfers progress for 2 seconds accumulating 200_000 bytes.
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 200000, 0)])

			for (let i = 1; i <= 20; i++) {
				vi.advanceTimersByTime(100)
				useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 200000, i * 10000)])
			}

			// End the first batch — interval cleared, speed state reset.
			vi.advanceTimersByTime(150)
			useTransfersStore.getState().setTransfers([])
			expect(vi.getTimerCount()).toBe(0)

			// Start a second batch from 0 bytes.
			vi.advanceTimersByTime(200)
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("b", 200000, 0)])

			// First tick: only 100 bytes arrive in the new batch — a fresh start.
			vi.advanceTimersByTime(100)
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("b", 200000, 100)])

			const stats = useTransfersStore.getState().stats
			// Speed must not be inflated by the first batch's cumulative bytes.
			// 100 bytes / ~100ms = ~1000 bytes/sec; it should be in a sane range,
			// not carrying over the 200_000 bytes from the previous batch.
			expect(stats.speed).toBeLessThan(10000)
			expect(stats.speed).toBeGreaterThanOrEqual(0)
		})
	})
})
