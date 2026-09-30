// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// Coverage for the <OfflineSync /> host component (src/features/offline/sync.tsx),
// which kicks the initial offline index-refresh + offlineSync pass on mount and
// re-syncs on background → foreground transitions. Mirrors the notesSync
// host-component render tests.
const { mockOffline, mockOfflineSync, mockAlerts, appState } = vi.hoisted(() => {
	const listeners = new Set<(state: string) => void>()

	return {
		mockOffline: { updateIndex: vi.fn() },
		mockOfflineSync: { sync: vi.fn() },
		mockAlerts: { error: vi.fn() },
		appState: {
			currentState: "active",
			listeners,
			addEventListener(_type: string, handler: (state: string) => void) {
				listeners.add(handler)

				return {
					remove: () => {
						listeners.delete(handler)
					}
				}
			},
			emit(state: string) {
				appState.currentState = state

				for (const listener of listeners) {
					listener(state)
				}
			}
		}
	}
})

vi.mock("react-native", () => ({ AppState: appState }))
vi.mock("@/features/offline/offline", () => ({ default: mockOffline }))
vi.mock("@/features/offline/offlineSync", () => ({ default: mockOfflineSync }))
vi.mock("@/lib/alerts", () => ({ default: mockAlerts }))

import OfflineSync from "@/features/offline/sync"
import { render, act } from "@testing-library/react"
import React from "react"

// Flush the depth-1 fire-and-forget .catch() chain so it settles before assertions.
async function flushMicrotasks(): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
}

beforeEach(() => {
	vi.clearAllMocks()
	appState.currentState = "active"
	appState.listeners.clear()
	mockOffline.updateIndex.mockResolvedValue(undefined)
	mockOfflineSync.sync.mockResolvedValue(undefined)
})

describe("OfflineSync host", () => {
	it("kicks offline.updateIndex and offlineSync.sync once on mount (no foreground double-fire)", async () => {
		render(React.createElement(OfflineSync))
		await flushMicrotasks()

		expect(mockOffline.updateIndex).toHaveBeenCalledOnce()
		expect(mockOfflineSync.sync).toHaveBeenCalledOnce()
	})

	it("does NOT fire the mount sync when the tree mounts in background (iOS cold BGTask launch)", async () => {
		// An iOS cold background launch mounts the layout with AppState "background" — the
		// unbudgeted mount sync must not race the budgeted background pass for offlineSync's
		// inFlight coalescing.
		appState.currentState = "background"

		render(React.createElement(OfflineSync))
		await flushMicrotasks()

		expect(mockOffline.updateIndex).not.toHaveBeenCalled()
		expect(mockOfflineSync.sync).not.toHaveBeenCalled()
	})

	it("defers a background mount's first sync to the first transition to active", async () => {
		appState.currentState = "background"

		render(React.createElement(OfflineSync))
		await flushMicrotasks()

		act(() => {
			appState.emit("active")
		})
		await flushMicrotasks()

		expect(mockOfflineSync.sync).toHaveBeenCalledOnce()
	})

	it("surfaces an initial-sync failure via alerts.error", async () => {
		const err = new Error("index failed")
		mockOffline.updateIndex.mockRejectedValue(err)

		render(React.createElement(OfflineSync))
		await flushMicrotasks()

		expect(mockAlerts.error).toHaveBeenCalledWith(err)
	})

	it("fires offlineSync.sync on a background → foreground transition, but not on rerenders", async () => {
		const { rerender } = render(React.createElement(OfflineSync))
		await flushMicrotasks()

		// Mount effect only.
		expect(mockOfflineSync.sync).toHaveBeenCalledTimes(1)

		// Rerender → no extra sync.
		rerender(React.createElement(OfflineSync))
		await flushMicrotasks()

		expect(mockOfflineSync.sync).toHaveBeenCalledTimes(1)

		// Goes to background → no sync.
		act(() => {
			appState.emit("background")
		})
		await flushMicrotasks()

		expect(mockOfflineSync.sync).toHaveBeenCalledTimes(1)

		// Returns to foreground → one more sync.
		act(() => {
			appState.emit("active")
		})
		await flushMicrotasks()

		expect(mockOfflineSync.sync).toHaveBeenCalledTimes(2)
	})

	it("stops listening on unmount", () => {
		const { unmount } = render(React.createElement(OfflineSync))

		unmount()

		expect(appState.listeners.size).toBe(0)
	})

	it("renders nothing", () => {
		const { container } = render(React.createElement(OfflineSync))

		expect(container.firstChild).toBeNull()
	})
})
