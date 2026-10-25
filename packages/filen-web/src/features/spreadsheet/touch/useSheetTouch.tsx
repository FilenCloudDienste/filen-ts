import { useRef, useState, type ReactNode, type RefObject, type SyntheticEvent } from "react"
import { useTranslation } from "react-i18next"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS } from "@filen/office/core/sheet"
import type { GridSelection, SheetGridHandle, SheetGridState } from "@filen/office/react/sheet"
import {
	sayClipboardRefusal,
	type SheetClipboardCommands,
	type SheetClipboardResult
} from "@/features/spreadsheet/clipboard/useSheetClipboard"
import { SheetTouchMenu } from "@/features/spreadsheet/touch/sheetTouchMenu"
import "@/features/spreadsheet/touch/sheetTouch.css"

export interface SheetTouch {
	// SheetGrid's onTouchMenu.
	readonly onTouchMenu: (shown: boolean) => void
	// The menu, among the grid's overlays (null while it is not asked for).
	readonly overlay: ReactNode
	// Spread on the element round the grid, inside the grid menu's trigger: a finger's long press is the grid's (the
	// touch menu), never the context menu's.
	readonly wrapper: {
		readonly ref: RefObject<HTMLDivElement | null>
		readonly onPointerDownCapture: (event: { readonly pointerType: string }) => void
		readonly onTouchStartCapture: (event: SyntheticEvent) => void
		readonly onContextMenuCapture: (event: SyntheticEvent) => void
	}
	// SheetGridMenu's onOpenChange: the full menu the touch menu's ⋯ opened has closed.
	readonly onGridMenu: (open: boolean) => void
}

// While set on the document's root, the grid's context menu (opened by the touch menu's ⋯) has 44 px items
// (sheetTouch.css).
const TOUCH_MENU = "data-sheet-touch-menu"

// The grid under a finger: its touch menu (sheetTouchMenu.tsx) about the selection it was asked for, gone as soon as
// the selection or an entry changes, with the clipboard through its API.
export function useSheetTouch({
	grid,
	gridRef,
	canEdit,
	clipboard
}: {
	grid: SheetGridState
	gridRef: RefObject<SheetGridHandle | null>
	canEdit: boolean
	clipboard: SheetClipboardCommands
}): SheetTouch {
	const { t } = useTranslation("preview")
	const [menuFor, setMenuFor] = useState<GridSelection | null>(null)
	const lastPointer = useRef("")
	const wrapperRef = useRef<HTMLDivElement>(null)
	// The next contextmenu event is the ⋯'s own, to open the grid's menu.
	const opening = useRef(false)
	const model = grid.model
	const range = menuFor === null ? undefined : menuFor.ranges[menuFor.ranges.length - 1]
	const shown = menuFor !== null && menuFor === grid.selection && grid.editing === null && range !== undefined

	function done(result: SheetClipboardResult, key: string): void {
		sayClipboardRefusal(result, key, t)
	}

	function close(): void {
		setMenuFor(null)
		gridRef.current?.focus()
	}

	const actions = {
		edit: canEdit
			? () => {
					setMenuFor(null)
					gridRef.current?.editActive()
				}
			: null,
		cut: canEdit
			? () => {
					close()
					void clipboard.copy(true).then(result => {
						done(result, "X")
					})
				}
			: null,
		copy: () => {
			close()
			void clipboard.copy(false).then(result => {
				done(result, "C")
			})
		},
		paste: canEdit
			? () => {
					close()
					void clipboard.paste(false).then(result => {
						done(result, "V")
					})
				}
			: null,
		// The grid's full menu, at the active cell's lower left: a contextmenu at that point opens it there.
		more: () => {
			const wrapper = wrapperRef.current

			setMenuFor(null)

			if (wrapper === null) {
				return
			}

			const cell = gridRef.current?.clientRect(model.getSnapshot().selection.active) ?? null
			const area = wrapper.getBoundingClientRect()
			const x = cell === null ? area.left + area.width / 2 : cell.left
			const y = cell === null ? area.top + area.height / 2 : cell.bottom

			document.documentElement.setAttribute(TOUCH_MENU, "")
			opening.current = true
			wrapper.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }))
			opening.current = false
		},
		selectAll: () => {
			const { selection } = model.getSnapshot()

			close()
			model.choose({
				active: selection.active,
				anchor: { row: 0, col: 0 },
				focus: { row: SHEET_MAX_ROWS - 1, col: SHEET_MAX_COLS - 1 },
				ranges: [{ startRow: 0, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: SHEET_MAX_COLS - 1 }]
			})
		}
	}

	return {
		onTouchMenu: menu => {
			setMenuFor(menu ? model.getSnapshot().selection : null)
		},
		overlay: shown ? (
			<SheetTouchMenu
				gridRef={gridRef}
				range={range}
				actions={actions}
			/>
		) : null,
		onGridMenu: open => {
			if (!open) {
				document.documentElement.removeAttribute(TOUCH_MENU)
			}
		},
		wrapper: {
			ref: wrapperRef,
			onPointerDownCapture: event => {
				lastPointer.current = event.pointerType
			},
			onTouchStartCapture: event => {
				event.stopPropagation()
			},
			// A long press's contextmenu (Android): the grid shows its own menu for it.
			onContextMenuCapture: event => {
				if (lastPointer.current === "touch" && !opening.current) {
					event.preventDefault()
					event.stopPropagation()
				}
			}
		}
	}
}
