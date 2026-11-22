import type { ReactNode } from "react"
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer"
import { cn } from "@filen/shared"
import { SCRIM_CLASS } from "@/components/ui/surface"

// A right-hand side panel's floating surface, the same as the left sidebars' (rounded-xl, --shell-border outline,
// bg-sidebar): the assistant, the chat info panel and the note participants panel. Rendered as an <aside> labelled by its heading, a
// complementary landmark and deliberately NOT a dialog, because an open role="dialog" makes isAnyDialogOpen
// (lib/keymap/dialogGuard.ts) stand down every shortcut in the app.
export const SIDE_PANEL_SURFACE_CLASS =
	"flex min-h-0 flex-col overflow-hidden rounded-xl border border-shell-border bg-sidebar outline-none"

// A side panel below its inline breakpoint: a drawer from the right, mirroring the module sidebar's drawer
// (sidebarDrawer.tsx). Base UI carries the focus trap, scroll lock, Escape/outside-press dismissal and swipe-to-dismiss.
// The modal drawer IS a dialog, so shortcuts stand down while it covers the page. The root wraps nothing but its own
// portal, for the same nesting reason as sidebarDrawer.tsx. Callers mount it only below their breakpoint and close it
// when the window crosses it: a root outliving the crossing waits forever for the exit animation of the portal the
// widening dropped, so the closed drawer would come back stuck on screen once the window narrows again.
export function SidePanelDrawer({
	open,
	onOpenChange,
	label,
	initialFocus,
	className,
	children
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	label: string
	// Where focus lands on open; `true` is Base UI's default, the first tabbable control.
	initialFocus: () => HTMLElement | true
	// The popup's width.
	className: string
	children: ReactNode
}) {
	return (
		<DrawerPrimitive.Root
			open={open}
			swipeDirection="right"
			onOpenChange={onOpenChange}
		>
			<DrawerPrimitive.Portal>
				<DrawerPrimitive.Backdrop className={SCRIM_CLASS} />
				{/* Desktop: the right-docked panel starts below the Windows/Linux window-controls band. */}
				<DrawerPrimitive.Viewport className="fixed inset-0 z-50 flex justify-end pt-(--window-inset-top) app-region-no-drag">
					<DrawerPrimitive.Popup
						aria-label={label}
						initialFocus={initialFocus}
						className={cn(
							"m-2 flex max-w-[calc(100vw-1rem)] duration-100 outline-none data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right",
							className
						)}
					>
						{children}
					</DrawerPrimitive.Popup>
				</DrawerPrimitive.Viewport>
			</DrawerPrimitive.Portal>
		</DrawerPrimitive.Root>
	)
}
