import { createElement } from "react"
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
import { ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu"

export interface MessageMenuContentProps {
	chat: Chat
	message: ChatMessage
	currentUserId: bigint | undefined
	// Send state drives which entries appear: failed → retry/remove; confirmed → delete (sender-only).
	sendState: ChatSendState
	// Pure embeds.logic.ts classification, computed once in messageRow.tsx (network-free) — gates the
	// "Disable embed" entry without this menu re-deriving link segments itself.
	hasEmbeds: boolean
	// Delete needs a confirm step; the confirm dialog itself lives with the mounting row (messageRow.tsx)
	// so it survives past the menu's own close — this content-only component just requests it.
	onRequestDelete: () => void
}

// Right-click surface for one message row. copy/delete for a confirmed message; retry/remove for a
// FAILED optimistic send (the durable send outbox's actionable failed bubble). Copy is self-contained
// (clipboard + toast); retry/remove call the silent inflight helpers directly (the optimistic copy's
// uuid IS its inflightId, so the ChatMessageWithInflightId they need is reconstructed here); delete only
// ever dispatches the confirm request; disableEmbed is confirm-free (online-only, best-effort, same
// posture as edit/delete — see messageActions.ts) and patches the cache straight from its own click
// handler, no dialog to defer to.
export function MessageContextMenuContent({
	chat,
	message,
	currentUserId,
	sendState,
	hasEmbeds,
	onRequestDelete
}: MessageMenuContentProps) {
	const { t } = useTranslation("chats")
	const beginReply = useChatComposerStore(state => state.beginReply)
	const beginEdit = useChatComposerStore(state => state.beginEdit)
	// Warm the blocked set here (this menu only opens on a deliberate right-click) so the "Block" entry
	// correctly hides an already-blocked sender; the read is cache-deduped, so the whole chat surface's
	// unread cross-reference benefits from it too.
	const blocked = useBlockedUsers(true)
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

	function handleClick(descriptor: MessageActionDescriptor): void {
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

	if (descriptors.length === 0) {
		return null
	}

	return (
		<ContextMenuContent>
			{descriptors.map(descriptor => (
				<ContextMenuItem
					key={descriptor.id}
					variant={
						descriptor.id === "delete" || descriptor.id === "remove" || descriptor.id === "block" ? "destructive" : "default"
					}
					onClick={event => {
						// Same propagation stop as chatMenu.tsx — without it the click would also bubble into
						// the (portaled) row's own click handling underneath.
						event.stopPropagation()
						handleClick(descriptor)
					}}
				>
					{createElement(descriptor.icon, { "aria-hidden": true })}
					{t(descriptor.labelKey)}
				</ContextMenuItem>
			))}
		</ContextMenuContent>
	)
}
