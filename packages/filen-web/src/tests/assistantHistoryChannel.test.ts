import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Counts index reads and prefix deletes; the rows themselves do not matter here.
const { indexReads, prefixDeletes } = vi.hoisted(() => ({ indexReads: { count: 0 }, prefixDeletes: [] as string[] }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvEntriesJson: () => {
		indexReads.count++

		return Promise.resolve([])
	},
	kvKeys: () => Promise.resolve([]),
	kvDelete: () => Promise.resolve(),
	kvDeletePrefix: (prefix: string) => {
		prefixDeletes.push(prefix)

		return Promise.resolve()
	}
}))

vi.mock("@/lib/signOutPending", () => ({ readSignOutPending: () => false }))

vi.mock("@/lib/sdk/session", () => ({
	hasPersistedSession: () => Promise.resolve(true),
	onAuthBroadcast: () => () => undefined
}))

type ConversationHistory = typeof import("@/features/assistant/store/conversationHistory")

const CHANNEL = "filen-web-assistant-history"

// Another tab's broadcast ("changed" by default), settled: a probe channel has seen it, and any reload it
// started has had time to read.
async function broadcastFromOtherTab(message: unknown = { kind: "changed" }): Promise<void> {
	const other = new BroadcastChannel(CHANNEL)
	const probe = new BroadcastChannel(CHANNEL)
	const seen = new Promise<void>(resolve => {
		probe.onmessage = () => {
			resolve()
		}
	})

	other.postMessage(message)
	await seen
	await new Promise(resolve => setTimeout(resolve, 20))
	other.close()
	probe.close()
}

// A fresh module per test: the reset after each closes that copy and its channel for good.
let history: ConversationHistory
let retention: typeof import("@/features/assistant/store/historyRetention")

beforeEach(async () => {
	vi.resetModules()
	history = await import("@/features/assistant/store/conversationHistory")
	retention = await import("@/features/assistant/store/historyRetention")
	indexReads.count = 0
	prefixDeletes.length = 0
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

describe("retention across tabs", () => {
	it("adopts a retention another tab set, clearing this tab's saved conversations again on Off", async () => {
		await history.loadHistoryRetention()

		expect(retention.historyRetention()).toBe("forever")

		await broadcastFromOtherTab({ kind: "retention", retention: "7d" })

		expect(retention.historyRetention()).toBe("7d")
		expect(prefixDeletes).toEqual([])

		await broadcastFromOtherTab({ kind: "retention", retention: "off" })
		await history.whenHistoryWritten()

		expect(retention.historyRetention()).toBe("off")
		expect(prefixDeletes).toEqual(["assistant.v1.history."])
	})

	it("ignores a malformed retention message", async () => {
		await history.loadHistoryRetention()
		await broadcastFromOtherTab({ kind: "retention", retention: "2d" })

		expect(retention.historyRetention()).toBe("forever")
		expect(prefixDeletes).toEqual([])
	})
})
