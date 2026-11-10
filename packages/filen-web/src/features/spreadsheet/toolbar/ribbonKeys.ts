import type { SheetGridModel, SheetShortcut } from "@filen/office/react/sheet"

// The keyboard shortcuts the ribbon runs as its own buttons do (wrap, alignment, indent, decimals, font size, zoom):
// they read what the ribbon holds (the active cell's format, the zoom it shows). The toolbar registers its runner
// while it is mounted; without one a shortcut does nothing.

const runners = new WeakMap<SheetGridModel, (shortcut: SheetShortcut) => boolean>()

export function registerRibbonKeys(model: SheetGridModel, runner: (shortcut: SheetShortcut) => boolean): () => void {
	runners.set(model, runner)

	return () => {
		if (runners.get(model) === runner) runners.delete(model)
	}
}

// True when the ribbon took the shortcut.
export function runRibbonKey(model: SheetGridModel, shortcut: SheetShortcut): boolean {
	return runners.get(model)?.(shortcut) === true
}
