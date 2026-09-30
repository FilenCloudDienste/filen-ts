import { createElement } from "react"
import { useTranslation } from "react-i18next"
import { MoreHorizontalIcon } from "lucide-react"
import type { MessageActionsHandle } from "@/features/chats/components/thread/useMessageActions"
import { MessageDropdownMenuContent } from "@/features/chats/components/thread/messageMenu"
import { inlinePrimaryActions } from "@/features/chats/components/thread/messageActionBar.logic"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { stopRowPropagation } from "@/lib/domEvents"

// Hover action bar floating beside a bubble on its inner side (messageRow.tsx positions it) — a SECOND
// renderer of the row's one useMessageActions result the right-click menu also gets, as inline icon
// buttons plus a ⋯ overflow that opens the identical full menu (MessageDropdownMenuContent). Visible on
// the bubble column's group-hover / focus-within (that column owns the `group` class); at rest it is
// opacity-0 and pointer-events-none so it never intercepts clicks on the rows around it. No new action
// wiring — this is a presentation of the existing model, not a new one. NO reactions feature (the app has
// no reaction backend on any platform); the first slot surfaces Reply as the primary action instead.
export function MessageActionBar({ descriptors, runAction }: MessageActionsHandle) {
	const { t } = useTranslation(["chats", "common"])

	if (descriptors.length === 0) {
		return null
	}

	const inline = inlinePrimaryActions(descriptors)

	return (
		<div
			role="toolbar"
			aria-label={t("chatMessageActionsLabel")}
			className="pointer-events-none flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-popover p-0.5 opacity-0 shadow-sm transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
		>
			{inline.map(descriptor => (
				<Button
					key={descriptor.id}
					variant="ghost"
					size="icon-xs"
					disabled={descriptor.enabled === false}
					aria-label={t(descriptor.labelKey)}
					title={descriptor.enabled === false ? t("common:offlineActionDisabled") : t(descriptor.labelKey)}
					onClick={event => {
						event.stopPropagation()
						runAction(descriptor)
					}}
				>
					{createElement(descriptor.icon, { "aria-hidden": true })}
				</Button>
			))}
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label={t("chatMessageMoreActions")}
							onClick={stopRowPropagation}
						>
							<MoreHorizontalIcon />
						</Button>
					}
				/>
				<MessageDropdownMenuContent
					descriptors={descriptors}
					runAction={runAction}
				/>
			</DropdownMenu>
		</div>
	)
}
