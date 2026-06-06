import { type Chat } from "@/types"
import { useEffect } from "react"
import { PressableScale } from "@/components/ui/pressables"
import { useSecureStore } from "@/lib/secureStore"
import useChatsStore, { type Suggestions } from "@/features/chats/store/useChats.store"
import { useShallow } from "zustand/shallow"
import { findClosestIndexString } from "@filen/utils"
import PopupContainerView from "@/features/chats/components/chat/input/popupContainerView"

// Generic, trigger-driven autocomplete popup shared by mentions (`@`) and emojis (`:`).
// Both surfaces derive a `{ show, text }` slice from the input value + cursor, mirror their
// visibility into the chat store under `kind`, and render a pressable list that rewrites the
// trigger token in place. Callers supply the trigger char, the minimum token length, the item
// resolver, the per-item replacement suffix, the row key and the row renderer.
export function AutocompleteSuggestions<T>({
	chat,
	kind,
	trigger,
	minLength,
	singleTriggerTotalLength,
	getItems,
	buildReplacement,
	itemKey,
	renderItem
}: {
	chat: Chat
	kind: Extract<Suggestions, "mentions" | "emojis">
	trigger: string
	minLength: number
	// Total trimmed input length for which a bare trigger char (e.g. just "@" or ":xx") still
	// opens the popup — preserves the per-surface short-circuit from the original components.
	singleTriggerTotalLength: number
	getItems: (text: string) => T[]
	// Returns the string appended after `value.slice(0, closestIndex)` to form the new input
	// (e.g. `@user@host.com ` for mentions, `:emoji_name: ` for emojis).
	buildReplacement: (item: T) => string
	itemKey: (item: T) => string
	renderItem: (item: T) => React.ReactNode
}) {
	const [chatInputValue, setChatInputValue] = useSecureStore<string>(`chatInputValue:${chat.uuid}`, "")
	const inputSelection = useChatsStore(useShallow(state => state.inputSelection))
	const suggestionsVisible = useChatsStore(useShallow(state => state.suggestionsVisible))
	const inputFocused = useChatsStore(useShallow(state => state.inputFocused))

	const { show, text } = (() => {
		const valueNormalized = chatInputValue.toLowerCase()

		if (
			valueNormalized.length === 0 ||
			inputSelection.start === 0 ||
			suggestionsVisible.filter(s => s !== kind).length > 0 ||
			!inputFocused
		) {
			return {
				show: false,
				text: ""
			}
		}

		const closestIndex = findClosestIndexString(valueNormalized, trigger, inputSelection.start)
		const sliced = valueNormalized.slice(
			closestIndex === -1 ? valueNormalized.lastIndexOf(trigger) : closestIndex,
			inputSelection.start
		)

		return {
			show:
				(sliced === trigger && valueNormalized.trim().length === singleTriggerTotalLength) ||
				(sliced.startsWith(trigger) &&
					sliced.length >= minLength &&
					!sliced.includes(" ") &&
					!sliced.endsWith(trigger) &&
					!sliced.endsWith(" ") &&
					!valueNormalized
						.slice(0, closestIndex)
						.split(/[\s\n]+/)
						.at(-1)
						?.startsWith(trigger)),
			text: sliced
		}
	})()

	const items = getItems(text)

	useEffect(() => {
		if (show) {
			useChatsStore.getState().setSuggestionsVisible(prev => [...prev.filter(s => s !== kind), kind])
		} else {
			useChatsStore.getState().setSuggestionsVisible(prev => prev.filter(s => s !== kind))
		}
	}, [show, kind])

	if (!show || items.length === 0) {
		return null
	}

	return (
		<PopupContainerView scrollViewClassName="py-1">
			{items.map(item => {
				return (
					<PressableScale
						key={itemKey(item)}
						rippleColor="transparent"
						onPress={() => {
							if (chatInputValue.length === 0 || inputSelection.start === 0) {
								return
							}

							const closestIndex = findClosestIndexString(chatInputValue, trigger, inputSelection.start)

							if (closestIndex === -1) {
								return
							}

							const replacedMessage = chatInputValue.slice(0, closestIndex) + buildReplacement(item)

							if (replacedMessage.length === 0) {
								return
							}

							setChatInputValue(replacedMessage)

							useChatsStore.getState().setInputSelection({
								start: replacedMessage.length,
								end: replacedMessage.length
							})
						}}
					>
						{renderItem(item)}
					</PressableScale>
				)
			})}
		</PopupContainerView>
	)
}

export default AutocompleteSuggestions
