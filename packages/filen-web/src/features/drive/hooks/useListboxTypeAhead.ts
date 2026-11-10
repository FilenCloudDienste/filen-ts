import { useRef, type KeyboardEvent } from "react"
import { driveItemName } from "@filen/shared"
import { typeAheadBuffering, typeAheadCharacter, typeAheadIndex } from "@/features/drive/lib/listbox"
import { type DriveItem } from "@/features/drive/lib/item"

// Type-ahead for a listbox of drive items (the drive listing and the photos grid): the returned function takes a
// keydown and, when it is type-ahead's, cancels it, stops it short of every document-wide shortcut (a bare letter a
// user bound, the theme's D) and returns the index to move the cursor to, -1 when no name matches. null when the key
// is not type-ahead's. The prefix lives in refs: only the keydown reads it, and nothing renders from it.
export function useListboxTypeAhead(): (
	event: KeyboardEvent<HTMLElement>,
	items: readonly DriveItem[],
	activeIndex: number
) => number | null {
	const text = useRef("")
	const at = useRef(0)

	return (event, items, activeIndex) => {
		const now = Date.now()
		const buffering = typeAheadBuffering(text.current, at.current, now)
		const character = typeAheadCharacter(event, buffering)

		if (character === null) {
			return null
		}

		event.preventDefault()
		event.stopPropagation()

		text.current = buffering ? text.current + character : character
		at.current = now

		return typeAheadIndex(items, driveItemName, activeIndex, text.current, !buffering)
	}
}
