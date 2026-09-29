import { Fragment, type ReactNode } from "react"
import { useResizableSidebar } from "@/features/shell/hooks/useResizableSidebar"
import { SidebarResizeHandle } from "@/features/shell/components/sidebarResizeHandle"
import { type SidebarModule } from "@/features/shell/lib/sidebarWidth"

// Drag region (Electron plumbing): inert in a plain browser, opted back out by every interactive
// descendant via app-region-no-drag. Visibility is the shell's call, never the panel's — see
// appShell.tsx.
const PANEL_CLASS = "flex max-w-full shrink-0 flex-col rounded-xl bg-sidebar app-region-drag"
const FIXED_PANEL_CLASS = "flex w-52 max-w-full shrink-0 flex-col rounded-xl bg-sidebar app-region-drag"

export function SidebarPanel({ children }: { children: ReactNode }) {
	return <aside className={FIXED_PANEL_CLASS}>{children}</aside>
}

// User-resizable width, persisted per module. max-w-full clamps a wide persisted width to whatever host
// the panel lands in (the shell row, or the narrow-viewport drawer). The handle stays a sibling of the
// aside: it is positioned against the shell's sidebar wrapper. Owning the hook here keeps drag re-renders
// out of the sidebar body.
export function ResizableSidebarPanel({
	module,
	resizeLabel,
	children
}: {
	module: SidebarModule
	resizeLabel: string
	children: ReactNode
}) {
	const resize = useResizableSidebar(module)

	return (
		<Fragment>
			<aside
				className={PANEL_CLASS}
				style={{ width: resize.width }}
			>
				{children}
			</aside>
			<SidebarResizeHandle
				ariaLabel={resizeLabel}
				handle={resize}
			/>
		</Fragment>
	)
}
