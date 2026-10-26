import { type, type Type } from "arktype"
import { kvPreference, type KvPreference } from "@/lib/storage/preference"
import { splitterKeyValue, type SplitterKeyBounds } from "@/lib/useSeparatorValue.logic"

// The contextual sidebars big enough to want more room than the fixed-width settings/contacts
// panels — each persists its own width independently, same per-module split as old-web's own
// separate "…ResizablePanelSizes" / "…ResizablePanelSizes:notes" localStorage keys. "assistant" is the
// right-hand panel after the content card.
export type SidebarModule = "drive" | "notes" | "chats" | "playlists" | "videos" | "sync" | "mounts" | "assistant"

// Which edge of the panel the drag handle sits on: the left sidebars grow from their trailing (right)
// edge, the right-hand assistant panel from its leading (left) edge.
export type SidebarEdge = "trailing" | "leading"

export const SIDEBAR_EDGE: Record<SidebarModule, SidebarEdge> = {
	drive: "trailing",
	notes: "trailing",
	chats: "trailing",
	playlists: "trailing",
	videos: "trailing",
	sync: "trailing",
	mounts: "trailing",
	assistant: "leading"
}

export const DEFAULT_SIDEBAR_WIDTH = 300
// Markdown replies and confirmation cards need more room than a list of rows.
export const DEFAULT_ASSISTANT_WIDTH = 360

export function defaultSidebarWidth(module: SidebarModule): number {
	return module === "assistant" ? DEFAULT_ASSISTANT_WIDTH : DEFAULT_SIDEBAR_WIDTH
}
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

// Leading-edge handle: the panel's right edge is the fixed one, so dragging left grows it.
export function widthFromLeadingDrag(startWidth: number, startClientX: number, clientX: number): number {
	return clampSidebarWidth(startWidth - (clientX - startClientX))
}

export const SIDEBAR_WIDTH_STEP = 16

const SIDEBAR_WIDTH_KEY_BOUNDS: SplitterKeyBounds = { step: SIDEBAR_WIDTH_STEP, min: SIDEBAR_WIDTH_MIN, max: SIDEBAR_WIDTH_MAX }

// ArrowRight grows the trailing-edge handle, same sign convention as widthFromDrag's clientX delta.
export function widthFromKey(key: string, width: number): number | null {
	return splitterKeyValue(key, width, SIDEBAR_WIDTH_KEY_BOUNDS)
}

// Mirrored for the leading-edge handle, so the arrow always points the way the edge moves: ArrowLeft
// grows. Home/End keep meaning the clamps.
export function widthFromLeadingKey(key: string, width: number): number | null {
	if (key === "ArrowLeft") {
		return splitterKeyValue("ArrowRight", width, SIDEBAR_WIDTH_KEY_BOUNDS)
	}

	if (key === "ArrowRight") {
		return splitterKeyValue("ArrowLeft", width, SIDEBAR_WIDTH_KEY_BOUNDS)
	}

	return splitterKeyValue(key, width, SIDEBAR_WIDTH_KEY_BOUNDS)
}

const sidebarWidthSchema: Type<number> = type("number")

function sidebarWidthPreference(module: SidebarModule): KvPreference<number> {
	return kvPreference({
		key: `shell.sidebarWidth.${module}.v1`,
		schema: sidebarWidthSchema,
		fallback: defaultSidebarWidth(module),
		normalize: clampSidebarWidth
	})
}

const sidebarWidthPreferences: Record<SidebarModule, KvPreference<number>> = {
	drive: sidebarWidthPreference("drive"),
	notes: sidebarWidthPreference("notes"),
	chats: sidebarWidthPreference("chats"),
	playlists: sidebarWidthPreference("playlists"),
	videos: sidebarWidthPreference("videos"),
	sync: sidebarWidthPreference("sync"),
	mounts: sidebarWidthPreference("mounts"),
	assistant: sidebarWidthPreference("assistant")
}

export function getSidebarWidth(module: SidebarModule): Promise<number> {
	return sidebarWidthPreferences[module].get()
}

export function setSidebarWidth(module: SidebarModule, width: number): Promise<void> {
	return sidebarWidthPreferences[module].set(width)
}
