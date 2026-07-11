import { createElement } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { Chat, ChatMessage } from "@filen/sdk-rs"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { messageMenuActions, type MessageActionDescriptor } from "@/features/chats/components/thread/messageMenu.logic"
import { retryInflightMessage, removeInflightMessage } from "@/features/chats/lib/inflight"
import { useChatComposerStore } from "@/features/chats/store/useChatComposer"
import type { ChatSendState } from "@/features/chats/store/useChatsInflight"
import { ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu"

export interface MessageMenuContentProps {
	chat: Chat
	message: ChatMessage
	currentUserId: bigint | undefined
	// Send state drives which entries appear: failed → retry/remove; confirmed → delete (sender-only).
	sendState: ChatSendState
	// Delete needs a confirm step; the confirm dialog itself lives with the mounting row (messageRow.tsx)
	// so it survives past the menu's own close — this content-only component just requests it.
	onRequestDelete: () => void
}

// Right-click surface for one message row. copy/delete for a confirmed message; retry/remove for a
// FAILED optimistic send (the durable send outbox's actionable failed bubble). Copy is self-contained
// (clipboard + toast); retry/remove call the silent inflight helpers directly (the optimistic copy's
// uuid IS its inflightId, so the ChatMessageWithInflightId they need is reconstructed here); delete only
// ever dispatches the confirm request.
export function MessageContextMenuContent({ chat, message, currentUserId, sendState, onRequestDelete }: MessageMenuContentProps) {
	const { t } = useTranslation("chats")
	const beginReply = useChatComposerStore(state => state.beginReply)
	const beginEdit = useChatComposerStore(state => state.beginEdit)
	const descriptors = messageMenuActions(message, currentUserId, sendState)

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

	function handleClick(descriptor: MessageActionDescriptor): void {
		if (descriptor.id === "reply") {
			beginReply(chat.uuid, { kind: "reply", message })

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
					variant={descriptor.id === "delete" || descriptor.id === "remove" ? "destructive" : "default"}
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
