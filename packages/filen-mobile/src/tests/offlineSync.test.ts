// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"

// Coverage for the <OfflineSync /> host component (src/features/offline/sync.tsx),
// which took over the initial offline index-refresh + sync that used to live in
// src/lib/setup.ts. Mirrors the notesSync host-component render tests.
const { mockOffline, mockAlerts } = vi.hoisted(() => ({
	mockOffline: { updateIndex: vi.fn(), sync: vi.fn() },
	mockAlerts: { error: vi.fn() }
}))

vi.mock("@/features/offline/offline", () => ({ default: mockOffline }))
vi.mock("@/lib/alerts", () => ({ default: mockAlerts }))

import OfflineSync from "@/features/offline/sync"
import { render } from "@testing-library/react"
import React from "react"

// Flush the depth-1 fire-and-forget .catch() chain so it settles before assertions.
async function flushMicrotasks(): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
}

beforeEach(() => {
	vi.clearAllMocks()
	mockOffline.updateIndex.mockResolvedValue(undefined)
	mockOffline.sync.mockResolvedValue(undefined)
})

describe("OfflineSync host", () => {
	it("kicks offline.updateIndex and offline.sync once on mount", async () => {
		render(React.createElement(OfflineSync))
		await flushMicrotasks()

		expect(mockOffline.updateIndex).toHaveBeenCalledOnce()
		expect(mockOffline.sync).toHaveBeenCalledOnce()
	})

	it("surfaces an initial-sync failure via alerts.error", async () => {
		const err = new Error("index failed")
		mockOffline.updateIndex.mockRejectedValue(err)

		render(React.createElement(OfflineSync))
		await flushMicrotasks()

		expect(mockAlerts.error).toHaveBeenCalledWith(err)
	})

	it("renders nothing", () => {
		const { container } = render(React.createElement(OfflineSync))

		expect(container.firstChild).toBeNull()
	})
})
