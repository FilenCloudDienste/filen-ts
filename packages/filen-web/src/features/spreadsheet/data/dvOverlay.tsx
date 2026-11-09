import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDownIcon } from "lucide-react"
import type { DvListItem, SheetCommand, SheetSessionApi } from "@filen/office/core/sheet"
import {
	useCellPlacement,
	validationEntry,
	type SheetGridHandle,
	type SheetGridState,
	type ValidationPlacement
} from "@filen/office/react/sheet"
import { columnListKey, columnListShown, listCellKey, listShown, sortedEntries } from "@/features/spreadsheet/data/dvOverlay.logic"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"

// What a cell's data validation shows over the grid: the button that opens a list validation's values beside the
// active cell (the chosen value is written as typed; Alt+Down opens them too, the keys then pick), and the input
// message under it while it is selected. On a cell without one, Alt+Down lists the column's entries (AutoComplete's,
// sorted) from the same place, with no button shown.

type ListState =
	| { readonly status: "loading" }
	| { readonly status: "ready"; readonly items: readonly DvListItem[] }
	| { readonly status: "unavailable" }

export function ValidationOverlay({
	grid,
	gridRef,
	session,
	canEdit,
	run,
	openList,
	onOpenList
}: {
	grid: SheetGridState
	gridRef: RefObject<SheetGridHandle | null>
	session: SheetSessionApi
	canEdit: boolean
	run: (command: SheetCommand) => void
	// The cell whose list is open (listCellKey), or null.
	openList: string | null
	onOpenList: (cell: string | null) => void
}) {
	const { row, col } = grid.selection.active
	const entry = validationEntry(grid.layout, row, col)
	const rightToLeft = grid.layout?.rightToLeft ?? false
	const messageShown = entry !== null && entry.prompt !== null && grid.editing === null
	const cell = listCellKey(grid.sheet, row, col)
	const column = columnListKey(grid.sheet, row, col)

	return (
		<>
			{listShown(grid, canEdit) ? (
				<ValidationList
					// A new cell starts closed.
					key={cell}
					source="validation"
					grid={grid}
					gridRef={gridRef}
					session={session}
					rightToLeft={rightToLeft}
					run={run}
					open={openList === cell}
					onOpenChange={open => {
						onOpenList(open ? cell : null)
					}}
				/>
			) : openList === column && columnListShown(grid, canEdit) ? (
				<ValidationList
					key={column}
					source="column"
					grid={grid}
					gridRef={gridRef}
					session={session}
					rightToLeft={rightToLeft}
					run={run}
					open
					onOpenChange={open => {
						if (!open) onOpenList(null)
					}}
				/>
			) : null}
			{messageShown ? (
				<ValidationMessage
					gridRef={gridRef}
					cell={{ row, col }}
					// Beside the open list, not under it.
					placement={openList === cell ? "messageBesideList" : "message"}
					title={entry.promptTitle}
					text={entry.prompt}
					rightToLeft={rightToLeft}
				/>
			) : null}
		</>
	)
}

