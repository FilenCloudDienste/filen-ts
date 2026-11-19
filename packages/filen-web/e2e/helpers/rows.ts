import type { Locator } from "@playwright/test"

// Row lookup by name and the listing scroll step, shared by listing.ts and archive.ts (archive.ts imports
// listing.ts, so neither can hold them for the other).

export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// A name as a whole token of an accessible name: a drive row's or an archive row's name is followed by
// its size and date columns (and preceded, in grid view, by an `.sr-only` badge, driveTile.tsx), so
// `exact` never matches one and a bare substring matches every sibling whose name starts with it. Never
// right after a comma, where a Modified date's year ("Jan 1, 2024") would pass for a name.
export function namePattern(name: string): RegExp {
	return new RegExp(`(^|(?<!,)\\s)${escapeRegExp(name)}(\\s|$)`)
}

// A name at the start of an accessible name: an archive row's (or a list-view drive row's) name leads,
// so its size and date columns can never match a name such as "2024" the way a token match does.
export function leadingNamePattern(name: string): RegExp {
	return new RegExp(`^${escapeRegExp(name)}(\\s|$)`)
}

// Scrolls whatever holds the listbox (the nearest ancestor, or itself, that scrolls; the page when none
// does) to its top, or most of a screen further down, and waits two frames for the virtualizer to mount
// what the scroll brought near. Resolves whether the scroll position moved; rejects only when the evaluate
// does (a detached listbox), so each caller decides whether its reveal may throw.
export function scrollListing(listbox: Locator, to: "top" | "next"): Promise<boolean> {
	return listbox.evaluate(async (element, step) => {
		let scroller: HTMLElement | null = element instanceof HTMLElement ? element : null

		while (scroller !== null) {
			const { overflowY } = getComputedStyle(scroller)

			if ((overflowY === "auto" || overflowY === "scroll") && scroller.scrollHeight > scroller.clientHeight) {
				break
			}

			scroller = scroller.parentElement
		}

		const target = scroller ?? document.scrollingElement

		if (target === null) {
			return false
		}

		const before = target.scrollTop

		target.scrollTop = step === "top" ? 0 : before + Math.max(1, Math.floor(target.clientHeight * 0.8))

		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

		return target.scrollTop !== before
	}, to)
}
