import { useTranslation } from "react-i18next"
import { useChatTypingStore, type ChatTypingUser } from "@/features/chats/store/useChatTyping"
import { visibleTypingUsers, typingText } from "@/features/chats/lib/typing"

// Reactive per-chat typing users, self excluded. Selects the raw per-chat slice (a stable reference that
// only changes on a store write, so no getSnapshot churn) and derives the visible list in render —
// React Compiler owns the memoization, so a fresh filter here is free.
export function useChatTyping(chatUuid: string, currentUserId: bigint | undefined): ChatTypingUser[] {
	const users = useChatTypingStore(state => state.typing[chatUuid])

	return visibleTypingUsers(users, currentUserId)
}

// The resolved, localized typing label for a chat (null when nobody is typing) — the one derivation both
// the thread footer indicator and the sidebar-row preview override render through.
export function useChatTypingLabel(chatUuid: string, currentUserId: bigint | undefined): string | null {
	const { t } = useTranslation("chats")
	const users = useChatTyping(chatUuid, currentUserId)
	const text = typingText(users)

	if (text === null) {
		return null
	}

	if (text.key === "chatTypingSingle") {
		return t(text.key, { name: text.name })
	}

	if (text.key === "chatTypingDouble") {
		return t(text.key, { name: text.name, other: text.other })
	}

	return t(text.key)
}