function ValidationList({
	source,
	grid,
	gridRef,
	session,
	rightToLeft,
	run,
	open,
	onOpenChange
}: {
	source: ListSource
	grid: SheetGridState
	gridRef: RefObject<SheetGridHandle | null>
	session: SheetSessionApi
	rightToLeft: boolean
	run: (command: SheetCommand) => void
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const { t } = useTranslation("preview")
	const listRef = useRef<HTMLDivElement>(null)
	const { sheet } = grid
	const { row, col } = grid.selection.active

	const ref = useCellPlacement<HTMLButtonElement>(gridRef, { row, col }, "button", rightToLeft)

	function pick(item: DvListItem): void {
		onOpenChange(false)
		run({ type: "cells.set", sheet, cells: { rows: Uint32Array.of(row), cols: Uint16Array.of(col), inputs: [item.input] } })
		gridRef.current?.focus()
	}

	return (
		<Popover
			open={open}
			onOpenChange={onOpenChange}
		>
			<PopoverTrigger
				ref={ref}
				data-sheet-validation-button
				// The column's entries open from where a list's button is, which a plain cell does not show.
				{...(source === "column"
					? { "aria-hidden": true, tabIndex: -1, className: "pointer-events-none absolute top-0 left-0 w-5 opacity-0" }
					: {
							"aria-label": t("previewSheetValidationOpenList"),
							className:
								"pointer-events-auto absolute top-0 left-0 flex w-5 items-center justify-center border border-border bg-background text-foreground hover:bg-muted"
						})}
				style={{ visibility: "hidden" }}
			>
				<ChevronDownIcon className="size-3" />
			</PopoverTrigger>
			<PopoverContent
				data-preview-surface
				align="start"
				initialFocus={listRef}
				// Closed from the keyboard (Esc), typing goes on in the grid, as in Excel.
				finalFocus={closeType => {
					if (closeType !== "keyboard") return true

					gridRef.current?.focus()

					return false
				}}
				className="max-h-72 w-auto min-w-40 gap-0 overflow-y-auto p-1"
			>
				<ListItems
					listRef={listRef}
					source={source}
					session={session}
					sheet={sheet}
					row={row}
					col={col}
					current={grid.active.text}
					onPick={pick}
					onEmpty={() => {
						onOpenChange(false)
						gridRef.current?.focus()
					}}
				/>
			</PopoverContent>
		</Popover>
	)
}

// A validation's list, or the column's entries (Alt+Down on a cell without a list).
type ListSource = "validation" | "column"

// How long typed letters keep adding to what the list jumps to.
const TYPEAHEAD_MS = 700

// The list's values, read when it opens: arrows, Home and End move the highlight, typing jumps to the next value
// starting with what was typed, Enter picks (support.microsoft.com, "Keyboard shortcuts in Excel": Alt+Down opens
// a drop-down list, and Option+Down the AutoComplete list). The column's entries close again when there are none.
function ListItems({
	listRef,
	source,
	session,
	sheet,
	row,
	col,
	current,
	onPick,
	onEmpty
}: {
	listRef: RefObject<HTMLDivElement | null>
	source: ListSource
	session: SheetSessionApi
	sheet: number
	row: number
	col: number
	current: string
	onPick: (item: DvListItem) => void
	onEmpty: () => void
}) {
	const { t } = useTranslation("preview")
	const id = useId()
	const [list, setList] = useState<ListState>({ status: "loading" })
	const [active, setActive] = useState(0)
	const typed = useRef({ text: "", at: 0 })

	// The values are the session's, read once the list opens (this mounts then).
	useEffect(() => {
		let live = true
		const read =
			source === "validation"
				? session.query("validation.list", { sheet, row, col })
				: session.query("autoComplete.entries", { sheet, row, col }).then(result => ({ items: sortedEntries(result.entries) }))

		read.then(
			result => {
				if (!live) return

				if (result === null) {
					setList({ status: "unavailable" })

					return
				}

				setList({ status: "ready", items: result.items })
				setActive(
					Math.max(
						0,
						result.items.findIndex(item => item.text === current)
					)
				)
			},
			() => {
				if (live) setList({ status: "unavailable" })
			}
		)

		return () => {
			live = false
		}
	}, [source, session, sheet, row, col, current])

	const empty = source === "column" && list.status === "ready" && list.items.length === 0

	// A column with no entries lists nothing: the list closes again.
	useEffect(() => {
		if (empty) onEmpty()
	}, [empty, onEmpty])

	const items = list.status === "ready" ? list.items : []

	function move(index: number): void {
		if (items.length === 0) return

		const next = Math.max(0, Math.min(items.length - 1, index))

		setActive(next)
		listRef.current?.querySelector(`[data-index="${String(next)}"]`)?.scrollIntoView({ block: "nearest" })
	}

	function jump(char: string): void {
		const now = Date.now()
		const text = now - typed.current.at > TYPEAHEAD_MS ? char : typed.current.text + char

		typed.current = { text, at: now }

		const wanted = text.toLocaleLowerCase()
		// A first letter typed again steps to the next value with it; more letters refine from the highlight.
		const from = text.length === 1 ? active + 1 : active

		for (let k = 0; k < items.length; k++) {
			const index = (from + k) % items.length

			if ((items[index]?.text ?? "").toLocaleLowerCase().startsWith(wanted)) {
				move(index)

				return
			}
		}
	}

	function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		switch (event.key) {
			case "ArrowDown":
				move(active + 1)
				break
			case "ArrowUp":
				move(active - 1)
				break
			case "Home":
				move(0)
				break
			case "End":
				move(items.length - 1)
				break
			case "PageDown":
				move(active + 10)
				break
			case "PageUp":
				move(active - 10)
				break
			case "Enter": {
				const item = items[active]

				if (item !== undefined) onPick(item)
				break
			}
			default:
				if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
					jump(event.key)
					break
				}

				return
		}

		event.preventDefault()
	}

	return (
		<div
			ref={listRef}
			role="listbox"
			tabIndex={0}
			aria-label={t(source === "validation" ? "previewSheetValidationListLabel" : "previewSheetAutoCompleteListLabel")}
			aria-busy={list.status === "loading"}
			aria-activedescendant={items.length === 0 ? undefined : `${id}-${String(active)}`}
			className="outline-hidden"
			onKeyDown={onKeyDown}
		>
			{list.status === "loading" ? (
				<Spinner className="m-2 size-4" />
			) : list.status === "unavailable" ? (
				<p className="p-2 text-muted-foreground">{t("previewSheetValidationListUnavailable")}</p>
			) : (
				items.map((item, index) => (
					<div
						// Items may repeat (a list from cells).
						key={index}
						id={`${id}-${String(index)}`}
						data-index={index}
						role="option"
						aria-selected={index === active}
						className="block w-full cursor-default truncate rounded-md px-2 py-1 text-left hover:bg-muted aria-selected:bg-accent"
						onPointerMove={() => {
							if (index !== active) setActive(index)
						}}
						onClick={() => {
							onPick(item)
						}}
					>
						{item.text === "" ? "\u00a0" : item.text}
					</div>
				))
			)}
		</div>
	)
}

function ValidationMessage({
	gridRef,
	cell,
	placement,
	title,
	text,
	rightToLeft
}: {
	gridRef: RefObject<SheetGridHandle | null>
	cell: { readonly row: number; readonly col: number }
	placement: ValidationPlacement
	title: string | null
	text: string
	rightToLeft: boolean
}) {
	const ref = useCellPlacement<HTMLDivElement>(gridRef, cell, placement, rightToLeft)

	return (
		<div
			ref={ref}
			role="note"
			data-sheet-validation-message
			className="absolute top-0 left-0 max-w-64 rounded-md border border-border bg-popover px-2 py-1 text-xs whitespace-pre-wrap text-popover-foreground shadow-md"
			style={{ visibility: "hidden" }}
		>
			{title === null || title === "" ? null : <p className="font-semibold">{title}</p>}
			{text === "" ? null : <p>{text}</p>}
		</div>
	)
}
