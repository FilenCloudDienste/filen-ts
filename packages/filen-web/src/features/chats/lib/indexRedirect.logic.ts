import type { Chat } from "@filen/sdk-rs"
import { isListedChat, isOneOnOneWithBlocked, type BlockedUsers } from "@filen/shared"

export interface ChatsIndexRedirectInput {
	// undefined while the stored value is still being read.
	storedUuid: string | null | undefined
	chats: readonly Chat[] | undefined
	// The chats list, account or contacts still in flight: list membership cannot be judged yet.
	pending: boolean
	currentUserId: bigint | undefined
	blocked: BlockedUsers
}

// Where bare /chats goes: the last opened conversation (a uuid), the select prompt (null), or undecided
// (undefined). Only a conversation the sidebar lists qualifies — an unlisted chat or a hidden blocked 1:1
// would reopen a thread the list does not show.
export function chatsIndexRedirectTarget({
	storedUuid,
	chats,
	pending,
	currentUserId,
	blocked
}: ChatsIndexRedirectInput): string | null | undefined {
	if (storedUuid === null) {
		return null
	}

	if (storedUuid === undefined || pending) {
		return undefined
	}

	const chat = chats?.find(candidate => candidate.uuid === storedUuid)

	if (chat === undefined || !isListedChat(chat, currentUserId) || isOneOnOneWithBlocked(chat, currentUserId, blocked)) {
		return null
	}

	return chat.uuid
}
