import { createContext, useContext, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { Chat, ChatMessage } from "@filen/sdk-rs"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { copyText } from "@/lib/copyText"
import {
	applyMessageOfflineGate,
	messageMenuActions,
	type MessageActionDescriptor
} from "@/features/chats/components/thread/messageMenu.logic"
import { retryInflightMessage, removeInflightMessage } from "@/features/chats/lib/inflight"
import { disableMessageEmbed } from "@/features/chats/lib/messageActions"
import { blockContactByEmail } from "@/features/contacts/lib/actions"
import type { BlockedUsers } from "@filen/shared"
import { useIsOnline } from "@/lib/useIsOnline"
import { useChatComposerStore } from "@/features/chats/store/useChatComposer"
import { beginMessageEdit, endMessageEdit } from "@/features/chats/lib/composerEdit"
import type { ChatSendState } from "@/features/chats/store/useChatsInflight"

export interface UseMessageActionsArgs {
	chat: Chat
	message: ChatMessage
	currentUserId: bigint | undefined
	// Send state drives which entries appear: failed → retry/remove; confirmed → reply/edit/delete.
	sendState: ChatSendState
	// Pure embeds.logic.ts classification, computed once in messageRow.tsx (network-free) — gates the
	// "Disable embed" entry.
	hasEmbeds: boolean
	// Delete needs a confirm step; the confirm dialog itself lives with the mounting row (messageRow.tsx)
	// so it survives past the menu's own close — every renderer of this hook just requests it.
	onRequestDelete: () => void
	// From the thread's single enabled read (messageThread.tsx) — a per-row observer would be two contacts
	// subscriptions per rendered message.
	blocked: BlockedUsers
}

export interface MessageActionsHandle {
	descriptors: MessageActionDescriptor[]
	runAction: (descriptor: MessageActionDescriptor) => void
}

// Block confirms first, as the contacts page and mobile do: it also drops the sender from the contact
// list, which unblocking does not restore. The thread hosts one confirm for all its rows
// (useMessageBlockConfirm in messageThread.tsx) and hands its request down through this context; without
// a host, Block does nothing.
export const MessageBlockRequestContext = createContext<((message: ChatMessage) => void) | null>(null)

export interface MessageBlockConfirm {
	// The message whose sender the open confirm would block; null while closed.
	target: ChatMessage | null
	pending: boolean
	request: (message: ChatMessage) => void
	cancel: () => void
	confirm: () => Promise<void>
}

export function useMessageBlockConfirm(): MessageBlockConfirm {
	const { t } = useTranslation("chats")
	const [target, setTarget] = useState<ChatMessage | null>(null)
	const [pending, setPending] = useState(false)

	async function confirm(): Promise<void> {
		if (target === null) {
			return
		}

		setPending(true)
		const outcome = await blockContactByEmail({
			email: target.senderEmail,
			// senderId is `number` on the wasm surface — coerce so the local blocked-set cross-reference
			// matches by id, not only email.
			userId: BigInt(target.senderId),
			nickName: target.senderNickName,
			avatar: target.senderAvatar
		})
		setPending(false)
		setTarget(null)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))

			return
		}

		toast.success(t("chatMessageBlockedToast"))
	}

	return {
		target,
		pending,
		request: setTarget,
		cancel: () => {
			setTarget(null)
		},
		confirm
	}
}

// Single source of truth for a message's action set AND its dispatch, shared by the right-click context
// menu, the ⋯-overflow dropdown, and the hover action bar's inline icon buttons (messageActionBar.tsx) —
// every surface reads the SAME descriptor list (messageMenu.logic.ts's messageMenuActions) and routes
// through the SAME runAction, so there is one action model, not three. Copy is self-contained (clipboard
// + toast); retry/remove call the silent inflight helpers directly (the optimistic copy's uuid IS its
// inflightId, so the ChatMessageWithInflightId they need is reconstructed here); delete only ever
// dispatches the confirm request, block the thread's confirm (MessageBlockRequestContext); disableEmbed is
// confirm-free (online-only, best-effort).
export function useMessageActions({
	chat,
	message,
	currentUserId,
	sendState,
	hasEmbeds,
	onRequestDelete,
	blocked
}: UseMessageActionsArgs): MessageActionsHandle {
	const { t } = useTranslation("chats")
	const isOnline = useIsOnline()
	const beginReply = useChatComposerStore(state => state.beginReply)
	const requestBlock = useContext(MessageBlockRequestContext)
	const descriptors = applyMessageOfflineGate(messageMenuActions(message, currentUserId, sendState, hasEmbeds, blocked), isOnline)

	async function handleCopy(): Promise<void> {
		if (message.message === undefined) {
			return
		}

		await copyText(message.message, t("chatMessageCopyToast"))
	}

	async function handleDisableEmbed(): Promise<void> {
		const outcome = await disableMessageEmbed(message)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	function runAction(descriptor: MessageActionDescriptor): void {
		// Defense in depth at the dispatch layer — a stale render can never fire an offline-gated action.
		if (descriptor.enabled === false) {
			return
		}

		if (descriptor.id === "reply") {
			// An edit in progress ends first: its loaded body isn't a draft to reply with, and ending it brings
			// back what was typed before.
			endMessageEdit(chat.uuid)
			beginReply(chat.uuid, { kind: "reply", message })

			return
		}

		if (descriptor.id === "disableEmbed") {
			void handleDisableEmbed()

			return
		}

		if (descriptor.id === "block") {
			requestBlock?.(message)

			return
		}

		if (descriptor.id === "edit") {
			// Load the message body into the draft and pin edit mode (mobile parity); the typed draft is kept
			// aside until the edit ends.
			beginMessageEdit(chat.uuid, message)

			return
		}

		if (descriptor.id === "copy") {
			void handleCopy()

			return
		}

		if (descriptor.id === "retry") {
			void retryInflightMessage({ chat, message: { ...message, inflightId: message.uuid } })

			return
		}

		if (descriptor.id === "remove") {
			void removeInflightMessage({ chat, message: { ...message, inflightId: message.uuid } })

			return
		}

		onRequestDelete()
	}

	return { descriptors, runAction }
}
