import { useEffect } from "react"
import useChatsStore, { type Suggestions } from "@/features/chats/store/useChats.store"

// The chat input popups (reply, mentions, emojis) are mutually exclusive: each hides while another is
// visible and mirrors its own visibility into the store under `kind`. `compute` receives whether any
// other popup is visible; its result is returned as-is.
export function useSuggestionSlot<T extends { show: boolean }>(kind: Suggestions, compute: (othersVisible: boolean) => T): T {
	const othersVisible = useChatsStore(state => state.suggestionsVisible.some(s => s !== kind))
	const result = compute(othersVisible)
	const show = result.show

	useEffect(() => {
		if (show) {
			useChatsStore.getState().setSuggestionsVisible(prev => [...prev.filter(s => s !== kind), kind])
		} else {
			useChatsStore.getState().setSuggestionsVisible(prev => prev.filter(s => s !== kind))
		}
	}, [show, kind])

	return result
}

export default useSuggestionSlot
