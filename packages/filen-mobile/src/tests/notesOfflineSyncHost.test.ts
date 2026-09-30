// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// Coverage for the <NotesOfflineSync /> host component (src/features/notes/components/offlineSync.tsx),
// which loads the offline-notes ledger and kicks a convergence pass on mount, then re-syncs on every
// background → foreground transition. Mirrors offlineSyncHost.test.ts.
const { mockNotesOffline, appState } = vi.hoisted(() => {
	const listeners = new Set<(state: string) => void>()

	return {
		mockNotesOffline: { sync: vi.fn(), load: vi.fn() },
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
vi.mock("@/features/notes/notesOffline", () => ({ default: mockNotesOffline }))

import NotesOfflineSync from "@/features/notes/components/offlineSync"
import { render, act } from "@testing-library/react"
import React from "react"

// Flush the depth-1 fire-and-forget .catch() chains so they settle before assertions.
async function flushMicrotasks(): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
}

beforeEach(() => {
	vi.clearAllMocks()
	appState.currentState = "active"
	appState.listeners.clear()
	mockNotesOffline.sync.mockResolvedValue(undefined)
	mockNotesOffline.load.mockResolvedValue(undefined)
})

describe("NotesOfflineSync host", () => {
	it("loads the ledger and kicks one pass on mount (no foreground double-fire)", async () => {
		render(React.createElement(NotesOfflineSync))
		await flushMicrotasks()

		expect(mockNotesOffline.load).toHaveBeenCalledOnce()
		expect(mockNotesOffline.sync).toHaveBeenCalledOnce()
	})

	it("loads the ledger before the mount pass starts", async () => {
		render(React.createElement(NotesOfflineSync))
		await flushMicrotasks()

		const loadOrder = mockNotesOffline.load.mock.invocationCallOrder[0] ?? Infinity
		const syncOrder = mockNotesOffline.sync.mock.invocationCallOrder[0] ?? -Infinity

		expect(loadOrder).toBeLessThan(syncOrder)
	})

	it("does NOT fire the mount pass when the tree mounts in background (iOS cold BGTask launch)", async () => {
		// An unbudgeted pass here would win the in-flight join against the budgeted one the background
		// task runs moments later.
		appState.currentState = "background"

		render(React.createElement(NotesOfflineSync))
		await flushMicrotasks()

		expect(mockNotesOffline.sync).not.toHaveBeenCalled()
	})

	// The ledger load is what publishes the badge projection AND what `hasOfflineNotes` in
	// features/cameraUpload/sync reads to decide whether the OS background task stays registered. If
	// it were behind the AppState gate, a headless cold launch would leave the projection empty when
	// that debounced registration fires — and a notes-only user's background task would deregister
	// itself, killing the one trigger that reaches them.
	it("still loads the ledger when the tree mounts in background", async () => {
		appState.currentState = "background"

		render(React.createElement(NotesOfflineSync))
		await flushMicrotasks()

		expect(mockNotesOffline.load).toHaveBeenCalledOnce()
	})

	it("fires a pass on the first background → foreground transition", async () => {
		appState.currentState = "background"

		render(React.createElement(NotesOfflineSync))
		await flushMicrotasks()

		expect(mockNotesOffline.sync).not.toHaveBeenCalled()

		act(() => {
			appState.emit("active")
		})
		await flushMicrotasks()

		expect(mockNotesOffline.sync).toHaveBeenCalledOnce()
	})

	it("does not re-fire while the app stays active", async () => {
		const { rerender } = render(React.createElement(NotesOfflineSync))
		await flushMicrotasks()

		rerender(React.createElement(NotesOfflineSync))
		rerender(React.createElement(NotesOfflineSync))
		await flushMicrotasks()

		expect(mockNotesOffline.sync).toHaveBeenCalledOnce()
	})

	it("swallows a failing pass — a background sync must never surface as an unhandled rejection", async () => {
		mockNotesOffline.sync.mockRejectedValue(new Error("offline"))
		mockNotesOffline.load.mockRejectedValue(new Error("kv"))

		expect(() => render(React.createElement(NotesOfflineSync))).not.toThrow()

		await flushMicrotasks()
	})
})
