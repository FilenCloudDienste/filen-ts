import { createElement } from "react"
import { useTranslation } from "react-i18next"
import { XIcon } from "lucide-react"
import type { Chat } from "@filen/sdk-rs"
import { type BulkOutcome } from "@/features/drive/lib/bulk"
import { aggregateChatSelectionFlags } from "@/features/chats/lib/selectionFlags"
import { markChatsRead, setChatsMuted } from "@/features/chats/lib/bulk"
import { toastChatsBulkOutcome } from "@/features/chats/lib/bulkToast"
import { useChatsSelectionStore } from "@/features/chats/store/useChatsSelectionStore"
import {
	chatBulkActions,
	type ChatBulkActionDescriptor,
	type ChatBulkDialogActionKind
} from "@/features/chats/components/chatsBulkActionBar.logic"
import { Kbd } from "@/lib/keymap/kbd"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export type { ChatBulkDialogActionKind }

export interface ChatsBulkActionBarProps {
	// The LIVE (ghost-purged) selection — chatsSidebar.tsx re-derives this from the current chats query
	// every render, so a conversation removed from the account (elsewhere, or by another tab) between
	// selection and dispatch is never targeted.
	selectedChats: Chat[]
	currentUserId: bigint | undefined
	onDialogAction: (kind: ChatBulkDialogActionKind, chats: Chat[]) => void
}

// Bottom-anchored floating selection bar (chatsSidebar.tsx overlays it on the scrollable list while a
// 2+ selection exists) — mirrors features/notes/components/notesBulkActionBar.tsx, sized down: chats
// have no submenu-driven bulk action, so every descriptor renders as a single tooltip'd icon button.
export function ChatsBulkActionBar({ selectedChats, currentUserId, onDialogAction }: ChatsBulkActionBarProps) {
	const { t } = useTranslation(["chats", "common"])
	const flags = aggregateChatSelectionFlags(selectedChats, currentUserId)
	const descriptors = chatBulkActions(flags)

	async function runOutcome(pending: Promise<BulkOutcome<Chat>>): Promise<void> {
		const outcome = await pending

		toastChatsBulkOutcome(outcome)
		// Mirrors the dialog-routed bulk actions' own cleanup — a succeeded chat is pruned from the
		// selection, a failed one stays selected so the user can retry.
		useChatsSelectionStore.getState().removeFromSelection(outcome.succeeded.map(chat => chat.uuid))
	}

	function runDescriptor(descriptor: Extract<ChatBulkActionDescriptor, { run: "direct" }>): void {
		switch (descriptor.id) {
			case "markRead":
				void runOutcome(markChatsRead(selectedChats))
				return
			case "mute":
				void runOutcome(setChatsMuted(selectedChats, !flags.includesMuted))
				return
		}
	}

	return (
		<div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-popover px-3 py-2 text-popover-foreground shadow-lg">
			<div className="flex items-center gap-2">
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={t("chatsCommandClearSelection")}
								onClick={() => {
									useChatsSelectionStore.getState().clearSelectedChats()
								}}
							>
								<XIcon />
							</Button>
						}
					/>
					<TooltipContent>
						{t("chatsCommandClearSelection")}
						<Kbd action="chats.clearSelection" />
					</TooltipContent>
				</Tooltip>
				<p className="text-sm text-muted-foreground">{t("chatsSelectionCount", { count: selectedChats.length })}</p>
			</div>
			<div className="flex items-center gap-2">
				{descriptors.map(descriptor => {
					if (descriptor.run === "dialog") {
						return (
							<Tooltip key={descriptor.id}>
								<TooltipTrigger
									render={
										<Button
											variant={descriptor.destructive ? "destructive" : "outline"}
											size="icon-sm"
											aria-label={t(descriptor.labelKey)}
											onClick={() => {
												onDialogAction(descriptor.dialogKind, selectedChats)
											}}
										>
											{createElement(descriptor.icon, { "aria-hidden": true })}
										</Button>
									}
								/>
								<TooltipContent>{t(descriptor.labelKey)}</TooltipContent>
							</Tooltip>
						)
					}

					return (
						<Tooltip key={descriptor.id}>
							<TooltipTrigger
								render={
									<Button
										variant="outline"
										size="icon-sm"
										aria-label={t(descriptor.labelKey)}
										onClick={() => {
											runDescriptor(descriptor)
										}}
									>
										{createElement(descriptor.icon, { "aria-hidden": true })}
									</Button>
								}
							/>
							<TooltipContent>{t(descriptor.labelKey)}</TooltipContent>
						</Tooltip>
					)
				})}
			</div>
		</div>
	)
}
