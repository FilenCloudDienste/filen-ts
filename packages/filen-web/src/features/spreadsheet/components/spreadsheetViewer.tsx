import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { driveItemName } from "@filen/shared"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { extensionOf } from "@/features/drive/lib/preview.logic"
import { PreviewErrorState } from "@/features/preview/components/previewErrorState"
import { FormatToolbar } from "@/features/spreadsheet/components/formatToolbar"
import { SheetGrid } from "@/features/spreadsheet/components/sheetGrid"
import { SheetTabs } from "@/features/spreadsheet/components/sheetTabs"
import { useSpreadsheetDoc } from "@/features/spreadsheet/hooks/useSpreadsheetDoc"
import { useSpreadsheetEdits } from "@/features/spreadsheet/hooks/useSpreadsheetEdits"
import { rangeName, selectionRange, type CellPosition, type Selection } from "@/features/spreadsheet/lib/cellRef.logic"
import { MAX_EDIT_CELLS, type EditOp, type EditResult, type FormatPatch } from "@/features/spreadsheet/lib/edits"
import { cellKey, keyCol, keyRow, type CellRange, type SpreadsheetDoc } from "@/features/spreadsheet/lib/model"
import { spreadsheetFileKind, spreadsheetWorker } from "@/features/spreadsheet/lib/spreadsheetClient"
import { parseTsv, rangeToTsv } from "@/features/spreadsheet/lib/tsv.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { LoadingState } from "@/components/loadingState"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"

// The overlay's handle on the open file's bytes as edited, read when it saves.
export type SpreadsheetSaveSource = () => Promise<Uint8Array>

interface SpreadsheetViewerProps {
	item: DriveItem
	alt: string
	editable?: boolean
	onDirtyChange?: (dirty: boolean) => void
	saveRef?: RefObject<SpreadsheetSaveSource | null>
}

const ORIGIN: Selection = { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }

