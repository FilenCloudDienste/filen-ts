import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type RefObject } from "react"
import { flushSync } from "react-dom"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { type DriveItem } from "@/features/drive/lib/item"
import { PreviewErrorState } from "@/features/preview/components/previewErrorState"
import { FormatToolbar } from "@/features/spreadsheet/components/formatToolbar"
import { SheetGrid } from "@/features/spreadsheet/components/sheetGrid"
import { SheetTabs } from "@/features/spreadsheet/components/sheetTabs"
import { useSpreadsheetDoc } from "@/features/spreadsheet/hooks/useSpreadsheetDoc"
import { useSpreadsheetEdits, useSpreadsheetWritability, type SpreadsheetSnapshot } from "@/features/spreadsheet/hooks/useSpreadsheetEdits"
import { rangeName, selectionRange, type CellPosition, type Selection } from "@/features/spreadsheet/lib/cellRef.logic"
import { CellStore, type GridDoc, type GridSheet } from "@/features/spreadsheet/lib/cellStore.logic"
import { MAX_EDIT_CELLS, type EditOp, type EditResult, type FormatPatch } from "@/features/spreadsheet/lib/edits"
import { cellKey, keyCol, keyRow, type CellRange } from "@/features/spreadsheet/lib/model"
import {
	gridMove,
	isImeKeydown,
	isTypedCharacter,
	sheetBounds,
	sheetCols,
	sheetRows,
	snapToMerge
} from "@/features/spreadsheet/lib/navigation.logic"
import { parseTsv, rangeToTsv } from "@/features/spreadsheet/lib/tsv.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { LoadingState } from "@/components/loadingState"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"

// The overlay's handle on the open file's bytes as edited, read when it saves: an open cell entry is
// committed first, and the bytes come after every edit already made. `commit` marks them saved once
// stored.
export type SpreadsheetSaveSource = () => Promise<{ bytes: Uint8Array; commit: () => void }>

interface SpreadsheetViewerProps {
	item: DriveItem
	// Names the document across this user's own saves (which give the item a new uuid): the file stays
	// open, with its undo history, while it holds.
	documentKey: string
	alt: string
	editable?: boolean
	// Why a file the user could otherwise edit is read-only, for the note beside the cell contents.
	readOnlyReason?: "renamed"
	// Nothing will ever edit this file here (a public link): the worker can drop what only a save needs.
	neverEditable?: boolean
	onDirtyChange?: (dirty: boolean) => void
	saveRef?: RefObject<SpreadsheetSaveSource | null>
}

const ORIGIN: Selection = { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }

// Unreachable (a workbook with no sheets never reaches the body, and sheets are only ever added), but it
// keeps the body's sheet defined.
const NO_SHEET: GridSheet = {
	name: "",
	rowCount: 0,
	colCount: 0,
	cells: new CellStore(new Map()),
	merges: [],
	colWidths: new Map(),
	rowHeights: new Map(),
	hiddenCols: [],
	hiddenRows: [],
	frozenRows: 0,
	frozenCols: 0,
	structureLocked: true
}

// The in-cell editor: it exists only while an entry is typed, so it takes focus as it appears (in the same
// task, so an input method's composition started by the key that opened it lands here), with the caret
// after what it starts from (the typed character, or the cell's content).
function CellEditor({
	label,
	value,
	onChange,
	onKeyDown,
	onBlur
}: {
	label: string
	value: string
	onChange: (text: string) => void
	onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
	onBlur: (event: FocusEvent<HTMLInputElement>) => void
}) {
	const inputRef = useRef<HTMLInputElement>(null)

	useLayoutEffect(() => {
		const input = inputRef.current

		input?.focus({ preventScroll: true })
		input?.setSelectionRange(input.value.length, input.value.length)
	}, [])

	return (
		<input
			ref={inputRef}
			aria-label={label}
			value={value}
			className="size-full min-w-full bg-background px-1.5 text-[13px] outline-2 -outline-offset-2 outline-primary"
			onChange={event => {
				onChange(event.target.value)
			}}
			onKeyDown={onKeyDown}
			onBlur={onBlur}
		/>
	)
}

