import { useSyncExternalStore } from "react"
import { preloadedPreference } from "@/lib/storage/preloadedPreference"
import { historyRetentionSchema, HISTORY_RETENTION_KEY, type HistoryRetention } from "@/features/assistant/store/history.logic"

// How long saved assistant conversations are kept, on this device: read during boot (lib/sdk/boot.ts, through
// loadHistoryRetention in conversationHistory.ts), so the first save already follows it. Changed only through
// setHistoryRetention, which applies it to the saved conversations and tells the other tabs.
export const retentionPreference = preloadedPreference<HistoryRetention>({
	key: HISTORY_RETENTION_KEY,
	schema: historyRetentionSchema,
	fallback: "forever",
	scope: "assistant",
	same: (a, b) => a === b
})

export const historyRetention = retentionPreference.get

export function useHistoryRetention(): HistoryRetention {
	return useSyncExternalStore(retentionPreference.subscribe, retentionPreference.get, retentionPreference.get)
}