// The in-cell editor: it exists only while an entry is typed, so it takes focus as it appears, with the
// caret after what it starts from (the typed character, or the cell's content).
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
	onBlur: () => void
}) {
	const inputRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
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

type Move = "down" | "up" | "right" | "left" | "none"

interface Editing {
	row: number
	col: number
	text: string
	// Where the typing happens: in the cell, or in the formula bar.
	from: "cell" | "bar"
}

function moved(position: CellPosition, move: Move): CellPosition {
	switch (move) {
		case "down":
			return { row: position.row + 1, col: position.col }
		case "up":
			return { row: Math.max(0, position.row - 1), col: position.col }
		case "right":
			return { row: position.row, col: position.col + 1 }
		case "left":
			return { row: position.row, col: Math.max(0, position.col - 1) }
		case "none":
			return position
	}
}

function SpreadsheetBody({
	id,
	initial,
	alt,
	editable,
	onDirtyChange,
	saveRef
}: {
	id: number
	initial: SpreadsheetDoc
	alt: string
	editable: boolean
	onDirtyChange: ((dirty: boolean) => void) | undefined
	saveRef: RefObject<SpreadsheetSaveSource | null> | undefined
}) {
	const { t } = useTranslation("preview")
	const edits = useSpreadsheetEdits(id, initial)
	const doc = edits.doc
	const canEdit = editable && doc.writable
	const [sheetIndex, setSheetIndex] = useState(doc.activeSheet)
	// One selection per sheet, so switching tabs and back keeps each one's place.
	const [selections, setSelections] = useState<ReadonlyMap<number, Selection>>(() => new Map())
	const [editing, setEditing] = useState<Editing | null>(null)
	const [renaming, setRenaming] = useState<number | null>(null)
	// The entry last committed or cancelled. Finishing one moves focus, which blurs the input it was typed
	// in, and that blur's handler still sees the same entry: without this it would be committed again.
	const finished = useRef<Editing | null>(null)
	const gridRef = useRef<HTMLDivElement | null>(null)
	const sheet = doc.sheets[sheetIndex] ?? doc.sheets[0]
	const selection = selections.get(sheetIndex) ?? ORIGIN
	const range = selectionRange(selection)
	const active = sheet?.cells.get(cellKey(selection.focus.row, selection.focus.col))
	const activeInput = active?.input ?? active?.text ?? ""
	const activeStyle = active?.style === undefined ? undefined : doc.styles[active.style]
	const dirty = edits.state.dirty

	useEffect(() => {
		onDirtyChange?.(dirty)
	}, [dirty, onDirtyChange])

	useEffect(() => {
		if (saveRef === undefined) {
			return undefined
		}

		saveRef.current = canEdit ? () => spreadsheetWorker().serialize(id) : null

		return () => {
			saveRef.current = null
		}
	}, [saveRef, canEdit, id])

	if (sheet === undefined) {
		return (
			<div className="flex size-full items-center justify-center text-sm text-muted-foreground">{t("previewSpreadsheetEmpty")}</div>
		)
	}

	function select(next: Selection): void {
		setSelections(prev => new Map(prev).set(sheetIndex, next))
	}

	function focusGrid(): void {
		gridRef.current?.focus({ preventScroll: true })
	}

	function report(result: EditResult): void {
		if (result.type !== "refused") {
			return
		}

		toast.error(
			t(
				result.reason === "structureLocked"
					? "previewSpreadsheetStructureLocked"
					: result.reason === "sheetName"
						? "previewSpreadsheetSheetNameInvalid"
						: "previewSpreadsheetTooLarge"
			)
		)
	}

	function apply(op: EditOp): void {
		edits.apply(op).then(report, () => {
			toast.error(t("previewSpreadsheetEditFailed"))
		})
	}

	function startEditing(from: Editing["from"], text: string): void {
		if (!canEdit) {
			return
		}

		setEditing({ row: selection.focus.row, col: selection.focus.col, text, from })
	}

	function commit(move: Move): void {
		if (editing === null || finished.current === editing) {
			return
		}

		finished.current = editing

		const current = sheet?.cells.get(cellKey(editing.row, editing.col))

		if (editing.text !== (current?.input ?? current?.text ?? "")) {
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

	// The cells a clear touches: those in the range holding anything, so selecting whole columns costs what
	// the sheet holds, not what the columns could.
	function filledIn(target: CellRange): { row: number; col: number; input: string }[] {
		const cleared: { row: number; col: number; input: string }[] = []

		for (const key of sheet?.cells.keys() ?? []) {
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

		// A character starts an entry that replaces the cell, as spreadsheets do.
		if (event.key.length === 1 && !event.altKey) {
			event.preventDefault()
			startEditing("cell", event.key)

			return true
		}

		return false
	}

	function handleEditorKey(event: KeyboardEvent<HTMLInputElement>): void {
		if (event.nativeEvent.isComposing) {
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

	function copyRange(event: ClipboardEvent<HTMLDivElement>): boolean {
		if (sheet === undefined || event.target !== gridRef.current) {
			return false
		}

		const text = rangeToTsv(sheet, range)

		event.preventDefault()

		if (text === null) {
			toast.error(t("previewSpreadsheetCopyTooLarge"))

			return false
		}

		event.clipboardData.setData("text/plain", text)

		return true
	}

	function handlePaste(event: ClipboardEvent<HTMLDivElement>): void {
		if (!canEdit || event.target !== gridRef.current) {
			return
		}

		event.preventDefault()

		const rows = parseTsv(event.clipboardData.getData("text/plain"))
		const cells: { row: number; col: number; input: string }[] = []

		rows.forEach((values, rowOffset) => {
			values.forEach((input, colOffset) => {
				cells.push({ row: range.startRow + rowOffset, col: range.startCol + colOffset, input })
			})
		})

		if (cells.length > MAX_EDIT_CELLS) {
			toast.error(t("previewSpreadsheetTooLarge"))

			return
		}

		if (cells.length > 0) {
			apply({ type: "setCells", sheet: sheetIndex, cells })
			select({
				anchor: { row: range.startRow, col: range.startCol },
				focus: {
					row: range.startRow + rows.length - 1,
					col: range.startCol + Math.max(0, ...rows.map(values => values.length - 1))
				}
			})
		}
	}

	const rowsSelected = range.endRow - range.startRow + 1
	const colsSelected = range.endCol - range.startCol + 1
	const structureDisabled = sheet.structureLocked

	const grid = (
		<SheetGrid
			key={sheetIndex}
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
					const view = sheet.cells.get(cellKey(position.row, position.col))

					setEditing({ row: position.row, col: position.col, text: view?.input ?? view?.text ?? "", from: "cell" })
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
									onBlur={() => {
										commit("none")
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
			onCopy={copyRange}
			onCut={event => {
				if (canEdit && copyRange(event)) {
					clear()
				}
			}}
			onPaste={handlePaste}
		>
			{canEdit ? (
				<FormatToolbar
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
			</div>
			{canEdit ? (
				<ContextMenu>
					<ContextMenuTrigger className="flex min-h-0 flex-1 flex-col">{grid}</ContextMenuTrigger>
					<ContextMenuContent>
						<ContextMenuItem
							disabled={structureDisabled}
							onClick={() => {
								apply({ type: "insert", sheet: sheetIndex, axis: "rows", at: range.startRow, count: rowsSelected })
							}}
						>
							{t("previewSpreadsheetInsertRowsAbove", { count: rowsSelected })}
						</ContextMenuItem>
						<ContextMenuItem
							disabled={structureDisabled}
							onClick={() => {
								apply({ type: "insert", sheet: sheetIndex, axis: "rows", at: range.endRow + 1, count: rowsSelected })
							}}
						>
							{t("previewSpreadsheetInsertRowsBelow", { count: rowsSelected })}
						</ContextMenuItem>
						<ContextMenuItem
							disabled={structureDisabled}
							onClick={() => {
								apply({ type: "delete", sheet: sheetIndex, axis: "rows", at: range.startRow, count: rowsSelected })
							}}
						>
							{t("previewSpreadsheetDeleteRows", { count: rowsSelected })}
						</ContextMenuItem>
						<ContextMenuSeparator />
						<ContextMenuItem
							disabled={structureDisabled}
							onClick={() => {
								apply({ type: "insert", sheet: sheetIndex, axis: "cols", at: range.startCol, count: colsSelected })
							}}
						>
							{t("previewSpreadsheetInsertColumnsLeft", { count: colsSelected })}
						</ContextMenuItem>
						<ContextMenuItem
							disabled={structureDisabled}
							onClick={() => {
								apply({ type: "insert", sheet: sheetIndex, axis: "cols", at: range.endCol + 1, count: colsSelected })
							}}
						>
							{t("previewSpreadsheetInsertColumnsRight", { count: colsSelected })}
						</ContextMenuItem>
						<ContextMenuItem
							disabled={structureDisabled}
							onClick={() => {
								apply({ type: "delete", sheet: sheetIndex, axis: "cols", at: range.startCol, count: colsSelected })
							}}
						>
							{t("previewSpreadsheetDeleteColumns", { count: colsSelected })}
						</ContextMenuItem>
						<ContextMenuSeparator />
						<ContextMenuItem onClick={clear}>{t("previewSpreadsheetClearCells")}</ContextMenuItem>
					</ContextMenuContent>
				</ContextMenu>
			) : (
				grid
			)}
			{doc.kind !== "csv" ? (
				<SheetTabs
					sheets={doc.sheets}
					active={sheetIndex}
					onSelect={index => {
						setEditing(null)
						setSheetIndex(index)
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
				open={renaming !== null}
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
					if (renaming !== null) {
						apply({ type: "renameSheet", sheet: renaming, name: value })
					}

					setRenaming(null)
				}}
			/>
		</div>
	)
}

// A CSV, TSV or Excel file as a grid: every sheet, its cell formats, merged cells and frozen panes, and a
// selection copied as other spreadsheets paste it. Editable in the drive (an .xls opens read-only): cells,
// formulas that recalculate, rows and columns, sheets, formats, undo. The file is parsed and edited in the
// spreadsheet worker, which keeps it (useSpreadsheetDoc, useSpreadsheetEdits); `saveRef` hands the overlay
// its bytes as edited.
function SpreadsheetViewer({ item, alt, editable, onDirtyChange, saveRef }: SpreadsheetViewerProps) {
	const { t } = useTranslation("preview")
	const base = asDirectoryOrFile(item)
	const kind = spreadsheetFileKind(extensionOf(base.type === "file" ? driveItemName(base) : "")) ?? "csv"
	const state = useSpreadsheetDoc(item, kind)

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
			return (
				<SpreadsheetBody
					key={state.id}
					id={state.id}
					initial={state.doc}
					alt={alt}
					editable={editable === true}
					onDirtyChange={onDirtyChange}
					saveRef={saveRef}
				/>
			)
	}
}

export default SpreadsheetViewer
