import { createElement } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { ChatMessage } from "@filen/sdk-rs"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { messageMenuActions, type MessageActionDescriptor } from "@/features/chats/components/thread/messageMenu.logic"
import { ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu"

export interface MessageMenuContentProps {
	message: ChatMessage
	currentUserId: bigint | undefined
	// Delete needs a confirm step; the confirm dialog itself lives with the mounting row (messageRow.tsx)
	// so it survives past the menu's own close — this content-only component just requests it, mirrors
	// notes' TagContextMenuContent's dialog-routed entries.
	onRequestDelete: () => void
}

// Right-click surface for one message row (messageRow.tsx's own trigger) — copy/delete only, the
// minimal set that needs no composer this wave (reply/edit/embed-disable land with later waves). Copy
// is fully self-contained (clipboard write + toast, no cache patch, no dialog — mirrors noteMenu.tsx's
// own copyId handling); delete only ever dispatches the confirm request.
export function MessageContextMenuContent({ message, currentUserId, onRequestDelete }: MessageMenuContentProps) {
	const { t } = useTranslation("chats")
	const descriptors = messageMenuActions(message, currentUserId)

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
		if (descriptor.run === "direct") {
			void handleCopy()
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
					variant={descriptor.run === "dialog" ? "destructive" : "default"}
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
