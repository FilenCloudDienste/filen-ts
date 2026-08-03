import { type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { PanelLeftIcon } from "lucide-react"
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer"
import { cn } from "@/lib/utils"

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
export function SidebarDrawer({
	open,
	narrow,
	label,
	panel,
	children,
	onOpenChange
}: {
	open: boolean
	narrow: boolean
	label: string
	panel: ReactNode
	children: ReactNode
	onOpenChange: (open: boolean) => void
}) {
	return (
		<DrawerPrimitive.Root
			open={open}
			swipeDirection="left"
			onOpenChange={onOpenChange}
		>
			{children}
			{narrow ? (
				<DrawerPrimitive.Portal keepMounted={true}>
					<DrawerPrimitive.Backdrop className="fixed inset-0 isolate z-50 bg-black/30 duration-100 supports-backdrop-filter:backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
					<DrawerPrimitive.Viewport className="fixed inset-0 z-50 flex">
						{/* aria-label rather than a Drawer.Title: each panel already renders its own <h2>, and the
						    popup merges consumer props last so this wins as the accessible name. */}
						<DrawerPrimitive.Popup
							aria-label={label}
							className="m-2 flex max-w-[85vw] duration-100 outline-none data-open:animate-in data-open:slide-in-from-left data-closed:animate-out data-closed:slide-out-to-left"
						>
							{panel}
						</DrawerPrimitive.Popup>
					</DrawerPrimitive.Viewport>
				</DrawerPrimitive.Portal>
			) : null}
		</DrawerPrimitive.Root>
	)
}

// The drawer's ONE trigger, rendered by IconRail inside SidebarDrawer's own subtree so it reaches the
// drawer through Base UI's context (no detached handle needed). `md:hidden` rather than a second
// useIsNarrowViewport consumer: display:none also removes it from the tab order, so the desktop rail is
// unchanged in both pixels and keyboard order.
export function SidebarDrawerTrigger({ className }: { className?: string }) {
	const { t } = useTranslation("common")

	return (
		<DrawerPrimitive.Trigger
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
