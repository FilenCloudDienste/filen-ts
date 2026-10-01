import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type RefObject } from "react"
import { flushSync } from "react-dom"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { type DriveItem } from "@/features/drive/lib/item"
import { stableUuidOf } from "@/features/drive/store/useDriveClipboardStore"
import { PreviewErrorState, PreviewLoading } from "@/features/preview/components/previewErrorState"
import { FormatToolbar } from "@/features/spreadsheet/components/formatToolbar"
import { SheetGrid } from "@/features/spreadsheet/components/sheetGrid"
import { SheetTabs } from "@/features/spreadsheet/components/sheetTabs"
import { useSizeLayer } from "@/features/spreadsheet/hooks/useSizeLayer"
import { useSpreadsheetDoc } from "@/features/spreadsheet/hooks/useSpreadsheetDoc"
import { useSpreadsheetEdits, useSpreadsheetWritability, type SpreadsheetSnapshot } from "@/features/spreadsheet/hooks/useSpreadsheetEdits"
import {
	rangeArea,
	rangeCols,
	rangeName,
	rangeRows,
	selectionRange,
	type CellPosition,
	type Selection
} from "@/features/spreadsheet/lib/cellRef.logic"
import { CellStore, type GridDoc, type GridSheet } from "@/features/spreadsheet/lib/cellStore.logic"
import {
	MAX_EDIT_CELLS,
	TOGGLE_FORMATS,
	toggledPatch,
	type EditOp,
	type EditResult,
	type FormatPatch
} from "@/features/spreadsheet/lib/edits"
import { clearedCells, newSheetName } from "@/features/spreadsheet/lib/gridEdits.logic"
import { cellKey, type CellRange } from "@/features/spreadsheet/lib/model"
import { gridMove, isTypedCharacter, sheetBounds, sheetCols, sheetRows, snapToMerge } from "@/features/spreadsheet/lib/navigation.logic"
import { layeredSheet, type LayerKey } from "@/features/spreadsheet/lib/sizeLayer"
import { layerKeyFor, resizable, sizesInFile } from "@/features/spreadsheet/lib/sizeRouting.logic"
import { resetTargets, type SizeAxis, type SizeEntry } from "@/features/spreadsheet/lib/sizes.logic"
import { endedCut, pastedCells, rangeToClip, rangeToTsv, type GridClip } from "@/features/spreadsheet/lib/tsv.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { isImeKeydown } from "@/lib/ime"
import { log } from "@/lib/log"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { saveAsXlsx } from "@/features/spreadsheet/lib/saveAsXlsx"

// The overlay's handle on the open file's bytes as edited, read when it saves: an open cell entry is
// committed first, and the bytes come after every edit already made. `commit` marks them saved once
// stored.
export type SpreadsheetSaveSource = () => Promise<SpreadsheetSnapshot>

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
	// Shows another file in this preview's place: the .xlsx an .xls was just saved as.
	onOpenFile?: (item: DriveItem) => void
	// A converted copy may be written beside this file (an .xls offers Save as .xlsx).
	canSaveCopy?: boolean
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
	tableHeader: "previewSpreadsheetTableHeader",
	encoding: "previewSpreadsheetEncodingUnsupported"
} as const satisfies Record<Extract<EditResult, { type: "refused" }>["reason"], string>

