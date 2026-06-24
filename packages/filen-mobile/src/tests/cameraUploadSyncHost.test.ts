// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// Coverage for the <CameraUploadSync /> host component (src/features/cameraUpload/sync.tsx),
// specifically the scheduler/timer-hygiene fixes from the 2026-06-21 adversarial review:
//   CU-02 — register/unregister of the single OS task are serialized (last requested state wins).
//   CU-03 — a register firing for a logged-out app (isAuthed() === false) is refused.
//   CU-04 — the 5s syncDebounced is cancelled on unmount, symmetric with updateBackgroundTask.
// Mirrors the offlineSyncHost render-test pattern.

// es-toolkit/function's debounce is captured so each created debounced fn's trailing body can be
// invoked deterministically (no fake timers needed) and its .cancel() can be asserted. The module
// creates syncDebounced (5s) FIRST, then updateBackgroundTask (1s) — captured in that order.
const { debouncedHandles, RealSemaphore, mockBackgroundTask, mockAuth, mockCameraUpload, offlineBg } = vi.hoisted(() => {
	type Handle = {
		delay: number
		body: () => void
		cancel: ReturnType<typeof vi.fn>
		flush: ReturnType<typeof vi.fn>
		schedule: ReturnType<typeof vi.fn>
		invokeCount: number
	}

	const debouncedHandles: Handle[] = []

	// Faithful re-implementation of @filen/utils Semaphore (the shared mock is a no-op, which would
	// defeat the CU-02 serialization assertion). One-permit acquire/release with a FIFO waiter queue.
	class RealSemaphore {
		private counter = 0
		private waiting: Array<() => void> = []
		private head = 0
		private maxCount: number

		constructor(max = 1) {
			this.maxCount = max
		}

		acquire(): Promise<void> {
			if (this.counter < this.maxCount) {
				this.counter++

				return Promise.resolve()
			}

			return new Promise<void>(resolve => {
				this.waiting.push(resolve)
			})
		}

		release(): void {
			if (this.counter <= 0) {
				return
			}

			this.counter--

			while (this.head < this.waiting.length && this.counter < this.maxCount) {
				this.counter++

				const next = this.waiting[this.head]

				this.head++

				if (next) {
					next()
				}
			}
		}
	}

	const mockBackgroundTask = {
		registerBackgroundSync: vi.fn<() => Promise<void>>(async () => {}),
		unregisterBackgroundSync: vi.fn<() => Promise<void>>(async () => {})
	}

	const mockAuth = { isAuthed: vi.fn<() => Promise<{ isAuthed: boolean }>>(async () => ({ isAuthed: true })) }

	const mockCameraUpload = { sync: vi.fn<() => Promise<void>>(async () => {}), cancel: vi.fn() }

	const offlineBg = { value: false as boolean }

	return { debouncedHandles, RealSemaphore, mockBackgroundTask, mockAuth, mockCameraUpload, offlineBg }
})

vi.mock("es-toolkit/function", () => ({
	debounce: (body: () => void, delay: number) => {
		const handle = {
			delay,
			body,
			cancel: vi.fn(),
			flush: vi.fn(),
			schedule: vi.fn(),
			invokeCount: 0
		}

		debouncedHandles.push(handle)

		const debounced = () => {
			handle.invokeCount++
		}

		debounced.cancel = handle.cancel
		debounced.flush = handle.flush
		debounced.schedule = handle.schedule

		return debounced
	}
}))

vi.mock("@filen/utils", () => ({ Semaphore: RealSemaphore }))

vi.mock("@/features/cameraUpload/backgroundTask", () => mockBackgroundTask)

vi.mock("@/lib/auth", () => ({ default: mockAuth }))

vi.mock("@/features/cameraUpload/cameraUpload", () => ({
	default: mockCameraUpload,
	// shouldRegisterBackground is toggled purely via the offline-background secureStore key below, so
	// the config stays a harmless default (shouldSync=false) — keeps this test off the AnyNormalDir graph.
	useCameraUpload: () => ({
		config: {
			enabled: false,
			remoteDir: null,
			albumIds: [] as string[],
			activationTimestamp: 0,
			afterActivation: false,
			includeVideos: false,
			cellular: false,
			background: false,
			lowBattery: false,
			compress: false
		}
	})
}))

vi.mock("@/lib/secureStore", () => ({
	// Only the offline-background key is read via useSecureStore in sync.tsx (config goes through the
	// mocked useCameraUpload). Drive shouldRegisterBackground straight off this value.
	useSecureStore: () => [offlineBg.value]
}))

vi.mock("@/features/offline/offlineHelpers", () => ({
	OFFLINE_BACKGROUND_SYNC_SECURE_STORE_KEY: "offlineBackgroundSync"
}))

import CameraUploadSync from "@/features/cameraUpload/sync"
import { AppState } from "react-native"
import { render } from "@testing-library/react"
import React from "react"

// The two module-level debounced handles, in creation order. Accessors narrow away the
// possibly-undefined index access (the handles are created at module import time).
function handleAt(index: number) {
	const handle = debouncedHandles[index]

	if (!handle) {
		throw new Error(`debounced handle ${index} was not created`)
	}

	return handle
}

