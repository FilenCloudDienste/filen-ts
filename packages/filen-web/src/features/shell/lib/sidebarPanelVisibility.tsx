/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, type ReactNode } from "react"

// Whether the contextual sidebar panel is actually on screen. Below the layout breakpoint the shell
// relocates the panel into a drawer that stays MOUNTED behind `display:none` while closed (see
// sidebarDrawer.tsx — the mount has to survive so the panel keeps its search text, selection and scroll),
// which leaves everything it registers at document level — its keyboard actions above all — live on a
// surface nobody can see. Panels read this to disable those instead: a selection made through an
// invisible bulk bar is a selection the user cannot undo or even observe.
//
// The open drawer cannot be detected through the shared dialog guard (it registers AS a dialog), so the
// shell publishes the answer it already owns.
const SidebarPanelVisibleContext = createContext(true)

export function SidebarPanelVisibilityProvider({ visible, children }: { visible: boolean; children: ReactNode }) {
	return <SidebarPanelVisibleContext value={visible}>{children}</SidebarPanelVisibleContext>
}

// True when no provider is present: every surface outside the shell's drawer relocation (and every test)
// renders its panel plainly visible.
export function useIsSidebarPanelVisible(): boolean {
	return useContext(SidebarPanelVisibleContext)
}
