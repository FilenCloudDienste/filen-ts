import { type, type Type } from "arktype"
import { kvPreference, type KvPreference } from "@/lib/storage/preference"
import { splitterKeyValue, type SplitterKeyBounds } from "@/lib/useSeparatorValue.logic"

// The contextual sidebars big enough to want more room than the fixed-width settings/contacts
// panels — each persists its own width independently, same per-module split as old-web's own
// separate "…ResizablePanelSizes" / "…ResizablePanelSizes:notes" localStorage keys.
export type SidebarModule = "drive" | "notes" | "chats" | "playlists"

export const DEFAULT_SIDEBAR_WIDTH = 300
export const SIDEBAR_WIDTH_MIN = 240
export const SIDEBAR_WIDTH_MAX = 520

export function clampSidebarWidth(width: number): number {
	return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, width))
}

// Pure drag math, unit-testable without a DOM (this project's vitest environment is "node" by
// default — vitest.config.ts). Unlike the notes markdown split-pane's ratio-of-container math
// (markdownSplitPane.tsx), a sidebar's left edge never moves — only its trailing edge, where the
// drag handle sits — so the next width is just the width recorded at pointerdown plus the pointer's
// own clientX delta, no container rect involved.
export function widthFromDrag(startWidth: number, startClientX: number, clientX: number): number {
	return clampSidebarWidth(startWidth + (clientX - startClientX))
}

export const SIDEBAR_WIDTH_STEP = 16

const SIDEBAR_WIDTH_KEY_BOUNDS: SplitterKeyBounds = { step: SIDEBAR_WIDTH_STEP, min: SIDEBAR_WIDTH_MIN, max: SIDEBAR_WIDTH_MAX }

// ArrowRight grows the trailing-edge handle, same sign convention as widthFromDrag's clientX delta.
export function widthFromKey(key: string, width: number): number | null {
	return splitterKeyValue(key, width, SIDEBAR_WIDTH_KEY_BOUNDS)
}

const sidebarWidthSchema: Type<number> = type("number")

function sidebarWidthPreference(module: SidebarModule): KvPreference<number> {
	return kvPreference({
		key: `shell.sidebarWidth.${module}.v1`,
		schema: sidebarWidthSchema,
		fallback: DEFAULT_SIDEBAR_WIDTH,
		normalize: clampSidebarWidth
	})
}

const sidebarWidthPreferences: Record<SidebarModule, KvPreference<number>> = {
	drive: sidebarWidthPreference("drive"),
	notes: sidebarWidthPreference("notes"),
	chats: sidebarWidthPreference("chats"),
	playlists: sidebarWidthPreference("playlists")
}

export function getSidebarWidth(module: SidebarModule): Promise<number> {
	return sidebarWidthPreferences[module].get()
}

export function setSidebarWidth(module: SidebarModule, width: number): Promise<void> {
	return sidebarWidthPreferences[module].set(width)
}
