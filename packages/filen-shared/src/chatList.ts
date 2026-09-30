import { isBlocked, type BlockedUsers } from "./blocking"
import { parseNumbersFromString } from "./misc"

// The fields the conversation-list rules read, common to both apps' Chat types
export type ListChat = {
	uuid: string
	ownerId: bigint
	lastMessage?: { sentTimestamp: bigint } | undefined
	participants: readonly { userId: bigint; email: string }[]
}

function listTimestamp(chat: ListChat): number {
	// Exact for millisecond timestamps
	return chat.lastMessage ? Number(chat.lastMessage.sentTimestamp) : 0
}

// Newest lastMessage first, chats without one last. Ties (typically never-messaged chats) break on the
// uuid's digits, descending, so the order does not depend on the listing's order across refetches.
export function compareChats(a: ListChat, b: ListChat): number {
	const diff = listTimestamp(b) - listTimestamp(a)

	return diff !== 0 ? diff : parseNumbersFromString(b.uuid) - parseNumbersFromString(a.uuid)
}

// Listed when the viewer owns it or it holds a message: a chat the viewer was merely invited to stays
// hidden until someone posts. An unresolved viewer owns nothing.
export function isListedChat(chat: ListChat, userId: bigint | undefined): boolean {
	return chat.lastMessage !== undefined || chat.ownerId === userId
}

// A 1:1 whose sole other participant is blocked. Group chats are never hidden wholesale; their blocked
// members' messages are tombstoned instead. An unresolved viewer counts as another participant, so a 1:1
// then reads as a group and stays visible.
export function isOneOnOneWithBlocked(chat: ListChat, userId: bigint | undefined, blocked: BlockedUsers): boolean {
	let other: ListChat["participants"][number] | undefined

	for (const participant of chat.participants) {
		if (participant.userId === userId) {
			continue
		}

		if (other !== undefined) {
			return false
		}

		other = participant
	}

	return other !== undefined && isBlocked(other, blocked)
}

// The lastMessage a chat takes from `incoming`: never an older one than it holds. A delayed own echo can
// land after a newer reply did. The same moment counts as newer, so a message's own echo replaces it.
export function newestMessage<T extends { sentTimestamp: bigint }>(current: T | undefined, incoming: T): T {
	return current !== undefined && incoming.sentTimestamp < current.sentTimestamp ? current : incoming
}
