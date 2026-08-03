import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react"
import { clampListboxIndex, listboxKeyTarget, resolveCursorIndex } from "@/features/drive/lib/listbox"
import {
	EMPTY_CONTACT_SELECTION_STATE,
	contactSelectionSize,
	nextContactSelection,
	removeFromContactSelection,
	type ContactSectionKey,
	type ContactSelection,
	type ContactSelectionState
} from "@/features/contacts/lib/selection"

export interface UseContactsListSelectionParams {
	// The route's own `section` search param. A fresh section view must never inherit the previous
	// one's selection/anchor — the contacts twin of useNotesListSelection's resetKey (viewMode) and
	// useDriveListboxNav's [variant, splat].
	resetKey: string
}

export interface ContactsListSelection {
	selection: ContactSelection
	selectedCount: number
	// Roving cursor: the index inside `uuids` that owns this section listbox's single Tab stop.
	// Resolved by uuid, not position, so a background refetch that reorders/removes rows cannot
	// silently retarget the cursor (drive's resolveCursorIndex, reused).
	activeIndexFor: (section: ContactSectionKey, uuids: readonly string[]) => number
	registerRowRef: (section: ContactSectionKey, uuid: string, element: HTMLDivElement | null) => void
	handlePointerSelect: (section: ContactSectionKey, uuids: readonly string[], index: number, event: MouseEvent) => void
	// Listbox-level key handling — bound on the section container, not per row (drive binds its own
	// handleKeyDown the same way), so a row never needs its own onKeyDown.
	handleKeyDown: (section: ContactSectionKey, uuids: readonly string[], event: KeyboardEvent<HTMLDivElement>) => void
	clearSelection: () => void
	pruneSelection: (section: ContactSectionKey, uuids: string[]) => void
}

const EMPTY_CURSORS: Record<ContactSectionKey, string | null> = {
	requests: null,
	pending: null,
	contacts: null,
	blocked: null
}

function rowKey(section: ContactSectionKey, uuid: string): string {
	return `${section}:${uuid}`
}

// The contacts-page counterpart of useNotesListSelection, extended with drive's roving cursor: each
// section is its own listbox with its own single Tab stop, because contacts renders every row of every
// section at once (no virtualizer) and every row carries its own action controls — a Tab stop per row
// would scale with the account. Selection state stays local to the page; nothing outside it reads a
// contacts selection, so a store would be YAGNI.
export function useContactsListSelection({ resetKey }: UseContactsListSelectionParams): ContactsListSelection {
	const [state, setState] = useState<ContactSelectionState>(EMPTY_CONTACT_SELECTION_STATE)
	const [cursors, setCursors] = useState<Record<ContactSectionKey, string | null>>(EMPTY_CURSORS)
	// Identity-keyed, so an index shift can never focus the wrong row. No rAF poll (drive's exists only
	// because a virtualized target may be unmounted) — every contacts row is already in the DOM.
	const rowRefs = useRef(new Map<string, HTMLDivElement>())

	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate view-switch reset, mirrors useNotesListSelection
		setState(EMPTY_CONTACT_SELECTION_STATE)
		setCursors(EMPTY_CURSORS)
	}, [resetKey])

	// The 0 fallback (rather than drive's tracked last-position one) is deliberate: contacts lists are
	// short and unvirtualized, so a vanished cursor row snapping to the top of its section is both cheap
	// and unsurprising, and the extra state drive needs exists only because of its virtualizer.
	function activeIndexFor(section: ContactSectionKey, uuids: readonly string[]): number {
		return resolveCursorIndex(cursors[section], uuids, 0)
	}

	function registerRowRef(section: ContactSectionKey, uuid: string, element: HTMLDivElement | null): void {
		if (element === null) {
			rowRefs.current.delete(rowKey(section, uuid))

			return
		}

		rowRefs.current.set(rowKey(section, uuid), element)
	}

	function moveCursor(section: ContactSectionKey, uuid: string): void {
		setCursors(prev => ({ ...prev, [section]: uuid }))
	}

	function handlePointerSelect(section: ContactSectionKey, uuids: readonly string[], index: number, event: MouseEvent): void {
		const uuid = uuids[index]

		if (uuid === undefined) {
			return
		}

		setState(prev =>
			nextContactSelection(prev, { section, uuids, index, shift: event.shiftKey, toggle: event.metaKey || event.ctrlKey })
		)
		moveCursor(section, uuid)
	}

	function handleKeyDown(section: ContactSectionKey, uuids: readonly string[], event: KeyboardEvent<HTMLDivElement>): void {
		// Only the option row itself is handled here. A Space/Enter (or arrow) that originated inside a
		// row's own action button belongs to that button — driveRow.tsx solves the pointer half of the
		// same problem with stopPropagation on its trigger.
		if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "option") {
			return
		}

		if (uuids.length === 0) {
			return
		}

		const activeIndex = activeIndexFor(section, uuids)

		if (event.key === " " || event.key === "Enter") {
			event.preventDefault()
			setState(prev => nextContactSelection(prev, { section, uuids, index: activeIndex, shift: false, toggle: true }))

			const uuid = uuids[activeIndex]

			if (uuid !== undefined) {
				moveCursor(section, uuid)
			}

			return
		}

		const target = listboxKeyTarget(event.key, activeIndex, uuids.length, 1, false)

		if (target === null) {
			return
		}

		event.preventDefault()

		const nextIndex = clampListboxIndex(target, uuids.length)
		const nextUuid = uuids[nextIndex]

		if (nextUuid === undefined) {
			return
		}

		// Shift+Arrow extends through the SAME call a Shift+click makes, so the two paths cannot diverge.
		if (event.shiftKey) {
			setState(prev => nextContactSelection(prev, { section, uuids, index: nextIndex, shift: true, toggle: false }))
		}

		moveCursor(section, nextUuid)
		rowRefs.current.get(rowKey(section, nextUuid))?.focus()
	}

	function clearSelection(): void {
		setState(EMPTY_CONTACT_SELECTION_STATE)
	}

	function pruneSelection(section: ContactSectionKey, uuids: string[]): void {
		if (uuids.length === 0) {
			return
		}

		setState(prev => ({ ...prev, selection: removeFromContactSelection(prev.selection, section, uuids) }))
	}

	return {
		selection: state.selection,
		selectedCount: contactSelectionSize(state.selection),
		activeIndexFor,
		registerRowRef,
		handlePointerSelect,
		handleKeyDown,
		clearSelection,
		pruneSelection
	}
}
