import type { Locator } from "@playwright/test"
import { escapeRegExp } from "./rows"

// A menu item's accessible name ends in its key hint where the surface binds one (MenuShortcut/MenuKbd): the keys are
// spoken words ("Open Enter", "Info Alt Enter", "Open Enter Command Down arrow", "Rename F2"), the first a capitalized
// word, a lone key or a function key. Matches `label` alone or followed by such a hint, so "Open" never matches "Open in
// new tab" (sentence-case labels go on in lower case) nor "Copy" "Copy ID" (an acronym is no key word), and a test does
// not depend on the bindings.
export function menuItemName(label: string): RegExp {
	return new RegExp(`^${escapeRegExp(label)}(?: (?:[A-Z][a-z]*|F\\d+|[^\\sa-zA-Z]\\S*)(?: .*)?)?$`, "u")
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
