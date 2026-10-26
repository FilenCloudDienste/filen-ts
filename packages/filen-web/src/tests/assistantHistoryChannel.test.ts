import { afterEach, describe, expect, it, vi } from "vitest"

// Counts index reads; the rows themselves do not matter here.
const { indexReads } = vi.hoisted(() => ({ indexReads: { count: 0 } }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvEntriesJson: () => {
		indexReads.count++

		return Promise.resolve([])
	},
	kvKeys: () => Promise.resolve([]),
	kvDelete: () => Promise.resolve(),
	kvDeletePrefix: () => Promise.resolve()
}))

vi.mock("@/lib/signOutPending", () => ({ readSignOutPending: () => false }))

vi.mock("@/lib/sdk/session", () => ({
	hasPersistedSession: () => Promise.resolve(true),
	onAuthBroadcast: () => () => undefined
}))

import { resetConversationHistory, setHistoryOpen, useAssistantHistoryStore } from "@/features/assistant/store/conversationHistory"

const CHANNEL = "filen-web-assistant-history"

// Another tab's "changed" broadcast, settled: a probe channel has seen it, and any reload it started has
// had time to read.
async function broadcastFromOtherTab(): Promise<void> {
	const other = new BroadcastChannel(CHANNEL)
	const probe = new BroadcastChannel(CHANNEL)
	const seen = new Promise<void>(resolve => {
		probe.onmessage = () => {
			resolve()
		}
	})

	other.postMessage({ kind: "changed" })
	await seen
	await new Promise(resolve => setTimeout(resolve, 20))
	other.close()
	probe.close()
}

afterEach(() => {
	resetConversationHistory()
})

describe("history list across tabs", () => {
	it("reloads the index on another tab's change only while the list is open", async () => {
		setHistoryOpen(true)
		await vi.waitFor(() => {
			expect(useAssistantHistoryStore.getState().conversations).toEqual([])
		})
		setHistoryOpen(false)
		indexReads.count = 0

		await broadcastFromOtherTab()

		expect(indexReads.count).toBe(0)

		setHistoryOpen(true)
		await vi.waitFor(() => {
			expect(indexReads.count).toBe(1)
		})

		await broadcastFromOtherTab()

		expect(indexReads.count).toBe(2)
	})
})
