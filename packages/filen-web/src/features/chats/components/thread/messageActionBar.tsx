import { createElement, useRef, useState, type ReactElement, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { MoreHorizontalIcon } from "lucide-react"
import type { MessageActionsHandle } from "@/features/chats/components/thread/useMessageActions"
import { MessageDropdownMenuContent } from "@/features/chats/components/thread/messageMenu"
import {
	inlinePrimaryActions,
	INLINE_ACTION_KEYMAP_IDS,
	MORE_ACTIONS_KEYMAP_ID
} from "@/features/chats/components/thread/messageActionBar.logic"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip"
import { RowTooltipContent } from "@/components/lazyTooltip"
import { Kbd } from "@/lib/keymap/kbd"
import { stopRowPropagation } from "@/lib/domEvents"

// The button's tooltip, or the bare button while the bar's tooltips are off.
function BarTooltip({
	enabled,
	label,
	shortcut,
	children
}: {
	enabled: boolean
	label: string
	shortcut: ReactNode
	children: ReactElement
}) {
	if (!enabled) {
		return children
	}

	return (
		<Tooltip>
			<TooltipTrigger render={children} />
			<RowTooltipContent>
				{label}
				{shortcut}
			</RowTooltipContent>
		</Tooltip>
	)
}

// Hover action bar floating over a message row's top-right corner (messageRow.tsx positions it) — a SECOND
// renderer of the row's one useMessageActions result the right-click menu also gets, as inline icon
// buttons plus a ⋯ overflow that opens the identical full menu (MessageDropdownMenuContent). Visible on
// the row's group-hover / focus-within (the row owns the `group` class); at rest it is
// opacity-0 and pointer-events-none so it never intercepts clicks on the rows around it. No new action
// wiring — this is a presentation of the existing model, not a new one. NO reactions feature (the app has
// no reaction backend on any platform); the first slot surfaces Reply as the primary action instead. A pointer
// affordance: its buttons take no Tab stop, as the thread's one is the focused message, whose keys and Shift+F10 menu
// reach the same actions (messageThread.tsx).
//
// Every button has a tooltip naming it and its message key. The bar is mounted on every row, so its tooltips are created
// when a mouse enters it and dropped when it leaves: entering swaps each button for its tooltip trigger before the
// pointer can click, and an open ⋯ menu holds them until it closes, so its trigger is never remounted under it. Touch and
// pen never switch them on: a tap's pointerenter would remount the button it is pressing.
//
// Its ⋯ menu's open state is the row's, which also opens it on a touch long-press (messageRow.tsx).
export function MessageActionBar({
	descriptors,
	runAction,
	menuOpen,
	onMenuOpenChange
}: MessageActionsHandle & { menuOpen: boolean; onMenuOpenChange: (open: boolean) => void }) {
	const { t } = useTranslation(["chats", "common"])
	const toolbarRef = useRef<HTMLDivElement | null>(null)
	// Switched on by the pointer only: the menu opening never swaps the trigger it is opening from.
	const [tooltips, setTooltips] = useState(false)

	if (descriptors.length === 0) {
		return null
	}

	const inline = inlinePrimaryActions(descriptors)

	return (
		<div
			role="toolbar"
			aria-label={t("chatMessageActionsLabel")}
			ref={toolbarRef}
			onPointerEnter={event => {
				if (event.pointerType === "mouse") {
					setTooltips(true)
				}
			}}
			onPointerLeave={() => {
				if (!menuOpen) {
					setTooltips(false)
				}
			}}
			// Held visible while its ⋯ menu is open (the trigger's data-popup-open), as the row holds its highlight.
			className="pointer-events-none flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-popover p-0.5 opacity-0 shadow-sm transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 has-[[data-popup-open]]:pointer-events-auto has-[[data-popup-open]]:opacity-100"
		>
			{inline.map(descriptor => {
				const label = t(descriptor.labelKey)
				const keymapId = INLINE_ACTION_KEYMAP_IDS[descriptor.id]
				// A disabled button gets no styled tooltip (it never opens over one); its title says why.
				const disabled = descriptor.enabled === false

				return (
					<BarTooltip
						key={descriptor.id}
						enabled={tooltips && !disabled}
						label={label}
						shortcut={keymapId === undefined ? null : <Kbd action={keymapId} />}
					>
						<Button
							variant="ghost"
							size="icon-xs"
							tabIndex={-1}
							disabled={disabled}
							aria-label={label}
							title={disabled ? t("common:offlineActionDisabled") : undefined}
							onClick={event => {
								event.stopPropagation()
								runAction(descriptor)
							}}
						>
							{createElement(descriptor.icon, { "aria-hidden": true })}
						</Button>
					</BarTooltip>
				)
			})}
			<DropdownMenu
				open={menuOpen}
				onOpenChange={open => {
					onMenuOpenChange(open)

					// The pointer may have left the bar for the menu and then the menu itself, which fires no pointerleave on
					// the bar: whether it is still over the bar is read from the hover state the moment the menu closes.
					if (!open && toolbarRef.current?.matches(":hover") !== true) {
						setTooltips(false)
					}
				}}
			>
				<BarTooltip
					enabled={tooltips}
					label={t("chatMessageMoreActions")}
					shortcut={<Kbd action={MORE_ACTIONS_KEYMAP_ID} />}
				>
					<DropdownMenuTrigger
						render={
							<Button
								variant="ghost"
								size="icon-xs"
								tabIndex={-1}
								aria-label={t("chatMessageMoreActions")}
								onClick={stopRowPropagation}
							>
								<MoreHorizontalIcon />
							</Button>
						}
					/>
				</BarTooltip>
				<MessageDropdownMenuContent
					descriptors={descriptors}
					runAction={runAction}
				/>
			</DropdownMenu>
		</div>
	)
}
