import { AnyFile, MaybeEncryptedUniffi_Tags } from "@filen/sdk-rs"
import { contactDisplayName } from "@filen/shared"
import { type Chat, type ChatMessage } from "@/types"
import { type LinkResult } from "@/features/chats/queries/useChatMessageLinks.query"
import { type ChatMessageWithInflightId, type Suggestions } from "@/features/chats/store/useChats.store"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { openLinkedFilePreview } from "@/features/drive/linkedFilePreview"

// D4c: pure composition of the rendered message list. The messages query is replaced wholesale
// by every refetch, so a list rendered from query data alone loses optimistic pending bubbles on
// any refetch and never shows failed sends that only live in the inflight queue / error state.
// Layers, first-wins dedupe:
//   1. query data (server truth incl. reconciled optimistic copies — keyed by inner.uuid AND
//      inflightId so a committed message also shadows its queued twin),
//   2. older paginated pages (fetchedMessages),
//   3. the chat's inflight queue (pending sends) + failed-send snapshots (error entries whose
//      message was dropped from the queue), skipped when already present by uuid or inflightId.
// Sorted by sentTimestamp descending (inverted list — newest first), which also slots pending
// bubbles into their correct chronological position (they are the newest messages).
export function composeMessageList({
	queryMessages,
	fetchedMessages,
	inflightMessages,
	failedMessages
}: {
	queryMessages: ChatMessageWithInflightId[]
	fetchedMessages: ChatMessageWithInflightId[]
	inflightMessages: ChatMessageWithInflightId[]
	failedMessages: ChatMessageWithInflightId[]
}): ChatMessageWithInflightId[] {
	const byUuid = new Map<string, ChatMessageWithInflightId>()
	const seenInflightIds = new Set<string>()

	for (const message of queryMessages) {
		byUuid.set(message.inner.uuid, message)

		if (message.inflightId) {
			seenInflightIds.add(message.inflightId)
		}
	}

	for (const message of fetchedMessages) {
		if (byUuid.has(message.inner.uuid)) {
			continue
		}

		byUuid.set(message.inner.uuid, message)

		if (message.inflightId) {
			seenInflightIds.add(message.inflightId)
		}
	}

	for (const message of [...inflightMessages, ...failedMessages]) {
		if (byUuid.has(message.inner.uuid) || seenInflightIds.has(message.inflightId)) {
			continue
		}

		byUuid.set(message.inner.uuid, message)
		seenInflightIds.add(message.inflightId)
	}

	return [...byUuid.values()].sort((a, b) => Number(b.sentTimestamp) - Number(a.sentTimestamp))
}

/**
 * Resolves the best available display name for the sender of a reply-to message
 * when the sender is no longer present in chat.participants (e.g. they left the chat).
 * Prefers nickName → email → fallback (usually the i18n "unknown" string).
 */
/**
 * Whether the keyboard's own prediction strip should be suppressed, given what the input is showing.
 *
 * Only the @mention and :emoji pickers are lists the user picks from, so only they compete with the
 * keyboard's suggestions. A reply banner is not such a list, and it used to be lumped in here —
 * which silently disabled autocorrect and spellcheck for the whole of every reply.
 */
export function shouldSuppressKeyboardSuggestions(suggestionsVisible: readonly Suggestions[]): boolean {
	return suggestionsVisible.some(suggestion => suggestion === "mentions" || suggestion === "emojis")
}

export function resolveReplySenderDisplayName(senderNickName: string | undefined, senderEmail: string | undefined, fallback: string): string {
	if (senderNickName && senderNickName.length > 0) {
		return senderNickName
	}

	if (senderEmail && senderEmail.length > 0) {
		return senderEmail
	}

	return fallback
}

/**
 * Resolves the sender label rendered above a message bubble, or null when no label applies
 * (own messages, and 1:1 chats where the counterpart needs no attribution).
 *
 * Labels are shown in group chats (3+ current participants) AND for any sender who is no longer
 * in chat.participants (they left): without one, a departed sender's history is unattributable —
 * and in a group that shrank to two, indistinguishable from the remaining participant. Departed
 * senders resolve via the message-embedded sender fields, mirroring the reply-to fallback.
 */
export function messageSenderLabel(chat: Chat, message: ChatMessage, currentUserId: bigint | undefined, fallback: string): string | null {
	if (currentUserId === undefined || message.inner.senderId === currentUserId) {
		return null
	}

	const senderParticipant = chat.participants.find(p => p.userId === message.inner.senderId)

	if (senderParticipant) {
		return chat.participants.length > 2 ? contactDisplayName(senderParticipant) : null
	}

	return resolveReplySenderDisplayName(message.inner.senderNickName, message.inner.senderEmail, fallback)
}

// The decrypted-file/directory shape carried by a successful internal link.
export type InternalLinkData = Extract<
	LinkResult,
	{
		type: "internal"
		success: true
	}
>["data"]

export type SuccessfulLink = Extract<
	LinkResult,
	{
		success: true
	}
>

export type ResolvedLinkMedia =
	| {
			type: "image" | "video"
			url: string
			name: string
			linked: InternalLinkData | null
	  }
	| {
			type: "internal"
			url: null
			name: null
			linked: InternalLinkData
	  }
	| {
			type: null
			url: null
			name: null
			linked: null
	  }

// Pure classifier shared by the single- and multi-attachment render paths. `getFileUrl` builds
// the AnyFile.Linked HTTP url; without it internal media cannot be served and degrades to the
// generic internal attachment.
export function resolveLinkMedia(link: SuccessfulLink, getFileUrl: ((file: AnyFile) => string) | null | undefined): ResolvedLinkMedia {
	if (link.type === "external") {
		const { previewType, url, name } = link.data

		if ((previewType === "image" || previewType === "video") && url && name) {
			return {
				type: previewType,
				url,
				name,
				linked: null
			}
		}

		return {
			type: null,
			url: null,
			name: null,
			linked: null
		}
	}

	const data = link.data

	if (data.type === "file" && getFileUrl && (data.previewType === "image" || data.previewType === "video")) {
		const url = getFileUrl(new AnyFile.Linked(data.file))
		const name = data.file.name.tag === MaybeEncryptedUniffi_Tags.Decrypted ? data.file.name.inner[0] : data.file.uuid

		if (url && name) {
			return {
				type: data.previewType,
				url,
				name,
				linked: data
			}
		}
	}

	return {
		type: "internal",
		url: null,
		name: null,
		linked: data
	}
}

// Opens the right preview surface for an image/video attachment: a linked drive file routes
// through the in-app drive gallery (with a decrypt guard), everything else opens the external
// url preview. Effectful — drives the drive-preview store and surfaces a decrypt toast.
export function openAttachmentPreview({
	linked,
	url,
	name
}: {
	linked: InternalLinkData | null | undefined
	url: string
	name: string
}): void {
	if (linked && linked.type === "file") {
		openLinkedFilePreview(linked.file)

		return
	}

	useDrivePreviewStore.getState().open({
		initialItem: {
			type: "external",
			data: {
				url,
				name
			}
		},
		items: [
			{
				type: "external",
				data: {
					url,
					name
				}
			}
		]
	})
}
