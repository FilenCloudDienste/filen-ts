import { useTranslation } from "react-i18next"
import type { Chat } from "@filen/sdk-rs"
import { aggregateChatSelectionFlags } from "@/features/chats/lib/selectionFlags"
import { chatMessagesQueryGet } from "@/features/chats/queries/chatMessages"
import type { BlockedUsers } from "@filen/shared"
import { markChatsRead, setChatsMuted } from "@/features/chats/lib/bulk"
import { CHATS_MARK_READ, chatsActivity, setMutedKeys } from "@/features/chats/lib/activity"
import { runBulkActivity } from "@/lib/activity/activity"
import { useChatsSelectionStore } from "@/features/chats/store/useChatsSelectionStore"
import {
	chatBulkActions,
	isChatBulkActionOfflineDisabled,
	type ChatBulkActionDescriptor,
	type ChatBulkDialogActionKind
} from "@/features/chats/components/chatsBulkActionBar.logic"
import { useIsOnline } from "@/lib/useIsOnline"
import { BulkActionButton, SelectionActionBar } from "@/components/selectionActionBar"

export type { ChatBulkDialogActionKind }

export interface ChatsBulkActionBarProps {
	// The LIVE (ghost-purged) selection — chatsSidebar.tsx re-derives this from the current chats query
	// every render, so a conversation removed from the account (elsewhere, or by another tab) between
	// selection and dispatch is never targeted.
	selectedChats: Chat[]
	currentUserId: bigint | undefined
	// From the sidebar's single enabled read — the bar opens no observer of its own.
	blocked: BlockedUsers
	onDialogAction: (kind: ChatBulkDialogActionKind, chats: Chat[]) => void
}

// Bottom-anchored floating selection bar (chatsSidebar.tsx overlays it on the scrollable list while a
// 2+ selection exists) — mirrors features/notes/components/notesBulkActionBar.tsx, sized down: chats
// have no submenu-driven bulk action, so every descriptor renders as a plain BulkActionButton.
export function ChatsBulkActionBar({ selectedChats, currentUserId, blocked, onDialogAction }: ChatsBulkActionBarProps) {
	const { t } = useTranslation(["chats", "common"])
	const isOnline = useIsOnline()
	const flags = aggregateChatSelectionFlags(selectedChats, currentUserId, blocked, chatMessagesQueryGet)
	const descriptors = chatBulkActions(flags)

	function runDescriptor(descriptor: Extract<ChatBulkActionDescriptor, { run: "direct" }>): void {
		switch (descriptor.id) {
			case "markRead":
				void runBulkActivity(chatsActivity(selectedChats, CHATS_MARK_READ, markChatsRead))
				return
			case "mute": {
				const mute = !flags.includesMuted

				void runBulkActivity(
					chatsActivity(selectedChats, setMutedKeys(mute), (targets, onSettled) => setChatsMuted(targets, mute, onSettled))
				)
				return
			}
		}
	}

	return (
		<SelectionActionBar
			count={selectedChats.length}
			clearKbdAction="chats.clearSelection"
			onClear={() => {
				useChatsSelectionStore.getState().clearSelectedChats()
			}}
		>
			{descriptors.map(descriptor => {
				const offlineDisabled = isChatBulkActionOfflineDisabled(descriptor.id, isOnline)

				return (
					<BulkActionButton
						key={descriptor.id}
						icon={descriptor.icon}
						label={t(descriptor.labelKey)}
						destructive={descriptor.destructive}
						disabled={offlineDisabled}
						disabledReason={offlineDisabled ? t("common:offlineActionDisabled") : undefined}
						onClick={() => {
							if (descriptor.run === "dialog") {
								onDialogAction(descriptor.dialogKind, selectedChats)

								return
							}

							runDescriptor(descriptor)
						}}
					/>
				)
			})}
		</SelectionActionBar>
	)
}
