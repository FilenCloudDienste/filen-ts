import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))
vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

import { useTransfersStore, type Transfer } from "@/stores/useTransfers.store"

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
		parent: {},
		abort: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn()
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

		it("smooths over a bursty pattern: speed stays positive between bursts", () => {
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 1000000, 0)])

			// Burst at t=1000ms (100 KB arrives all at once)
			vi.advanceTimersByTime(1000)
			useTransfersStore.getState().setTransfers([makeUploadFileTransfer("a", 1000000, 100000)])

			const speedRightAfterBurst = useTransfersStore.getState().stats.speed
			expect(speedRightAfterBurst).toBeGreaterThan(0)

			// 1 second of silence — let the backstop interval fire to advance the window
			// without any new SDK bytes arriving.
			vi.advanceTimersByTime(1000)

			// Speed should still be > 0 (the burst is still inside the 3s rolling window).
			// Without smoothing the displayed value would have dropped to 0 immediately
			// because no bytes arrived in the latest 100ms throttle window.
			expect(useTransfersStore.getState().stats.speed).toBeGreaterThan(0)
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

		it("does not blip negative or spike when a transfer completes and is removed", () => {
			useTransfersStore.getState().setTransfers([
				makeUploadFileTransfer("a", 1000, 0),
				makeUploadFileTransfer("b", 1000, 0)
			])

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

			// Never negative, never a wild spike. With clamped delta the speed after
			// a completed transfer is removed should not be negative and should not
			// spike far above the pre-completion rate.
			expect(speedAfterCompletion).toBeGreaterThanOrEqual(0)
			expect(speedAfterCompletion).toBeLessThanOrEqual(speedBefore * 2)
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
	})
})