// The structural context-menu items, in menu order; a separator follows each axis's delete. `after`
// inserts past the selection's end rather than at its start.
const STRUCTURE_ITEMS = [
	{ key: "previewSpreadsheetInsertRowsAbove", type: "insert", axis: "rows", after: false },
	{ key: "previewSpreadsheetInsertRowsBelow", type: "insert", axis: "rows", after: true },
	{ key: "previewSpreadsheetDeleteRows", type: "delete", axis: "rows", after: false },
	{ key: "previewSpreadsheetInsertColumnsLeft", type: "insert", axis: "cols", after: false },
	{ key: "previewSpreadsheetInsertColumnsRight", type: "insert", axis: "cols", after: true },
	{ key: "previewSpreadsheetDeleteColumns", type: "delete", axis: "cols", after: false }
] as const

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
	saveRef,
	layerKey,
	onSaveAsXlsx
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
	layerKey: LayerKey
	// An .xls the user may write beside: converts it to an .xlsx next to it. Resolves once done or failed.
	onSaveAsXlsx: (() => Promise<void>) | undefined
}) {
	const { t } = useTranslation(["preview", "common"])
	// Loaded whatever the file: CSV shifts reach it from the edits below, and only an editable workbook,
	// which keeps its sizes in the file, leaves it unapplied.
	const local = useSizeLayer(layerKey)
	const edits = useSpreadsheetEdits(id, initial, (sheetAt, shift) => {
		local.follow(sheetAt, shift)
	})
	const doc = edits.doc
	// A file without a spreadsheet extension is never edited, whatever it may say.
	const writability = useSpreadsheetWritability(id, doc, editable && !unnamed, neverEditable || unnamed)
	const mayEdit = editable && !unnamed && !renamed
	const canEdit = mayEdit && writability === "writable"
	const inFile = sizesInFile(doc.kind, writability, canEdit)
	const canResize = resizable(doc.kind, writability, mayEdit)
	// Editing waits on the worker's proof: the toolbar holds its place meanwhile, disabled, and stays so
	// when the proof fails, so the grid never moves as the verdict lands.
	const toolbarShown = canEdit || (mayEdit && (writability === "checking" || doc.kind === "xlsx"))
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
	const shownNote = readOnlyNote ?? (doc.kind === "xls" ? t("previewSpreadsheetReadOnlyXls") : null)
	const [xlsxAsked, setXlsxAsked] = useState(false)
	const [xlsxSaving, setXlsxSaving] = useState(false)
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
	// The range last copied or cut here, while it holds entries its clipboard text does not.
	const clipRef = useRef<GridClip | null>(null)
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
	// The sheet as laid out: its own sizes, with the ones kept beside the file over them.
	const laidOutSheet = inFile ? sheet : layeredSheet(sheet, local.layer.get(sheetIndex))
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

	// Any change to the sheet ends a held cut; the cut's own clear restores it after.
	function endCut(): void {
		clipRef.current = endedCut(clipRef.current)
	}

	function apply(op: EditOp): void {
		endCut()
		edits.apply(op).then(report, () => {
			if (alive.current) {
				toast.error(t("previewSpreadsheetEditFailed"))
			}
		})
	}

	function history(undo: boolean): void {
		endCut()
		void (undo ? edits.undo() : edits.redo())
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
			{ ...sheetBounds(laidOutSheet, sheetRows(laidOutSheet).axis, sheetCols(laidOutSheet)), pageRows: 1 }
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

	// Whether the selection's cells are (being) emptied: false when there are too many for one edit.
	function clear(): boolean {
		const cleared = clearedCells(sheet.cells, range, MAX_EDIT_CELLS)

		if (cleared === null) {
			toast.error(t("previewSpreadsheetTooLarge"))

			return false
		}

		if (cleared.length > 0) {
			apply({ type: "setCells", sheet: sheetIndex, cells: cleared })
		}

		return true
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
			const toggle = doc.kind === "xlsx" && !event.shiftKey ? TOGGLE_FORMATS.find(entry => entry.shortcutKey === key) : undefined

			if (undo || redo) {
				event.preventDefault()
				history(undo)

				return true
			}

			if (toggle !== undefined) {
				event.preventDefault()
				format(toggledPatch(activeStyle, toggle.format))

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

	function copyRange(event: ClipboardEvent, cut: boolean): boolean {
		// Past what one edit takes, pasting it here is refused anyway: nothing is kept beside the text.
		const clip = rangeArea(range) <= MAX_EDIT_CELLS ? rangeToClip(sheet, range, cut) : null
		const text = clip?.tsv ?? rangeToTsv(sheet, range)

		event.preventDefault()

		if (text === null) {
			toast.error(t("previewSpreadsheetCopyTooLarge"))

			return false
		}

		event.clipboardData?.setData("text/plain", text)
		// Only worth keeping while a paste would write something other than the text.
		clipRef.current = clip !== null && clip.inputs.size > 0 ? clip : null

		return true
	}

	function paste(event: ClipboardEvent): void {
		if (!canEdit) {
			return
		}

		event.preventDefault()

		const text = event.clipboardData?.getData("text/plain") ?? ""
		const to = { row: range.startRow, col: range.startCol }

		// The clipboard moved on to something else.
		if (clipRef.current !== null && clipRef.current.tsv !== text) {
			clipRef.current = null
		}

		const block = pastedCells(text, clipRef.current, to, sheet.name, MAX_EDIT_CELLS)

		if (block === null) {
			toast.error(t("previewSpreadsheetTooLarge"))

			return
		}

		if (block.cells.length > 0) {
			apply({ type: "setCells", sheet: sheetIndex, cells: block.cells })
			select({
				anchor: to,
				focus: { row: to.row + block.rows - 1, col: to.col + Math.max(0, block.cols - 1) }
			})
		}

		clipRef.current = block.clip
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
				copyRange(event, false)
				break
			case "cut": {
				if (!canEdit || !copyRange(event, true)) {
					break
				}

				const cut = clipRef.current

				// Not emptied (too many cells): what was copied stays where it is, a copy.
				clipRef.current = clear() ? cut : endedCut(cut)

				break
			}
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

	const rowsSelected = rangeRows(range)
	const colsSelected = rangeCols(range)
	const structureDisabled = sheet.structureLocked

	// Into the file for an editable workbook (an undoable edit), beside it for everything else.
	function resize(axis: SizeAxis, sizes: readonly SizeEntry[]): Promise<void> {
		if (inFile) {
			return edits.apply({ type: "resize", sheet: sheetIndex, axis, sizes }).then(() => undefined)
		}

		local.update(sheetIndex, axis, sizes)

		return Promise.resolve()
	}

	const grid = (
		<SheetGrid
			sheet={laidOutSheet}
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
			{...(canResize ? { onResize: resize } : {})}
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
										// Into the formula bar, the entry carries on there. The window or tab losing
										// focus leaves it open: focus comes back to it.
										if (event.relatedTarget !== barRef.current && document.hasFocus()) {
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
						history(true)
					}}
					onRedo={() => {
						history(false)
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
							if (editing?.from === "bar" && document.hasFocus()) {
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
				{shownNote === null ? null : (
					<span
						role="status"
						title={shownNote}
						className="max-w-1/2 shrink truncate text-xs text-muted-foreground"
					>
						{shownNote}
					</span>
				)}
				{onSaveAsXlsx === undefined ? null : (
					<Button
						variant="outline"
						size="xs"
						className="shrink-0"
						onClick={() => {
							setXlsxAsked(true)
						}}
					>
						{t("previewSpreadsheetSaveAsXlsx")}
					</Button>
				)}
			</div>
			{/* One tree whether editable or not, so the grid (its scroll and focus) outlives a switch to read-only.
			Read-only, the menu holds only the size resets. */}
			<ContextMenu>
				<ContextMenuTrigger className="flex min-h-0 flex-1 flex-col">{grid}</ContextMenuTrigger>
				<ContextMenuContent>
					{canEdit ? (
						<>
							{STRUCTURE_ITEMS.map(item => {
								const rows = item.axis === "rows"
								const count = rows ? rowsSelected : colsSelected
								const start = rows ? range.startRow : range.startCol
								const at = item.after ? start + count : start

								return (
									<Fragment key={item.key}>
										<ContextMenuItem
											disabled={structureDisabled}
											onClick={() => {
												apply({ type: item.type, sheet: sheetIndex, axis: item.axis, at, count })
											}}
										>
											{t(item.key, { count })}
										</ContextMenuItem>
										{item.type === "delete" ? <ContextMenuSeparator /> : null}
									</Fragment>
								)
							})}
							<ContextMenuItem
								onClick={() => {
									clear()
								}}
							>
								{t("previewSpreadsheetClearCells")}
							</ContextMenuItem>
							<ContextMenuSeparator />
						</>
					) : null}
					<ResetSizeItems
						sheet={laidOutSheet}
						range={range}
						disabled={!canResize}
						onReset={(axis, entries) => {
							void resize(axis, entries)
						}}
					/>
				</ContextMenuContent>
			</ContextMenu>
			{onSaveAsXlsx === undefined ? null : (
				<ConfirmDialog
					open={xlsxAsked}
					pending={xlsxSaving}
					title={t("previewSpreadsheetSaveAsXlsxTitle")}
					body={t("previewSpreadsheetSaveAsXlsxBody")}
					confirmLabel={t("previewSpreadsheetSaveAsXlsx")}
					cancelLabel={t("common:cancel")}
					onOpenChange={setXlsxAsked}
					onConfirm={() => {
						setXlsxSaving(true)
						void onSaveAsXlsx().finally(() => {
							if (alive.current) {
								setXlsxSaving(false)
								setXlsxAsked(false)
							}
						})
					}}
				/>
			)}
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
										name: newSheetName(
											doc.sheets.map(shown => shown.name),
											number => t("previewSpreadsheetNewSheetName", { number })
										)
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

// The grid menu's size resets: the selected columns or rows back to the default size (in the file) or the
// file's own (beside it). Its own component so the targets are worked out only while the menu is open.
function ResetSizeItems({
	sheet,
	range,
	disabled,
	onReset
}: {
	sheet: GridSheet
	range: CellRange
	disabled: boolean
	onReset: (axis: SizeAxis, entries: SizeEntry[]) => void
}) {
	const { t } = useTranslation("preview")

	function entries(axis: SizeAxis): SizeEntry[] {
		const [start, end] = axis === "cols" ? [range.startCol, range.endCol] : [range.startRow, range.endRow]
		const hidden = new Set(axis === "cols" ? sheet.hiddenCols : sheet.hiddenRows)

		return resetTargets(start, end, axis === "cols" ? sheet.colCount : sheet.rowCount, index => hidden.has(index)).map(
			(index): SizeEntry => [index, null]
		)
	}

	const cols = entries("cols")
	const rows = entries("rows")

	return (
		<>
			<ContextMenuItem
				disabled={disabled || cols.length === 0}
				onClick={() => {
					onReset("cols", cols)
				}}
			>
				{t("previewSpreadsheetResetColumnWidth", { count: cols.length })}
			</ContextMenuItem>
			<ContextMenuItem
				disabled={disabled || rows.length === 0}
				onClick={() => {
					onReset("rows", rows)
				}}
			>
				{t("previewSpreadsheetResetRowHeight", { count: rows.length })}
			</ContextMenuItem>
		</>
	)
}

// A CSV, TSV or Excel file as a grid: every sheet, its cell formats, merged cells and frozen panes, and a
// selection copied as other spreadsheets paste it. Editable in the drive (an .xls, a file whose name has
// no spreadsheet extension, or one with parts a save could damage opens read-only): cells, formulas that
// recalculate, rows and columns, sheets, formats, undo. The file is parsed and edited in the spreadsheet
// worker, which keeps it (useSpreadsheetDoc, useSpreadsheetEdits); `saveRef` hands the overlay its bytes
// as edited.
export function SpreadsheetViewer({
	item,
	documentKey,
	alt,
	editable,
	readOnlyReason,
	neverEditable,
	onDirtyChange,
	saveRef,
	onOpenFile,
	canSaveCopy
}: SpreadsheetViewerProps) {
	const { t } = useTranslation("preview")
	const state = useSpreadsheetDoc(item, documentKey)

	switch (state.status) {
		case "pending":
			return <PreviewLoading />
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
					layerKey={layerKeyFor(stableUuidOf(item), documentKey)}
					onSaveAsXlsx={
						state.doc.kind === "xls" && canSaveCopy === true
							? async () => {
									const bytes = state.bytes
									const outcome = await saveAsXlsx(item, bytes).catch((e: unknown) => {
										log.error("spreadsheet", "saving an .xls as .xlsx failed", e)

										return { status: "error", dto: null } as const
									})

									if (outcome.status === "error") {
										toast.error(
											outcome.dto === null ? t("previewSpreadsheetSaveAsXlsxFailed") : errorLabel(outcome.dto)
										)

										return
									}

									toast.success(t("previewSpreadsheetSavedAsXlsx", { name: outcome.name }))
									onOpenFile?.(outcome.item)
								}
							: undefined
					}
				/>
			)
	}
}
