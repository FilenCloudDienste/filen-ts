import { createElement, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { useMessageActions, type UseMessageActionsArgs } from "@/features/chats/components/thread/useMessageActions"
import type { MessageActionDescriptor } from "@/features/chats/components/thread/messageMenu.logic"
import { ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu"
import { DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"

export type MessageMenuContentProps = Omit<UseMessageActionsArgs, "warmBlocked">

// One descriptor → one menu row, shared by the right-click context menu and the ⋯-overflow dropdown. The
// `Item` param is typed against DropdownMenuItem but ContextMenuItem is structurally assignable to it
// (same trick as chatMenu.tsx's MenuFamily) — so both families render the identical rows without any
// per-family duplication. Same propagation stop as chatMenu.tsx (the portaled popup's synthetic click
// still bubbles through the React tree into the row underneath without it).
function renderMenuItems(
	descriptors: MessageActionDescriptor[],
	runAction: (descriptor: MessageActionDescriptor) => void,
	Item: typeof DropdownMenuItem,
	t: TFunction<"chats">
): ReactNode[] {
	return descriptors.map(descriptor => (
		<Item
			key={descriptor.id}
			variant={descriptor.id === "delete" || descriptor.id === "remove" || descriptor.id === "block" ? "destructive" : "default"}
			onClick={event => {
				event.stopPropagation()
				runAction(descriptor)
			}}
		>
			{createElement(descriptor.icon, { "aria-hidden": true })}
			{t(descriptor.labelKey)}
		</Item>
	))
}

// Right-click surface for one message row — rendered inside a per-row <ContextMenu> (messageRow.tsx).
// Warms the blocked set (a right-click is a deliberate interaction) so the "Block" entry correctly hides
// an already-blocked sender. Returns null (no popup) when the message has no applicable actions.
export function MessageContextMenuContent(props: MessageMenuContentProps) {
	const { t } = useTranslation("chats")
	const { descriptors, runAction } = useMessageActions({ ...props, warmBlocked: true })

	if (descriptors.length === 0) {
		return null
	}

	return <ContextMenuContent>{renderMenuItems(descriptors, runAction, ContextMenuItem, t)}</ContextMenuContent>
}

// ⋯-overflow surface — rendered inside a <DropdownMenu> mounted by the hover action bar's overflow
// trigger (messageActionBar.tsx). Left-click-opened, so it uses the dropdown family; the descriptor list
// + dispatch are the SAME useMessageActions as the right-click menu above (zero duplication).
export function MessageDropdownMenuContent(props: MessageMenuContentProps) {
	const { t } = useTranslation("chats")
	const { descriptors, runAction } = useMessageActions({ ...props, warmBlocked: true })

	if (descriptors.length === 0) {
		return null
	}

	return <DropdownMenuContent align="end">{renderMenuItems(descriptors, runAction, DropdownMenuItem, t)}</DropdownMenuContent>
}
