// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// Coverage for the <NotesOfflineSync /> host component (src/features/notes/components/offlineSync.tsx),
// which loads the offline-notes ledger and kicks a convergence pass on mount, then re-syncs on every
// background → foreground transition. Mirrors offlineSyncHost.test.ts.
const { mockNotesOffline, appActive } = vi.hoisted(() => ({
	mockNotesOffline: { sync: vi.fn(), load: vi.fn() },
	appActive: { value: true }
}))

vi.mock("@/features/notes/notesOffline", () => ({ default: mockNotesOffline }))
vi.mock("@/hooks/useIsAppActive", () => ({ default: () => appActive.value }))

import NotesOfflineSync from "@/features/notes/components/offlineSync"
import { AppState } from "react-native"
import { render } from "@testing-library/react"
import React from "react"

// Flush the depth-1 fire-and-forget .catch() chains so they settle before assertions.
async function flushMicrotasks(): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
}

function withAppState(state: string, run: () => void): void {
	const appStateMock = AppState as unknown as { currentState: string }
	const previous = appStateMock.currentState

	appStateMock.currentState = state

	try {
		run()
	} finally {
		appStateMock.currentState = previous
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	appActive.value = true
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

	it("does NOT fire the mount pass when the tree mounts in background (iOS cold BGTask launch)", async () => {
		// An unbudgeted pass here would win the in-flight join against the budgeted one the background
		// task runs moments later.
		appActive.value = false

		withAppState("background", () => {
			render(React.createElement(NotesOfflineSync))
		})

		await flushMicrotasks()

		expect(mockNotesOffline.sync).not.toHaveBeenCalled()
	})

	// The ledger load is what publishes the badge projection AND what `hasOfflineNotes` in
	// features/cameraUpload/sync reads to decide whether the OS background task stays registered. If
	// it were behind the AppState gate, a headless cold launch would leave the projection empty when
	// that debounced registration fires — and a notes-only user's background task would deregister
	// itself, killing the one trigger that reaches them.
	it("still loads the ledger when the tree mounts in background", async () => {
		appActive.value = false

		withAppState("background", () => {
			render(React.createElement(NotesOfflineSync))
		})

		await flushMicrotasks()

		expect(mockNotesOffline.load).toHaveBeenCalledOnce()
	})

	it("fires a pass on the first background → foreground transition", async () => {
		appActive.value = false

		const { rerender } = withAppStateRender("background")

		expect(mockNotesOffline.sync).not.toHaveBeenCalled()

		appActive.value = true

		rerender(React.createElement(NotesOfflineSync))
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

// Renders with AppState pinned for the duration of the initial mount only, returning the rerender
// handle so the transition can be driven afterwards.
function withAppStateRender(state: string): { rerender: (ui: React.ReactElement) => void } {
	const appStateMock = AppState as unknown as { currentState: string }
	const previous = appStateMock.currentState

	appStateMock.currentState = state

	try {
		return render(React.createElement(NotesOfflineSync))
	} finally {
		appStateMock.currentState = previous
	}
}
