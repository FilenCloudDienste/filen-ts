import type { Locator } from "@playwright/test"

// A menu item's accessible name ends in its key hint where the surface binds one (MenuShortcut/MenuKbd): the keys are
// spoken words ("Open Enter", "Info Alt Enter", "Download Control S"), each starting with a capital, a digit or a
// symbol. Matches `label` alone or followed by such words, so "Open" never matches "Open in new tab" or "Open
// containing directory" (sentence-case labels go on in lower case) and a test does not depend on the user's bindings.
export function menuItemName(label: string): RegExp {
	return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&")}(?: [^\\sa-z]\\S*)*$`, "u")
}

// The menu items' labels without their key hints, in order (textContent, as toHaveText reads it, past the hint slot).
export function menuItemLabels(items: Locator): Promise<string[]> {
	return items.evaluateAll(elements =>
		elements.map(element => {
			const copy = element.cloneNode(true) as Element

			for (const hint of copy.querySelectorAll('[data-slot="menu-shortcut"]')) {
				hint.remove()
			}

			return copy.textContent.replace(/\s+/gu, " ").trim()
		})
	)
}
