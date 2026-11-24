import { useEffect, type KeyboardEvent, type ReactNode, type Ref } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { XIcon } from "lucide-react"
import { cn } from "@filen/shared"
import type { SidePanelController } from "@/features/shell/lib/sidePanelStore"
import { subscribeToSidePanelBreakpoint, useIsSidePanelNarrow } from "@/features/shell/lib/sidePanelLayout"
import { useSidePanelSlot } from "@/features/shell/lib/sidePanelSlot"
import { SIDE_PANEL_SURFACE_CLASS, SidePanelDrawer } from "@/components/sidePanel"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"

// What the host hands the surface for where it is mounted.
export interface DockedSurfaceProps {
	className: string
	// The inline panel's ref callback (focus on open, toast clearance); the sheet has none.
	ref?: Ref<HTMLElement> | undefined
	onKeyDown?: ((event: KeyboardEvent<HTMLElement>) => void) | undefined
	onClose: () => void
}

// A docked side panel's <aside>: its heading, any header actions, and the close button, over the panel's own body.
// Focusable (tabIndex -1) so opening it can move focus to the panel itself.
export function SidePanelSurface({
	controller,
	itemKey,
	title,
	headerActions,
	className,
	ref,
	onKeyDown,
	onClose,
	children
}: DockedSurfaceProps & {
	controller: SidePanelController
	itemKey: string
	title: ReactNode
	headerActions?: ReactNode
	children: ReactNode
}) {
	const { t } = useTranslation("common")

	return (
		<aside
			id={controller.panelId}
			data-panel-key={itemKey}
			ref={ref}
			tabIndex={-1}
			aria-labelledby={controller.titleId}
			className={cn(SIDE_PANEL_SURFACE_CLASS, className)}
			onKeyDown={onKeyDown}
		>
			<header className="flex h-12 shrink-0 items-center gap-1 pr-2 pl-4">
				<h2
					id={controller.titleId}
					className="min-w-0 flex-1 truncate text-sm font-medium"
				>
					{title}
				</h2>
				{headerActions}
				<TooltipIconButton
					label={t("close")}
					onClick={onClose}
				>
					<XIcon />
				</TooltipIconButton>
			</header>
			{children}
		</aside>
	)
}

// From the side panel breakpoint up the panel is portalled into the shell's side-panel slot, beside the content card;
// below it the panel is a sheet from the right. Either mounts only while open. `renderSurface` renders the panel,
// keyed by the item, so its local state never carries over from one item to the next.
export function DockedSidePanel({
	controller,
	itemKey,
	label,
	renderSurface
}: {
	controller: SidePanelController
	itemKey: string
	// The sheet's accessible name.
	label: string
	renderSurface: (surface: DockedSurfaceProps) => ReactNode
}) {
	const narrow = useIsSidePanelNarrow()
	const slot = useSidePanelSlot()
	const open = controller.useOpen(itemKey, narrow)

	// The sheet survives neither a crossing of the breakpoint (it would reappear by itself the next time the window
	// narrows) nor the host leaving this item.
	useEffect(() => {
		const unsubscribe = subscribeToSidePanelBreakpoint(controller.closeDrawer)

		return () => {
			unsubscribe()

			if (controller.useStore.getState().drawerKey === itemKey) {
				controller.closeDrawer()
			}
		}
	}, [controller, itemKey])

	if (narrow) {
		return (
			<SidePanelDrawer
				open={open}
				onOpenChange={controller.setDrawerOpen}
				label={label}
				initialFocus={controller.drawerInitialFocus}
				className="w-80"
			>
				{renderSurface({ className: "w-full flex-1", onClose: controller.closeDrawer })}
			</SidePanelDrawer>
		)
	}

	if (!open || slot === null) {
		return null
	}

	return createPortal(
		renderSurface({
			ref: controller.attachInlinePanel,
			className: "w-80 shrink-0 app-region-pane",
			onKeyDown: controller.handleInlineKeyDown,
			onClose: controller.closeInlinePanel
		}),
		slot
	)
}
