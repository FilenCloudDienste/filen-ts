import { Fragment, isValidElement, type ReactNode } from "react"
import type { SheetGridExtension, SheetShortcut } from "@filen/office/react/sheet"

// What a feature adds to the sheet view, from a hook of its own that SheetBody calls: the grid's paint layers,
// decorators and pointer hook, overlays over the cells, items in the grid's menu and the shortcuts it handles. Every
// part is optional; SheetBody composes them in a fixed order.
export interface SheetBodyExtension {
	// Unique among the view's extensions (the menu group's key).
	readonly id: string
	readonly grid?: SheetGridExtension
	// Rendered over the cells (SheetGrid's children): placed with SheetGridHandle.cellRect, re-placed on onFrame.
	readonly overlay?: ReactNode
	// A group of the grid's context menu, after the structure and merge items.
	readonly menuItems?: ReactNode
	// Rendered beside the grid (dialogs, sheets): outside the context menu's trigger.
	readonly dialogs?: ReactNode
	// A keyboard shortcut (react/sheet/keys.ts) before SheetBody's own handling: true takes it.
	readonly shortcut?: (shortcut: SheetShortcut) => boolean
	// What the ribbon runs of the feature (absent: not offered now).
	readonly ribbon?: SheetRibbonCommands
}

// The features' commands the ribbon offers, each present only while it can run: the active cell's comment and note,
// the Series dialog, data validation, the selected object's tools.
export interface SheetRibbonCommands {
	readonly newComment?: () => void
	readonly note?: {
		// The active cell holds one: Edit note, Show or hide, Delete; else New note.
		readonly exists: boolean
		readonly shown: boolean
		readonly toggle: () => void
		readonly remove: () => void
	}
	readonly fillSeries?: () => void
	readonly dataValidation?: () => void
	readonly object?: {
		readonly chart: boolean
		readonly altText: (() => void) | undefined
		readonly remove: (() => void) | undefined
	}
	readonly editChart?: () => void
}

// Every feature's ribbon commands, as one.
export function ribbonCommands(extensions: readonly SheetBodyExtension[]): SheetRibbonCommands {
	return extensions.reduce<SheetRibbonCommands>(
		(all, extension) => (extension.ribbon === undefined ? all : { ...all, ...extension.ribbon }),
		{}
	)
}

export function gridExtensions(extensions: readonly SheetBodyExtension[]): SheetGridExtension[] {
	const grid: SheetGridExtension[] = []

	for (const extension of extensions) if (extension.grid !== undefined) grid.push(extension.grid)

	return grid
}

// Whether a menu group renders anything: one built of conditional parts (null, false, fragments of them) can come
// out empty, and an empty group gets no separator.
export function rendersItems(node: ReactNode): boolean {
	if (node === null || node === undefined || typeof node === "boolean" || node === "") return false
	if (Array.isArray(node)) return node.some(rendersItems)
	if (isValidElement<{ children?: ReactNode }>(node) && node.type === Fragment) return rendersItems(node.props.children)

	return true
}

export function menuGroups(extensions: readonly SheetBodyExtension[]): { readonly id: string; readonly node: ReactNode }[] {
	const groups: { id: string; node: ReactNode }[] = []

	for (const extension of extensions) if (rendersItems(extension.menuItems)) groups.push({ id: extension.id, node: extension.menuItems })

	return groups
}

// The first extension that takes `shortcut`.
export function extensionShortcut(extensions: readonly SheetBodyExtension[], shortcut: SheetShortcut): boolean {
	return extensions.some(extension => extension.shortcut?.(shortcut) === true)
}
