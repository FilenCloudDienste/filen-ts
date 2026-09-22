import { type DriveItem, type Note, type Chat, type ChatMessage, type NoteTag } from "@/types"
import { driveItemName, resolveChatParticipantsDisplayName } from "@filen/shared"

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

	return driveItemName(item)
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

	return resolveChatParticipantsDisplayName(others, soloFallback)
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
