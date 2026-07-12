import { createElement, Fragment } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { Chat } from "@filen/sdk-rs"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { setChatMuted, markChatRead } from "@/features/chats/lib/actions"
import { chatHasUnread } from "@/features/chats/lib/unread.logic"
import { useBlockedUsers } from "@/features/contacts/hooks/useBlockedUsers"
import {
	applyOfflineGate,
	chatMenuActions,
	type ChatActionDescriptor,
	type ChatActionDialogKind
} from "@/features/chats/components/chatMenu.logic"
import { useIsOnline } from "@/lib/useIsOnline"
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu"
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"

export interface ChatMenuContentProps {
	chat: Chat
	currentUserId: bigint | undefined
	// Fires for every "dialog"-run descriptor (rename/delete/leave/participants) — the mounting
	// surface's own dialog host (useChatDialogHost) turns this into an open dialog. Every "direct"
	// descriptor (markRead/mute-toggle) resolves fully in place below.
	onAction: (kind: ChatActionDialogKind, chat: Chat) => void
}

interface MenuFamily {
	Item: typeof DropdownMenuItem
	Separator: typeof DropdownMenuSeparator
}

// Visual grouping only (mirrors notes' SEPARATOR_BEFORE) — a rule before the lifecycle-ending entry
// (delete/leave).
const SEPARATOR_BEFORE = new Set<ChatActionDescriptor["id"]>(["delete", "leave"])

// Shared per-conversation action list, rendered by BOTH the sidebar row's right-click menu and the
// thread header's ⋮ trigger — one descriptor list (chatMenuActions), one mapping from descriptor to
// menu row, mirrors notes' NoteMenuEntries exactly.
function ChatMenuEntries({ chat, currentUserId, onAction, family }: ChatMenuContentProps & { family: MenuFamily }) {
	const { t } = useTranslation(["chats", "common"])
	const isOnline = useIsOnline()
	const blocked = useBlockedUsers(false)
	const unread = chatHasUnread(chat, currentUserId, blocked)
	const descriptors = applyOfflineGate(chatMenuActions(chat, currentUserId, unread), isOnline)
	const { Item, Separator } = family

	async function runDirect(descriptor: Extract<ChatActionDescriptor, { run: "direct" }>): Promise<void> {
		switch (descriptor.id) {
			case "markRead": {
				const outcome = await markChatRead(chat)

				if (outcome.status === "error") {
					toast.error(errorLabel(outcome.dto))
				}

				return
			}
			case "mute": {
				const outcome = await setChatMuted(chat, !chat.muted)

				if (outcome.status === "error") {
					toast.error(errorLabel(outcome.dto))
				}

				return
			}
		}
	}

	function renderDescriptor(descriptor: ChatActionDescriptor, index: number) {
		const separator = index > 0 && SEPARATOR_BEFORE.has(descriptor.id) ? <Separator /> : null

		return (
			<Fragment key={descriptor.id}>
				{separator}
				<Item
					variant={descriptor.destructive ? "destructive" : "default"}
					disabled={descriptor.enabled === false}
					title={descriptor.enabled === false && !isOnline ? t("common:offlineActionDisabled") : undefined}
					onClick={event => {
						// Stop propagation — the portaled popup's synthetic events still bubble through the
						// REACT tree even though the DOM node lives elsewhere (same rationale as noteMenu.tsx),
						// so without this a row click would also select the conversation underneath.
						event.stopPropagation()

						if (descriptor.run === "direct") {
							void runDirect(descriptor)
							return
						}

						onAction(descriptor.dialogKind, chat)
					}}
				>
					{createElement(descriptor.icon, { "aria-hidden": true })}
					{t(descriptor.labelKey)}
				</Item>
			</Fragment>
		)
	}

	return <>{descriptors.map((descriptor, index) => renderDescriptor(descriptor, index))}</>
}

// Right-click surface — rendered inside a per-row <ContextMenu> (chatsSidebar.tsx's row wrapper).
export function ChatContextMenuContent(props: ChatMenuContentProps) {
	return (
		<ContextMenuContent>
			<ChatMenuEntries
				{...props}
				family={{ Item: ContextMenuItem, Separator: ContextMenuSeparator }}
			/>
		</ContextMenuContent>
	)
}

// ⋯ trigger surface — rendered inside a <DropdownMenu> (a row's own trigger button, or the thread
// header's ⋮ button, messageThread.tsx).
export function ChatDropdownMenuContent(props: ChatMenuContentProps) {
	return (
		<DropdownMenuContent align="end">
			<ChatMenuEntries
				{...props}
				family={{ Item: DropdownMenuItem, Separator: DropdownMenuSeparator }}
			/>
		</DropdownMenuContent>
	)
}
