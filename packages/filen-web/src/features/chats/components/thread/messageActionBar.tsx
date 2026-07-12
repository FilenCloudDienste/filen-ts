import { createElement } from "react"
import { useTranslation } from "react-i18next"
import { MoreHorizontalIcon } from "lucide-react"
import { useMessageActions } from "@/features/chats/components/thread/useMessageActions"
import { MessageDropdownMenuContent, type MessageMenuContentProps } from "@/features/chats/components/thread/messageMenu"
import { inlinePrimaryActions } from "@/features/chats/components/thread/messageActionBar.logic"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"

// Floating hover action bar pinned to a row's top-right (Discord placement) — a SECOND renderer of the
// same useMessageActions descriptor list the right-click menu uses, as inline icon buttons plus a ⋯
// overflow that opens the identical full menu (MessageDropdownMenuContent). Visible on the row's
// group-hover / focus-within (the parent row owns the `group` + `focus-within` class); at rest it is
// opacity-0 and pointer-events-none so it never intercepts clicks on the message beneath it. No new
// action wiring — this is a presentation of the existing model, not a new one. NO reactions feature
// (the app has no reaction backend on any platform); the react-slot surfaces Reply as the primary
// action instead.
export function MessageActionBar(props: MessageMenuContentProps) {
	const { t } = useTranslation("chats")
	// Passive blocked read (warmBlocked: false) — the always-mounted bar never fires a per-row request
	// just to sit idle; its inline actions (reply/copy/edit/retry) never need the blocked set, and the ⋯
	// overflow warms it itself on open (MessageDropdownMenuContent).
	const { descriptors, runAction } = useMessageActions({ ...props, warmBlocked: false })

	if (descriptors.length === 0) {
		return null
	}

	const inline = inlinePrimaryActions(descriptors)

	return (
		<div
			role="toolbar"
			aria-label={t("chatMessageActionsLabel")}
			className="pointer-events-none absolute -top-3.5 right-3 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-popover p-0.5 opacity-0 shadow-sm transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
		>
			{inline.map(descriptor => (
				<Button
					key={descriptor.id}
					variant="ghost"
					size="icon-xs"
					aria-label={t(descriptor.labelKey)}
					title={t(descriptor.labelKey)}
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
							onClick={event => {
								event.stopPropagation()
							}}
						>
							<MoreHorizontalIcon />
						</Button>
					}
				/>
				<MessageDropdownMenuContent {...props} />
			</DropdownMenu>
		</div>
	)
}
