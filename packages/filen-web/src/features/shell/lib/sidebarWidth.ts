import { type, type Type } from "arktype"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"

// The three contextual sidebars big enough to want more room than the fixed-width settings/contacts
// panels — each persists its own width independently, same per-module split as old-web's own
// separate "…ResizablePanelSizes" / "…ResizablePanelSizes:notes" localStorage keys.
export type SidebarModule = "drive" | "notes" | "chats"

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

function sidebarWidthKvKey(module: SidebarModule): string {
	return `shell.sidebarWidth.${module}.v1`
}

const sidebarWidthSchema: Type<number> = type("number")

// kvGetJson already collapses "absent" and "schema-invalid" to null (see @/lib/storage/adapter); a
// persisted-but-out-of-range value (e.g. written before MIN/MAX changed) is clamped on the way out
// too, not just on write — same self-heal shape as getMdSplitRatio.
export async function getSidebarWidth(module: SidebarModule): Promise<number> {
	const stored = await kvGetJson(sidebarWidthKvKey(module), sidebarWidthSchema)

	return stored === null ? DEFAULT_SIDEBAR_WIDTH : clampSidebarWidth(stored)
}

export async function setSidebarWidth(module: SidebarModule, width: number): Promise<void> {
	await kvSetJson(sidebarWidthKvKey(module), clampSidebarWidth(width))
}