const REFUSED_MESSAGES = {
	structureLocked: "previewSpreadsheetStructureLocked",
	sheetName: "previewSpreadsheetSheetNameInvalid",
	tooLarge: "previewSpreadsheetTooLarge",
	arrayFormula: "previewSpreadsheetArrayFormula",
	tableHeader: "previewSpreadsheetTableHeader"
} as const satisfies Record<Extract<EditResult, { type: "refused" }>["reason"], string>

type Move = "down" | "up" | "right" | "left" | "none"

const MOVE_KEYS = { down: "ArrowDown", up: "ArrowUp", right: "ArrowRight", left: "ArrowLeft" } as const

interface Editing {
	row: number
	col: number
	text: string
	// Where the typing happens: in the cell, or in the formula bar.
	from: "cell" | "bar"
}

function sameSelection(a: Selection, b: Selection): boolean {
	return a.anchor.row === b.anchor.row && a.anchor.col === b.anchor.col && a.focus.row === b.focus.row && a.focus.col === b.focus.col
}

function SpreadsheetBody({
	id,
	initial,
	alt,
	editable,
	unnamed,
	renamed,
	readOnlyReason,
	neverEditable,
	onDirtyChange,
	saveRef
}: {
	id: number
	initial: GridDoc
	alt: string
	editable: boolean
	unnamed: boolean
	renamed: boolean
	readOnlyReason: "renamed" | undefined
	neverEditable: boolean
	onDirtyChange: ((dirty: boolean) => void) | undefined
	saveRef: RefObject<SpreadsheetSaveSource | null> | undefined
}) {
	const { t } = useTranslation("preview")
	const edits = useSpreadsheetEdits(id, initial)
	const doc = edits.doc
	const writability = useSpreadsheetWritability(id, doc, editable && !unnamed, neverEditable)
	const canEdit = editable && writability === "writable" && !unnamed && !renamed
	// Editing waits on the worker's proof: the toolbar holds its place meanwhile, disabled.
	const toolbarShown = canEdit || (editable && !unnamed && !renamed && writability === "checking")
	const readOnlyNote = !editable
		? readOnlyReason === "renamed"
			? t("previewSpreadsheetReadOnlyRenamed")
			: null
		: unnamed
			? t("previewSpreadsheetReadOnlyUnnamed")
			: renamed
				? t("previewSpreadsheetReadOnlyRenamed")
				: writability === "checking"
					? t("previewSpreadsheetCheckingWritable")
					: writability === "readOnly" && doc.kind === "xlsx"
						? t("previewSpreadsheetReadOnlyLossy")
						: writability === "readOnly" && doc.kind !== "xls"
							? t("previewSpreadsheetReadOnlyUnsafe")
							: null
	const [chosenSheet, setChosenSheet] = useState(doc.activeSheet)
	// An undone "add sheet" can take away the sheet on show.
	const sheetIndex = Math.max(0, Math.min(chosenSheet, doc.sheets.length - 1))
	// One selection per sheet, so switching tabs and back keeps each one's place.
	const [selections, setSelections] = useState<ReadonlyMap<number, Selection>>(() => new Map())
	const [editing, setEditing] = useState<Editing | null>(null)
	const [renaming, setRenaming] = useState<number | null>(null)
	// The entry last committed or cancelled. Finishing one moves focus, which blurs the input it was typed
	// in, and that blur's handler still sees the same entry: without this it would be committed again.
	const finished = useRef<Editing | null>(null)
	const gridRef = useRef<HTMLDivElement | null>(null)
	const barRef = useRef<HTMLInputElement>(null)
	const alive = useRef(true)
	const clipboardRef = useRef<((event: ClipboardEvent) => void) | null>(null)
	// Editing stopped being possible while it was open (the file renamed meanwhile): nothing renames a sheet
	// now. An open entry is committed instead (see the effect below), never dropped unseen.
	const wasEditable = useRef(canEdit)

	if (!canEdit && renaming !== null) {
		setRenaming(null)
	}

	// A selection belongs to the sheet it was made on: a sheet removed (an undone "add sheet") takes its
	// selection with it, so a sheet added again at that place starts afresh.
	const [sheetCount, setSheetCount] = useState(doc.sheets.length)

	if (sheetCount !== doc.sheets.length) {
		setSheetCount(doc.sheets.length)

		// The sheet on show went too: the one now shown is the one chosen, so the next "add" stays put.
		if (chosenSheet > doc.sheets.length - 1) {
			setChosenSheet(Math.max(0, doc.sheets.length - 1))
		}

		if (doc.sheets.length < sheetCount) {
			setSelections(prev => new Map([...prev].filter(([index]) => index < doc.sheets.length)))
		}
	}

	const sheet = doc.sheets[sheetIndex] ?? NO_SHEET
	const selection = selections.get(sheetIndex) ?? ORIGIN
	const range = selectionRange(selection)
	const active = sheet.cells.get(cellKey(selection.focus.row, selection.focus.col))
	const activeInput = active?.input ?? active?.text ?? ""
	const activeStyle = active?.style === undefined ? undefined : doc.styles[active.style]
	const entryCell = editing === null ? undefined : sheet.cells.get(cellKey(editing.row, editing.col))
	const entryChanged = editing !== null && editing.text !== (entryCell?.input ?? entryCell?.text ?? "")
	// Unsaved as soon as anything is typed: an open entry, and edits the worker has not answered yet.
	const dirty = edits.state.dirty || edits.pending || entryChanged

	function select(next: Selection): void {
		// A cell inside a merge stands for the merge: its anchor is what is shown, edited and named.
		const snapped = { anchor: snapToMerge(next.anchor, sheet.merges), focus: snapToMerge(next.focus, sheet.merges) }

		if (!sameSelection(snapped, selection)) {
			setSelections(prev => new Map(prev).set(sheetIndex, snapped))
		}
	}

	function focusGrid(): void {
		gridRef.current?.focus({ preventScroll: true })
	}

	function report(result: EditResult): void {
		if (result.type !== "refused") {
			return
		}

		toast.error(t(REFUSED_MESSAGES[result.reason]))
	}

	function apply(op: EditOp): void {
		edits.apply(op).then(report, () => {
			if (alive.current) {
				toast.error(t("previewSpreadsheetEditFailed"))
			}
		})
	}

	function startEditing(from: Editing["from"], text: string): void {
		if (!canEdit) {
			return
		}

		setEditing({ row: selection.focus.row, col: selection.focus.col, text, from })
	}

	// Where Enter and Tab leave an entry: the next shown cell that way, past a merge.
	function moved(position: CellPosition, move: Move): CellPosition {
		if (move === "none") {
			return position
		}

		const next = gridMove(
			{ key: MOVE_KEYS[move], shiftKey: false, ctrlKey: false, metaKey: false, altKey: false },
			{ anchor: position, focus: position },
			{ ...sheetBounds(sheet, sheetRows(sheet).axis, sheetCols(sheet)), pageRows: 1 }
		)

		return next?.focus ?? position
	}

	function commit(move: Move): void {
		if (editing === null || finished.current === editing) {
			return
		}

		finished.current = editing

		if (entryChanged) {
			apply({ type: "setCells", sheet: sheetIndex, cells: [{ row: editing.row, col: editing.col, input: editing.text }] })
		}

		const next = moved({ row: editing.row, col: editing.col }, move)

		setEditing(null)
		select({ anchor: next, focus: next })
		focusGrid()
	}

	function cancel(): void {
		finished.current = editing
		setEditing(null)
		focusGrid()
	}

	// The cells a clear touches: those in the range holding anything. Whichever is smaller is walked, the
	// range or the sheet's filled cells, so selecting whole columns costs what the sheet holds.
	function filledIn(target: CellRange): { row: number; col: number; input: string }[] {
		const cleared: { row: number; col: number; input: string }[] = []
		const area = (target.endRow - target.startRow + 1) * (target.endCol - target.startCol + 1)

		if (area <= sheet.cells.size) {
			for (let row = target.startRow; row <= target.endRow; row++) {
				for (let col = target.startCol; col <= target.endCol; col++) {
					if (sheet.cells.has(cellKey(row, col))) {
						cleared.push({ row, col, input: "" })
					}
				}
			}

			return cleared
		}

		for (const key of sheet.cells.keys()) {
			const row = keyRow(key)
			const col = keyCol(key)

			if (row >= target.startRow && row <= target.endRow && col >= target.startCol && col <= target.endCol) {
				cleared.push({ row, col, input: "" })
			}
		}

		return cleared
	}

	function clear(): void {
		const cleared = filledIn(range)

		if (cleared.length > 0) {
			apply({ type: "setCells", sheet: sheetIndex, cells: cleared })
		}
	}

	function format(patch: FormatPatch): void {
		apply({ type: "format", sheet: sheetIndex, range, patch })
	}

	function handleGridKey(event: KeyboardEvent<HTMLDivElement>): boolean {
		const mod = event.ctrlKey || event.metaKey
		const key = event.key.toLowerCase()

		if (!canEdit) {
			return false
		}

		if (mod && !event.altKey) {
			const undo = key === "z" && !event.shiftKey
			const redo = (key === "z" && event.shiftKey) || key === "y"
			const property = doc.kind === "xlsx" && !event.shiftKey ? ({ b: "bold", i: "italic", u: "underline" } as const)[key] : undefined

			if (undo || redo) {
				event.preventDefault()
				void (undo ? edits.undo() : edits.redo())

				return true
			}

			if (property !== undefined) {
				event.preventDefault()
				format({ [property]: activeStyle?.[property] !== true })

				return true
			}

			return false
		}

		if (event.key === "Delete" || event.key === "Backspace") {
			event.preventDefault()
			clear()

			return true
		}

		if (event.key === "F2" || (event.key === "Enter" && !event.shiftKey)) {
			event.preventDefault()
			startEditing("cell", activeInput)

			return true
		}

		// An input method's key, or a dead key: an empty entry opens and takes focus before the key's
		// default runs, so what it composes lands in the entry. Best effort; browsers differ.
		if (isImeKeydown(event.nativeEvent) || event.key === "Dead") {
			flushSync(() => {
				startEditing("cell", "")
			})

			return true
		}

		// A character starts an entry that replaces the cell, as spreadsheets do.
		if (isTypedCharacter(event)) {
			event.preventDefault()
			startEditing("cell", event.key)

			return true
		}

		return false
	}

	function handleEditorKey(event: KeyboardEvent<HTMLInputElement>): void {
		if (isImeKeydown(event.nativeEvent)) {
			return
		}

		if (event.key === "Enter") {
			event.preventDefault()
			commit(event.shiftKey ? "up" : "down")
		} else if (event.key === "Tab") {
			event.preventDefault()
			commit(event.shiftKey ? "left" : "right")
		} else if (event.key === "Escape") {
			event.preventDefault()
			event.stopPropagation()
			cancel()
		}
	}

	function copyRange(event: ClipboardEvent): boolean {
		const text = rangeToTsv(sheet, range)

		event.preventDefault()

		if (text === null) {
			toast.error(t("previewSpreadsheetCopyTooLarge"))

			return false
		}

		event.clipboardData?.setData("text/plain", text)

		return true
	}

	function paste(event: ClipboardEvent): void {
		if (!canEdit) {
			return
		}

		event.preventDefault()

		const rows = parseTsv(event.clipboardData?.getData("text/plain") ?? "")
		const cells: { row: number; col: number; input: string }[] = []
		let width = 0

		for (const [rowOffset, values] of rows.entries()) {
			width = Math.max(width, values.length)

			for (const [colOffset, input] of values.entries()) {
				cells.push({ row: range.startRow + rowOffset, col: range.startCol + colOffset, input })
			}
		}

		if (cells.length > MAX_EDIT_CELLS) {
			toast.error(t("previewSpreadsheetTooLarge"))

			return
		}

		if (cells.length > 0) {
			apply({ type: "setCells", sheet: sheetIndex, cells })
			select({
				anchor: { row: range.startRow, col: range.startCol },
				focus: { row: range.startRow + rows.length - 1, col: range.startCol + Math.max(0, width - 1) }
			})
		}
	}

	// Clipboard events while the grid has focus. Listened for on the document: Firefox sends them to the
	// body when the focused element holds no text selection, as the grid never does. Each event reaches
	// the document once, wherever it was sent.
	function handleClipboard(event: ClipboardEvent): void {
		if (event.defaultPrevented || gridRef.current === null || document.activeElement !== gridRef.current) {
			return
		}

		switch (event.type) {
			case "copy":
				copyRange(event)
				break
			case "cut":
				if (canEdit && copyRange(event)) {
					clear()
				}

				break
			case "paste":
				paste(event)
				break
		}
	}

	async function save(): Promise<SpreadsheetSnapshot> {
		commit("none")

		return edits.snapshot()
	}

	useEffect(() => {
		onDirtyChange?.(dirty)
	}, [dirty, onDirtyChange])

	// Another sheet on show (a tab, or an undone "add sheet" taking the shown one away) starts at its top.
	const shownSheet = useRef(sheetIndex)

	useLayoutEffect(() => {
		if (shownSheet.current !== sheetIndex) {
			shownSheet.current = sheetIndex
			gridRef.current?.scrollTo({ top: 0, left: 0 })
		}
	}, [sheetIndex])

	// The latest handlers, for callers outside React's events.
	useEffect(() => {
		clipboardRef.current = handleClipboard

		if (wasEditable.current && !canEdit) {
			commit("none")
		}

		wasEditable.current = canEdit

		if (saveRef === undefined) {
			return undefined
		}

		saveRef.current = canEdit ? save : null

		return () => {
			saveRef.current = null
		}
	})

	useEffect(() => {
		function listener(event: ClipboardEvent): void {
			clipboardRef.current?.(event)
		}

		alive.current = true
		document.addEventListener("copy", listener)
		document.addEventListener("cut", listener)
		document.addEventListener("paste", listener)

		return () => {
			alive.current = false
			document.removeEventListener("copy", listener)
			document.removeEventListener("cut", listener)
			document.removeEventListener("paste", listener)
		}
	}, [])

	const rowsSelected = range.endRow - range.startRow + 1
	const colsSelected = range.endCol - range.startCol + 1
	const structureDisabled = sheet.structureLocked

	const grid = (
		<SheetGrid
			sheet={sheet}
			styles={doc.styles}
			selection={selection}
			onSelectionChange={next => {
				if (editing !== null) {
					commit("none")
				}

				select(next)
			}}
			label={sheet.name === "" ? alt : `${alt} – ${sheet.name}`}
			onKey={handleGridKey}
			onCellActivate={position => {
				if (canEdit) {
					const anchor = snapToMerge(position, sheet.merges)
					const view = sheet.cells.get(cellKey(anchor.row, anchor.col))

					setEditing({ row: anchor.row, col: anchor.col, text: view?.input ?? view?.text ?? "", from: "cell" })
				}
			}}
			gridRef={gridRef}
			editor={
				editing?.from === "cell"
					? {
							row: editing.row,
							col: editing.col,
							node: (
								<CellEditor
									label={t("previewSpreadsheetCellContents")}
									value={editing.text}
									onChange={text => {
										setEditing({ ...editing, text })
									}}
									onKeyDown={handleEditorKey}
									onBlur={event => {
										// Into the formula bar, the entry carries on there.
										if (event.relatedTarget !== barRef.current) {
											commit("none")
										}
									}}
								/>
							)
						}
					: null
			}
		/>
	)

	return (
		<div
			data-preview-surface
			className="flex size-full flex-col"
		>
			{toolbarShown ? (
				<FormatToolbar
					disabled={!canEdit}
					style={activeStyle}
					formats={doc.kind === "xlsx"}
					canUndo={edits.state.canUndo}
					canRedo={edits.state.canRedo}
					onUndo={() => {
						void edits.undo()
					}}
					onRedo={() => {
						void edits.redo()
					}}
					onFormat={format}
				/>
			) : null}
			<div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2 text-sm">
				<span
					aria-label={t("previewSpreadsheetSelectedCells")}
					className="w-24 shrink-0 truncate rounded-md bg-muted px-2 py-0.5 text-center font-mono text-xs tabular-nums"
				>
					{rangeName(range)}
				</span>
				{canEdit ? (
					<input
						ref={barRef}
						aria-label={t("previewSpreadsheetCellContents")}
						value={editing === null ? activeInput : editing.text}
						className="h-7 min-w-0 flex-1 rounded-md bg-transparent px-2 font-mono text-xs outline-none focus-visible:bg-muted/60"
						onFocus={() => {
							if (editing === null) {
								startEditing("bar", activeInput)
							} else {
								setEditing({ ...editing, from: "bar" })
							}
						}}
						onChange={event => {
							setEditing(prev => (prev === null ? null : { ...prev, text: event.target.value }))
						}}
						onKeyDown={handleEditorKey}
						onBlur={() => {
							if (editing?.from === "bar") {
								commit("none")
							}
						}}
					/>
				) : (
					<span
						aria-label={t("previewSpreadsheetCellContents")}
						className="min-w-0 flex-1 truncate font-mono text-xs"
					>
						{activeInput}
					</span>
				)}
				{readOnlyNote === null ? null : (
					<span
						role="status"
						title={readOnlyNote}
						className="max-w-1/2 shrink truncate text-xs text-muted-foreground"
					>
						{readOnlyNote}
					</span>
				)}
			</div>
			{/* One tree whether editable or not, so the grid (its scroll and focus) outlives a switch to read-only. */}
			<ContextMenu disabled={!canEdit}>
				<ContextMenuTrigger
					className="flex min-h-0 flex-1 flex-col"
					// Read-only, no menu at all: the browser's own offers nothing for a grid (no text selection
					// to copy; copying is mod+C).
					onContextMenu={event => {
						if (!canEdit) {
							event.preventDefault()
						}
					}}
				>
					{grid}
				</ContextMenuTrigger>
				<ContextMenuContent>
					<ContextMenuItem
						disabled={structureDisabled || !canEdit}
						onClick={() => {
							apply({ type: "insert", sheet: sheetIndex, axis: "rows", at: range.startRow, count: rowsSelected })
						}}
					>
						{t("previewSpreadsheetInsertRowsAbove", { count: rowsSelected })}
					</ContextMenuItem>
					<ContextMenuItem
						disabled={structureDisabled || !canEdit}
						onClick={() => {
							apply({ type: "insert", sheet: sheetIndex, axis: "rows", at: range.endRow + 1, count: rowsSelected })
						}}
					>
						{t("previewSpreadsheetInsertRowsBelow", { count: rowsSelected })}
					</ContextMenuItem>
					<ContextMenuItem
						disabled={structureDisabled || !canEdit}
						onClick={() => {
							apply({ type: "delete", sheet: sheetIndex, axis: "rows", at: range.startRow, count: rowsSelected })
						}}
					>
						{t("previewSpreadsheetDeleteRows", { count: rowsSelected })}
					</ContextMenuItem>
					<ContextMenuSeparator />
					<ContextMenuItem
						disabled={structureDisabled || !canEdit}
						onClick={() => {
							apply({ type: "insert", sheet: sheetIndex, axis: "cols", at: range.startCol, count: colsSelected })
						}}
					>
						{t("previewSpreadsheetInsertColumnsLeft", { count: colsSelected })}
					</ContextMenuItem>
					<ContextMenuItem
						disabled={structureDisabled || !canEdit}
						onClick={() => {
							apply({ type: "insert", sheet: sheetIndex, axis: "cols", at: range.endCol + 1, count: colsSelected })
						}}
					>
						{t("previewSpreadsheetInsertColumnsRight", { count: colsSelected })}
					</ContextMenuItem>
					<ContextMenuItem
						disabled={structureDisabled || !canEdit}
						onClick={() => {
							apply({ type: "delete", sheet: sheetIndex, axis: "cols", at: range.startCol, count: colsSelected })
						}}
					>
						{t("previewSpreadsheetDeleteColumns", { count: colsSelected })}
					</ContextMenuItem>
					<ContextMenuSeparator />
					<ContextMenuItem
						disabled={!canEdit}
						onClick={clear}
					>
						{t("previewSpreadsheetClearCells")}
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
			{doc.kind !== "csv" ? (
				<SheetTabs
					sheets={doc.sheets}
					active={sheetIndex}
					onSelect={index => {
						commit("none")
						setChosenSheet(index)
					}}
					onAdd={
						canEdit
							? () => {
									apply({
										type: "addSheet",
										name: t("previewSpreadsheetNewSheetName", { number: doc.sheets.length + 1 })
									})
								}
							: undefined
					}
					onRename={canEdit ? setRenaming : undefined}
				/>
			) : null}
			<InputDialog
				open={canEdit && renaming !== null}
				pending={false}
				title={t("previewSpreadsheetRenameSheet")}
				body={t("previewSpreadsheetRenameSheetBody")}
				label={t("previewSpreadsheetSheetName")}
				initialValue={renaming === null ? "" : (doc.sheets[renaming]?.name ?? "")}
				submitLabel={t("previewSpreadsheetRenameSheet")}
				validate={value => value.trim().length > 0}
				onOpenChange={open => {
					if (!open) {
						setRenaming(null)
					}
				}}
				onSubmit={value => {
					if (canEdit && renaming !== null) {
						apply({ type: "renameSheet", sheet: renaming, name: value })
					}

					setRenaming(null)
				}}
			/>
		</div>
	)
}