const syncDebouncedHandle = () => handleAt(0)
const updateBackgroundTaskHandle = () => handleAt(1)

// Flush the fire-and-forget microtask chain (applyBackgroundTaskRegistration is async).
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 6; i++) {
		await Promise.resolve()
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	offlineBg.value = false
	mockAuth.isAuthed.mockResolvedValue({ isAuthed: true })
	mockBackgroundTask.registerBackgroundSync.mockResolvedValue(undefined)
	mockBackgroundTask.unregisterBackgroundSync.mockResolvedValue(undefined)

	for (const handle of debouncedHandles) {
		handle.invokeCount = 0
	}

	const appStateMock = AppState as unknown as { currentState: string }

	appStateMock.currentState = "active"
})

describe("CameraUploadSync host — scheduler hygiene", () => {
	it("creates exactly two debounced timers: syncDebounced (5s) then updateBackgroundTask (1s)", () => {
		expect(debouncedHandles.length).toBe(2)
		expect(syncDebouncedHandle().delay).toBe(5000)
		expect(updateBackgroundTaskHandle().delay).toBe(1000)
	})

	it("CU-04: cancels BOTH syncDebounced and updateBackgroundTask on unmount", () => {
		const { unmount } = render(React.createElement(CameraUploadSync))

		expect(syncDebouncedHandle().cancel).not.toHaveBeenCalled()
		expect(updateBackgroundTaskHandle().cancel).not.toHaveBeenCalled()

		unmount()

		expect(syncDebouncedHandle().cancel).toHaveBeenCalled()
		expect(updateBackgroundTaskHandle().cancel).toHaveBeenCalled()
	})

	it("CU-03: refuses to register the background task when the app is logged out (isAuthed === false)", async () => {
		offlineBg.value = true
		mockAuth.isAuthed.mockResolvedValue({ isAuthed: false })

		render(React.createElement(CameraUploadSync))

		// The registration effect arms updateBackgroundTask — fire its trailing body.
		updateBackgroundTaskHandle().body()
		await flushMicrotasks()

		expect(mockAuth.isAuthed).toHaveBeenCalled()
		expect(mockBackgroundTask.registerBackgroundSync).not.toHaveBeenCalled()
		expect(mockBackgroundTask.unregisterBackgroundSync).not.toHaveBeenCalled()
	})

	it("registers when authed and shouldRegisterBackground is true; unregisters when it is false", async () => {
		offlineBg.value = true

		const { rerender } = render(React.createElement(CameraUploadSync))

		updateBackgroundTaskHandle().body()
		await flushMicrotasks()

		expect(mockBackgroundTask.registerBackgroundSync).toHaveBeenCalledOnce()
		expect(mockBackgroundTask.unregisterBackgroundSync).not.toHaveBeenCalled()

		// Flip the desired state off → a rerender re-runs the registration effect, updating
		// lastShouldRegisterBackground to false, so the same debounce body now unregisters.
		offlineBg.value = false
		mockBackgroundTask.registerBackgroundSync.mockClear()

		rerender(React.createElement(CameraUploadSync))

		updateBackgroundTaskHandle().body()
		await flushMicrotasks()

		expect(mockBackgroundTask.unregisterBackgroundSync).toHaveBeenCalled()
		expect(mockBackgroundTask.registerBackgroundSync).not.toHaveBeenCalled()
	})

	it("CU-02: serializes register/unregister so they never overlap and the LAST requested state wins", async () => {
		// Gate the first op (register) so it stays in-flight while a second op (unregister) is fired.
		// Held on an object so TS keeps the function type through the executor-closure assignment.
		const gate: { release: (() => void) | null } = { release: null }

		mockBackgroundTask.registerBackgroundSync.mockImplementation(
			() =>
				new Promise<void>(resolve => {
					gate.release = () => resolve()
				})
		)

		offlineBg.value = true

		const { rerender } = render(React.createElement(CameraUploadSync))

		// Fire #1 (register). It acquires the lock and blocks on the gated registerBackgroundSync.
		updateBackgroundTaskHandle().body()
		await flushMicrotasks()

		expect(mockBackgroundTask.registerBackgroundSync).toHaveBeenCalledOnce()
		expect(mockBackgroundTask.unregisterBackgroundSync).not.toHaveBeenCalled()

		// Now flip desired state to OFF and fire #2 (unregister) while #1 still holds the lock.
		offlineBg.value = false

		rerender(React.createElement(CameraUploadSync))

		updateBackgroundTaskHandle().body()
		await flushMicrotasks()

		// #2 must NOT have started its native call yet — it is blocked on the semaphore behind #1.
		expect(mockBackgroundTask.unregisterBackgroundSync).not.toHaveBeenCalled()

		// Release #1; #2 proceeds only now, in invocation order.
		if (gate.release) {
			gate.release()
		}

		await flushMicrotasks()

		expect(mockBackgroundTask.unregisterBackgroundSync).toHaveBeenCalledOnce()
		// Final OS state reflects the LAST requested value (off) — register ran once, then unregister ran.
		expect(mockBackgroundTask.registerBackgroundSync).toHaveBeenCalledOnce()
	})

	it("renders nothing", () => {
		const { container } = render(React.createElement(CameraUploadSync))

		expect(container.firstChild).toBeNull()
	})
})
