import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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

type ConversationHistory = typeof import("@/features/assistant/store/conversationHistory")

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

// A fresh module per test: the reset after each closes that copy and its channel for good.
let history: ConversationHistory

beforeEach(async () => {
	vi.resetModules()
	history = await import("@/features/assistant/store/conversationHistory")
	indexReads.count = 0
})

afterEach(() => {
	history.resetConversationHistory()
})

describe("history list across tabs", () => {
	it("reloads the index on another tab's change only while the list is open", async () => {
		history.setHistoryOpen(true)
		await vi.waitFor(() => {
			expect(history.useAssistantHistoryStore.getState().conversations).toEqual([])
		})
		history.setHistoryOpen(false)
		indexReads.count = 0

		await broadcastFromOtherTab()

		expect(indexReads.count).toBe(0)

		history.setHistoryOpen(true)
		await vi.waitFor(() => {
			expect(indexReads.count).toBe(1)
		})

		await broadcastFromOtherTab()

		expect(indexReads.count).toBe(2)
	})
})
