import { createElement, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import type { MessageActionsHandle } from "@/features/chats/components/thread/useMessageActions"
import type { MessageActionDescriptor } from "@/features/chats/components/thread/messageMenu.logic"
import { ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu"
import { DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"

// One descriptor → one menu row, shared by the right-click context menu and the ⋯-overflow dropdown. The
// `Item` param is typed against DropdownMenuItem but ContextMenuItem is structurally assignable to it
// (same trick as chatMenu.tsx's MenuFamily) — so both families render the identical rows without any
// per-family duplication. Same propagation stop as chatMenu.tsx (the portaled popup's synthetic click
// still bubbles through the React tree into the row underneath without it).
function renderMenuItems(
	descriptors: MessageActionDescriptor[],
	runAction: (descriptor: MessageActionDescriptor) => void,
	Item: typeof DropdownMenuItem,
	t: TFunction<["chats", "common"]>
): ReactNode[] {
	return descriptors.map(descriptor => (
		<Item
			key={descriptor.id}
			variant={descriptor.id === "delete" || descriptor.id === "remove" || descriptor.id === "block" ? "destructive" : "default"}
			disabled={descriptor.enabled === false}
			// `enabled === false` can only come from the offline gate here, so the title needs no
			// separate online check (unlike chatMenu.tsx's).
			title={descriptor.enabled === false ? t("common:offlineActionDisabled") : undefined}
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
// Returns null (no popup) when the message has no applicable actions. Takes the row's useMessageActions
// result rather than calling the hook: this body renders even while the menu is closed.
export function MessageContextMenuContent({ descriptors, runAction }: MessageActionsHandle) {
	const { t } = useTranslation(["chats", "common"])

	if (descriptors.length === 0) {
		return null
	}

	return <ContextMenuContent>{renderMenuItems(descriptors, runAction, ContextMenuItem, t)}</ContextMenuContent>
}

// ⋯-overflow surface — rendered inside a <DropdownMenu> mounted by the hover action bar's overflow
// trigger (messageActionBar.tsx). Left-click-opened, so it uses the dropdown family; the descriptor list
// + dispatch are the row's one useMessageActions result, the same one the right-click menu above gets.
export function MessageDropdownMenuContent({ descriptors, runAction }: MessageActionsHandle) {
	const { t } = useTranslation(["chats", "common"])

	if (descriptors.length === 0) {
		return null
	}

	return <DropdownMenuContent align="end">{renderMenuItems(descriptors, runAction, DropdownMenuItem, t)}</DropdownMenuContent>
}
