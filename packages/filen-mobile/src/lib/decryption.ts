import { type DriveItem, type Note, type Chat, type ChatMessage, type NoteTag } from "@/types"
import { fastLocaleCompare } from "@filen/utils"

export function cannotDecryptPlaceholder(uuid: string): string {
	return `cannot_decrypt_${uuid}`
}

export function isDriveItemUndecryptable(item: DriveItem): boolean {
	return item.data.undecryptable
}

export function isNoteUndecryptable(note: Note): boolean {
	return note.undecryptable
}

export function isChatUndecryptable(chat: Chat): boolean {
	return chat.undecryptable
}

export function isMessageUndecryptable(message: ChatMessage): boolean {
	return message.undecryptable
}

export function isTagUndecryptable(tag: NoteTag): boolean {
	return tag.undecryptable
}

export function driveItemDisplayName(item: DriveItem): string {
	if (item.data.undecryptable) {
		return cannotDecryptPlaceholder(item.data.uuid)
	}

	return item.data.decryptedMeta?.name ?? item.data.uuid
}

export function noteDisplayTitle(note: Note): string {
	if (note.undecryptable) {
		return cannotDecryptPlaceholder(note.uuid)
	}

	return note.title ?? note.uuid
}

export function chatDisplayName(chat: Chat, currentUserId: bigint, soloFallback: string): string {
	if (chat.undecryptable) {
		return cannotDecryptPlaceholder(chat.uuid)
	}

	if (chat.name && chat.name.length > 0) {
		return chat.name
	}

	// 1:1 fallback: use the other participant's display name
	const others = chat.participants.filter(p => p.userId !== currentUserId)

	// Every other participant left (the backend keeps a chat alive with only yourself in it) —
	// joining an empty list would render an empty title everywhere.
	if (others.length === 0) {
		return soloFallback
	}

	if (others.length === 1) {
		const other = others[0]

		if (other) {
			return other.nickName && other.nickName.length > 0 ? other.nickName : other.email
		}
	}

	// Multi-party: render the joined list of display names, sorted to match the pre-decryption-feature behavior
	// (chats/list/chat/index.tsx previously sorted via fastLocaleCompare before joining).
	const displayNames = others.map(p => (p.nickName && p.nickName.length > 0 ? p.nickName : p.email))

	return displayNames.sort(fastLocaleCompare).join(", ")
}

export function messageDisplayBody(message: ChatMessage): string {
	if (message.undecryptable) {
		return cannotDecryptPlaceholder(message.inner.uuid)
	}

	return message.inner.message ?? ""
}

export function tagDisplayName(tag: NoteTag): string {
	if (tag.undecryptable) {
		return cannotDecryptPlaceholder(tag.uuid)
	}

	return tag.name ?? tag.uuid
}
