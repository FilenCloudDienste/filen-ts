import { type ReactNode } from "react"
import { flushSync } from "react-dom"
import { useTranslation } from "react-i18next"
import { PanelLeftIcon } from "lucide-react"
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer"
import { cn } from "@filen/shared"
import { SCRIM_CLASS } from "@/components/ui/surface"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SIDEBAR_DRAWER_ID } from "@/features/shell/lib/appShell.logic"
import { setSidebarHidden, useSidebarHidden } from "@/features/shell/lib/sidebarHidden"
import { focusPane } from "@/features/shell/lib/paneCycle"
import { Kbd } from "@/lib/keymap/kbd"

// Below the layout breakpoint the module sidebar moves out of the shell row into this drawer — the
// SAME element, mounted once (see appShell.tsx: never both, or the notes/chats sidebars' virtualizers,
// list queries and keymap registrations would double up) and mounted CONTINUOUSLY: `keepMounted` keeps
// the panel alive behind `display:none` while the drawer is closed, because the drawer closes on every
// navigation and a drawer-lifetime mount would wipe the panel's search text, selection and list scroll
// on every tap and would leave its mount-time queries (the sidebars' useBlockedUsers warm-up) never
// running. Base UI's shipped drawer primitive carries the focus trap, scroll lock, Escape/outside-press
// dismissal and swipe-to-dismiss; none of that is re-implemented here. Geometry deliberately reuses the
// shell's own floating-panel language: inset by the row's own p-2, and the panel keeps its own
// rounded-xl bg-sidebar surface, so opening the drawer looks like the desktop sidebar sliding in rather
// than a foreign sheet.
//
// The root wraps nothing but its own portal; the rail's trigger reaches it through a detached handle.
// Base UI treats any Dialog/AlertDialog/Drawer root rendered inside another as nested, so a root wrapping
// the shell would make every dialog the app opens a child of the drawer. The root exists only below the
// breakpoint: widening closes the drawer in the render that drops its portal, and a root outliving it
// waits forever for that exit animation, so the closed drawer would come back stuck on screen once the
// window narrows again. The handle re-attaches on remount, so the trigger needs nothing.
const sidebarDrawerHandle = DrawerPrimitive.createHandle()

export function SidebarDrawer({
	open,
	narrow,
	label,
	panel,
	onOpenChange
}: {
	open: boolean
	narrow: boolean
	label: string
	panel: ReactNode
	onOpenChange: (open: boolean) => void
}) {
	if (!narrow) {
		return null
	}

	return (
		<DrawerPrimitive.Root
			open={open}
			handle={sidebarDrawerHandle}
			swipeDirection="left"
			onOpenChange={onOpenChange}
		>
			<DrawerPrimitive.Portal keepMounted={true}>
				<DrawerPrimitive.Backdrop className={SCRIM_CLASS} />
				{/* Desktop: the panel starts below the macOS traffic lights or the Windows/Linux controls band. */}
				<DrawerPrimitive.Viewport className="fixed inset-0 z-50 flex pt-(--window-inset-corner) app-region-no-drag">
					{/* aria-label rather than a Drawer.Title: each panel already renders its own <h2>, and the
					    popup merges consumer props last so this wins as the accessible name. */}
					<DrawerPrimitive.Popup
						id={SIDEBAR_DRAWER_ID}
						aria-label={label}
						className="m-2 flex max-w-[85vw] duration-100 outline-none data-open:animate-in data-open:slide-in-from-left data-closed:animate-out data-closed:slide-out-to-left"
					>
						{panel}
					</DrawerPrimitive.Popup>
				</DrawerPrimitive.Viewport>
			</DrawerPrimitive.Portal>
		</DrawerPrimitive.Root>
	)
}

// The drawer's ONE trigger, rendered by IconRail outside SidebarDrawer's subtree and bound to it through
// sidebarDrawerHandle. `md:hidden` rather than a second useIsNarrowViewport consumer: display:none also
// removes it from the tab order, so the desktop rail is unchanged in both pixels and keyboard order.
export function SidebarDrawerTrigger({ className }: { className?: string }) {
	const { t } = useTranslation("common")

	return (
		<DrawerPrimitive.Trigger
			handle={sidebarDrawerHandle}
			render={
				<button
					type="button"
					aria-label={t("openNavigation")}
					className={cn(className, "md:hidden")}
				>
					<PanelLeftIcon />
				</button>
			}
		/>
	)
}

// The same "Open navigation" slot above the breakpoint, while app.toggleSidebar has hidden the sidebar there: it shows
// the sidebar again and moves focus into it (the button itself goes with the click). `max-md:hidden` leaves the narrow
// layout to the drawer's trigger.
export function SidebarRevealButton({ className }: { className?: string }) {
	const { t } = useTranslation("common")
	const hidden = useSidebarHidden()

	if (!hidden) {
		return null
	}

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						aria-label={t("openNavigation")}
						className={cn(className, "max-md:hidden")}
						onClick={() => {
							flushSync(() => {
								setSidebarHidden(false)
							})
							focusPane("sidebar")
						}}
					>
						<PanelLeftIcon />
					</button>
				}
			/>
			<TooltipContent side="right">
				{t("openNavigation")}
				<Kbd action="app.toggleSidebar" />
			</TooltipContent>
		</Tooltip>
	)
}
