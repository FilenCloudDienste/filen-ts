import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { Chat, ChatMessage } from "@filen/sdk-rs"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { messageMenuActions, type MessageActionDescriptor } from "@/features/chats/components/thread/messageMenu.logic"
import { retryInflightMessage, removeInflightMessage } from "@/features/chats/lib/inflight"
import { disableMessageEmbed } from "@/features/chats/lib/messageActions"
import { blockContactByEmail } from "@/features/contacts/lib/actions"
import { useBlockedUsers } from "@/features/contacts/hooks/useBlockedUsers"
import { useChatComposerStore } from "@/features/chats/store/useChatComposer"
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
	// Whether to actively fetch the blocked set. The right-click / ⋯-overflow menus warm it on open (a
	// deliberate interaction, as before). The always-mounted hover bar reads passively so it never fires
	// a per-row request just to sit idle — its own inline buttons (reply/copy/edit) never need it.
	warmBlocked: boolean
}

export interface MessageActionsHandle {
	descriptors: MessageActionDescriptor[]
	runAction: (descriptor: MessageActionDescriptor) => void
}

// Single source of truth for a message's action set AND its dispatch, shared by the right-click context
// menu, the ⋯-overflow dropdown, and the hover action bar's inline icon buttons (messageActionBar.tsx) —
// every surface reads the SAME descriptor list (messageMenu.logic.ts's messageMenuActions) and routes
// through the SAME runAction, so there is one action model, not three. Copy is self-contained (clipboard
// + toast); retry/remove call the silent inflight helpers directly (the optimistic copy's uuid IS its
// inflightId, so the ChatMessageWithInflightId they need is reconstructed here); delete only ever
// dispatches the confirm request; disableEmbed/block are confirm-free (online-only, best-effort).
export function useMessageActions({
	chat,
	message,
	currentUserId,
	sendState,
	hasEmbeds,
	onRequestDelete,
	warmBlocked
}: UseMessageActionsArgs): MessageActionsHandle {
	const { t } = useTranslation("chats")
	const beginReply = useChatComposerStore(state => state.beginReply)
	const beginEdit = useChatComposerStore(state => state.beginEdit)
	const blocked = useBlockedUsers(warmBlocked)
	const descriptors = messageMenuActions(message, currentUserId, sendState, hasEmbeds, blocked)

	async function handleCopy(): Promise<void> {
		if (message.message === undefined) {
			return
		}

		try {
			await navigator.clipboard.writeText(message.message)
			toast.success(t("chatMessageCopyToast"))
		} catch (e) {
			toast.error(errorLabel(asErrorDTO(e)))
		}
	}

	async function handleDisableEmbed(): Promise<void> {
		const outcome = await disableMessageEmbed(message)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	async function handleBlock(): Promise<void> {
		const outcome = await blockContactByEmail({
			email: message.senderEmail,
			// senderId is `number` on the wasm surface — coerce so the local blocked-set cross-reference
			// matches by id, not only email.
			userId: BigInt(message.senderId),
			...(message.senderNickName !== undefined ? { nickName: message.senderNickName } : {}),
			...(message.senderAvatar !== undefined ? { avatar: message.senderAvatar } : {})
		})

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))

			return
		}

		toast.success(t("chatMessageBlockedToast"))
	}

	function runAction(descriptor: MessageActionDescriptor): void {
		if (descriptor.id === "reply") {
			beginReply(chat.uuid, { kind: "reply", message })

			return
		}

		if (descriptor.id === "disableEmbed") {
			void handleDisableEmbed()

			return
		}

		if (descriptor.id === "block") {
			void handleBlock()

			return
		}

		if (descriptor.id === "edit") {
			// Load the message body into the draft and pin edit mode in one write (mobile parity).
			beginEdit(chat.uuid, { kind: "edit", message }, message.message ?? "")

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
