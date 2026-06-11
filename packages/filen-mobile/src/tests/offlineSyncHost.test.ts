// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"

// Coverage for the <OfflineSync /> host component (src/features/offline/sync.tsx),
// which kicks the initial offline index-refresh + offlineSync pass on mount and
// re-syncs on background → foreground transitions. Mirrors the notesSync
// host-component render tests.
const { mockOffline, mockOfflineSync, mockAlerts, appActive } = vi.hoisted(() => ({
	mockOffline: { updateIndex: vi.fn() },
	mockOfflineSync: { sync: vi.fn() },
	mockAlerts: { error: vi.fn() },
	appActive: { value: true }
}))

vi.mock("@/features/offline/offline", () => ({ default: mockOffline }))
vi.mock("@/features/offline/offlineSync", () => ({ default: mockOfflineSync }))
vi.mock("@/lib/alerts", () => ({ default: mockAlerts }))
vi.mock("@/hooks/useIsAppActive", () => ({ default: () => appActive.value }))

import OfflineSync from "@/features/offline/sync"
import { AppState } from "react-native"
import { render } from "@testing-library/react"
import React from "react"

// Flush the depth-1 fire-and-forget .catch() chain so it settles before assertions.
async function flushMicrotasks(): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
}

beforeEach(() => {
	vi.clearAllMocks()
	appActive.value = true
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
		// Audit B2a (2026-06-11): an iOS cold background launch mounts the layout with
		// AppState "background" — the unbudgeted mount sync must not race the budgeted
		// background pass for offlineSync's inFlight coalescing.
		const appStateMock = AppState as unknown as { currentState: string }
		const previous = appStateMock.currentState

		appStateMock.currentState = "background"
		appActive.value = false

		try {
			render(React.createElement(OfflineSync))
			await flushMicrotasks()

			expect(mockOffline.updateIndex).not.toHaveBeenCalled()
			expect(mockOfflineSync.sync).not.toHaveBeenCalled()
		} finally {
			appStateMock.currentState = previous
		}
	})

	it("surfaces an initial-sync failure via alerts.error", async () => {
		const err = new Error("index failed")
		mockOffline.updateIndex.mockRejectedValue(err)

		render(React.createElement(OfflineSync))
		await flushMicrotasks()

		expect(mockAlerts.error).toHaveBeenCalledWith(err)
	})

	it("fires offlineSync.sync on a background → foreground transition, but not on same-state rerenders", async () => {
		const { rerender } = render(React.createElement(OfflineSync))
		await flushMicrotasks()

		// Mount effect only.
		expect(mockOfflineSync.sync).toHaveBeenCalledTimes(1)

		// Same-state rerender → no extra sync.
		rerender(React.createElement(OfflineSync))
		await flushMicrotasks()

		expect(mockOfflineSync.sync).toHaveBeenCalledTimes(1)

		// Goes to background → no sync.
		appActive.value = false
		rerender(React.createElement(OfflineSync))
		await flushMicrotasks()

		expect(mockOfflineSync.sync).toHaveBeenCalledTimes(1)

		// Returns to foreground → one more sync.
		appActive.value = true
		rerender(React.createElement(OfflineSync))
		await flushMicrotasks()

		expect(mockOfflineSync.sync).toHaveBeenCalledTimes(2)
	})

	it("renders nothing", () => {
		const { container } = render(React.createElement(OfflineSync))

		expect(container.firstChild).toBeNull()
	})
})