// A CSV, TSV or Excel file as a grid: every sheet, its cell formats, merged cells and frozen panes, and a
// selection copied as other spreadsheets paste it. Editable in the drive (an .xls, a file whose name has
// no spreadsheet extension, or one with parts a save could damage opens read-only): cells, formulas that
// recalculate, rows and columns, sheets, formats, undo. The file is parsed and edited in the spreadsheet
// worker, which keeps it (useSpreadsheetDoc, useSpreadsheetEdits); `saveRef` hands the overlay its bytes
// as edited.
function SpreadsheetViewer({
	item,
	documentKey,
	alt,
	editable,
	readOnlyReason,
	neverEditable,
	onDirtyChange,
	saveRef
}: SpreadsheetViewerProps) {
	const { t } = useTranslation("preview")
	const state = useSpreadsheetDoc(item, documentKey)

	switch (state.status) {
		case "pending":
			return (
				<LoadingState
					size="lg"
					className="text-inherit"
				/>
			)
		case "error":
			return (
				<PreviewErrorState
					message={errorLabel(state.dto)}
					onRetry={state.retry}
				/>
			)
		case "unreadable":
			return (
				<div className="flex size-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
					{t("previewSpreadsheetUnreadable")}
				</div>
			)
		case "ready":
			return state.doc.sheets.length === 0 ? (
				<div className="flex size-full items-center justify-center text-sm text-muted-foreground">
					{t("previewSpreadsheetEmpty")}
				</div>
			) : (
				<SpreadsheetBody
					key={state.id}
					id={state.id}
					initial={state.doc}
					alt={alt}
					editable={editable === true}
					unnamed={state.unnamed}
					renamed={state.renamed}
					readOnlyReason={readOnlyReason}
					neverEditable={neverEditable === true}
					onDirtyChange={onDirtyChange}
					saveRef={saveRef}
				/>
			)
	}
}

export default SpreadsheetViewer
