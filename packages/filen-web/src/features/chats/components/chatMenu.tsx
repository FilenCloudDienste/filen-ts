import { createElement, Fragment } from "react"
import { useTranslation } from "react-i18next"
import type { Chat } from "@filen/sdk-rs"
import { runOutcomeActivity } from "@/lib/activity/activity"
import { setChatMuted, markChatRead } from "@/features/chats/lib/actions"
import { CHATS_MARK_READ, chatActivityName, setMutedKeys } from "@/features/chats/lib/activity"
import { chatHasUnread } from "@/features/chats/lib/unread.logic"
import { chatMessagesQueryGet } from "@/features/chats/queries/chatMessages"
import type { BlockedUsers } from "@filen/shared"
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
	// Threaded from the mounting surface's own enabled read (chatsSidebar / messageThread) so the whole
	// feature works off one blocked set rather than a per-menu observer.
	blocked: BlockedUsers
	// Fires for every "dialog"-run descriptor (rename/delete/leave/participants) — the mounting
	// surface's own dialog host (useChatDialogHost) turns this into an open dialog. Every "direct"
	// descriptor (markRead/mute-toggle) runs in place below as an activity toast.
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
function ChatMenuEntries({ chat, currentUserId, blocked, onAction, family }: ChatMenuContentProps & { family: MenuFamily }) {
	const { t } = useTranslation(["chats", "common"])
	const isOnline = useIsOnline()
	const unread = chatHasUnread(chat, currentUserId, blocked, chatMessagesQueryGet)
	const descriptors = applyOfflineGate(chatMenuActions(chat, currentUserId, unread), isOnline)
	const { Item, Separator } = family

	function runDirect(descriptor: Extract<ChatActionDescriptor, { run: "direct" }>): void {
		switch (descriptor.id) {
			case "markRead":
				void runOutcomeActivity(chat, { keys: CHATS_MARK_READ, name: chatActivityName, run: markChatRead })
				return
			case "mute": {
				const mute = !chat.muted

				void runOutcomeActivity(chat, {
					keys: setMutedKeys(mute),
					name: chatActivityName,
					run: target => setChatMuted(target, mute)
				})
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
					onClick={() => {
						if (descriptor.run === "direct") {
							runDirect(descriptor)
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
