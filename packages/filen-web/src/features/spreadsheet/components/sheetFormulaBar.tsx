import { useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react"
import { flushSync } from "react-dom"
import { useTranslation } from "react-i18next"
import { HistoryIcon } from "lucide-react"
import { toast } from "sonner"
import { CellFlag, type SheetId, type SheetLayout, type SheetRange } from "@filen/office/core/sheet"
import { cellsEditable, celllessSheet, type SheetGridHandle, type SheetGridModel, type SheetGridState } from "@filen/office/react/sheet"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@filen/shared"
import { isImeKeydown } from "@filen/shared/keymap"
import {
	nameBoxNames,
	nameBoxSelection,
	nameBoxShown,
	parseNameBox,
	resolveNameBox,
	type NameBoxDefinedNames,
	type NameBoxTarget
} from "@/features/spreadsheet/lib/nameBox.logic"
import type { SheetFormulaExtension } from "@/features/spreadsheet/formulaBar/useSheetFormula"

// A sheet's layout once it is the one shown; null when another is shown first.
function shownLayout(model: SheetGridModel, sheet: SheetId): Promise<SheetLayout | null> {
	return new Promise(resolve => {
		function check(): boolean {
			const { sheet: shown, layout } = model.getSnapshot()

			if (shown !== sheet) {
				resolve(null)

				return true
			}

			if (layout !== null) {
				resolve(layout)

				return true
			}

			return false
		}

		if (check()) {
			return
		}

		const unsubscribe = model.subscribe(() => {
			if (check()) {
				unsubscribe()
			}
		})
	})
}

// The name box: the active cell's name, the workbook's names in its list, and where to go when one is typed (a cell,
// a range, whole rows or columns, on this sheet or another, or a defined name). A sheet without cells (a chartsheet)
// has neither: the box is empty and disabled.
function NameBox({ grid, gridRef }: { grid: SheetGridState; gridRef: RefObject<SheetGridHandle | null> }) {
	const { t } = useTranslation("preview")
	const listId = useId()
	const { selection, model } = grid
	const cellless = celllessSheet(grid)
	const shown = cellless ? "" : nameBoxShown(selection)
	// What is typed while the box has focus; null shows the selection.
	const [typed, setTyped] = useState<string | null>(null)
	// The workbook's names, asked for as the box takes focus (an edit elsewhere may have changed them).
	const [names, setNames] = useState<NameBoxDefinedNames | null>(null)
	const asked = useRef<Promise<NameBoxDefinedNames> | null>(null)
	const listed = typed === null || names === null ? [] : nameBoxNames(grid.sheet, grid.sheets, names)

	function askNames(): Promise<NameBoxDefinedNames> {
		const pending = model.session.query("names.list", {}).catch(() => [])

		asked.current = pending
		void pending.then(found => {
			if (asked.current === pending) {
				setNames(found)
			}
		})

		return pending
	}

	// Through choose: a protected sheet's cells that may not be selected stay unselected.
	function select(range: SheetRange, layout: SheetLayout): void {
		const next = nameBoxSelection(range, model.merges(layout))

		if (model.choose(next)) {
			gridRef.current?.reveal(next.active)
		}

		gridRef.current?.focus()
	}

	function goTo(target: NameBoxTarget | null, known: NameBoxDefinedNames): void {
		const { sheet, sheets, layout } = model.getSnapshot()
		const place = target === null ? null : resolveNameBox(target, sheet, sheets, known)

		if (place === null) {
			toast.error(t("previewSheetNameBoxInvalid"))

			return
		}

		// This sheet's layout is held: the selection is made at once.
		if (place.sheet === sheet && layout !== null) {
			select(place.range, layout)

			return
		}

		void (async () => {
			if (place.sheet !== sheet) {
				await model.showSheet(place.sheet)
			}

			const shownSheet = await shownLayout(model, place.sheet)

			if (shownSheet !== null) {
				select(place.range, shownSheet)
			}
		})()
	}

	function go(text: string): void {
		const target = parseNameBox(text)

		setTyped(null)

		if (target?.kind === "name") {
			void (asked.current ?? askNames()).then(known => {
				goTo(target, known)
			})
		} else {
			goTo(target, [])
		}
	}

	return (
		<>
			<input
				aria-label={t("previewSheetNameBox")}
				data-sheet-name-box=""
				value={typed ?? shown}
				disabled={cellless}
				spellCheck={false}
				autoComplete="off"
				list={listed.length === 0 ? undefined : listId}
				className="h-7 w-24 shrink-0 truncate rounded-md bg-muted px-2 text-center font-mono text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 pointer-coarse:text-base"
				onFocus={event => {
					setTyped(shown)
					void askNames()
					event.currentTarget.select()
				}}
				onChange={event => {
					const { value } = event.target
					const native = event.nativeEvent

					// A name picked from the list goes there at once, as in Excel's Name Box.
					if (native instanceof InputEvent && native.inputType === "insertReplacementText" && listed.includes(value)) {
						go(value)

						return
					}

					setTyped(value)
				}}
				onBlur={() => {
					setTyped(null)
				}}
				onKeyDown={event => {
					if (isImeKeydown(event.nativeEvent)) {
						return
					}

					if (event.key === "Enter") {
						event.preventDefault()
						go(typed ?? "")
					} else if (event.key === "Escape") {
						event.preventDefault()
						event.stopPropagation()
						setTyped(null)
						gridRef.current?.focus()
					}
				}}
			/>
			{listed.length === 0 ? null : (
				<datalist id={listId}>
					{listed.map(name => (
						<option
							key={name}
							value={name}
						/>
					))}
				</datalist>
			)}
		</>
	)
}

// The formula being typed with its references in their colours (useSheetFormula's coloredText), drawn under the
// bar's own text (which is clear while it shows): the same colours outline the cells they name. Kept in step with the
// field's scroll on both axes (an entry with line breaks scrolls a line at a time).
function ReferenceBackdrop({ colored, scroll }: { colored: ReactNode; scroll: BarScroll }) {
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 overflow-hidden px-2 font-mono text-xs leading-7 whitespace-pre pointer-coarse:text-base"
		>
			<div style={{ transform: `translate(${String(-scroll.left)}px, ${String(-scroll.top)}px)` }}>{colored}</div>
		</div>
	)
}

interface BarScroll {
	readonly left: number
	readonly top: number
}

const NO_SCROLL: BarScroll = { left: 0, top: 0 }

// The bar over the grid: the name box, AutoSum, the active cell's contents (editable as the in-cell editor is: both
// edit one entry), and what the viewer has to say beside them.
export function SheetFormulaBar({
	grid,
	gridRef,
	canEdit,
	formula,
	children
}: {
	grid: SheetGridState
	gridRef: RefObject<SheetGridHandle | null>
	canEdit: boolean
	// The formula typing extension (AutoSum's button, the references' colours); none for a view without it.
	formula?: SheetFormulaExtension
	children: ReactNode
}) {
	const { t } = useTranslation("preview")
	const { model, editing, active } = grid
	// A chartsheet's, dialog sheet's or macro sheet's cells are not edited.
	const editable = canEdit && cellsEditable(grid)
	const [scroll, setScroll] = useState(NO_SCROLL)
	const coloredText = editing === null ? null : (formula?.coloredText ?? null)
	const colored = coloredText !== null
	// A formula whose result this app does not calculate (a function it lacks, a name over a huge area, a legacy
	// array): the cell shows what the file saved, which an edit elsewhere does not update.
	const cached = editing === null && active.known && (active.flags & CellFlag.CACHED) !== 0

	// The entry's keys are the in-cell editor's (one handler for both). The bar opens the entry in edit mode, so the
	// arrows move the caret, as in Excel's formula bar.
	function handleKey(event: KeyboardEvent<HTMLTextAreaElement>): void {
		const handle = gridRef.current

		if (handle !== null) {
			handle.editorKey(event)
		} else if (event.key === "Enter" && !event.altKey && !isImeKeydown(event.nativeEvent)) {
			// Only Alt+Enter breaks the line.
			event.preventDefault()
		}
	}

	return (
		<div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2 text-sm">
			<NameBox
				grid={grid}
				gridRef={gridRef}
			/>
			{editable && formula !== undefined ? (
				<Button
					variant="ghost"
					size="icon-xs"
					className="shrink-0 font-semibold"
					aria-label={t("previewSheetAutoSum")}
					title={t("previewSheetAutoSum")}
					onClick={formula.autoSum}
				>
					Σ
				</Button>
			) : null}
			{editable ? (
				<div className="relative flex h-7 min-w-0 flex-1 rounded-md focus-within:bg-muted/60">
					{colored ? (
						<ReferenceBackdrop
							colored={coloredText}
							scroll={scroll}
						/>
					) : null}
					{/* A textarea: an input's value drops line breaks, which an edit here would then write to the cell. */}
					<textarea
						data-sheet-editor=""
						aria-label={t("previewSpreadsheetCellContents")}
						aria-invalid={editing?.invalid === true}
						value={editing === null ? active.input : editing.text}
						rows={1}
						wrap="off"
						spellCheck={false}
						autoComplete="off"
						className={cn(
							"relative h-7 min-w-0 flex-1 resize-none [scrollbar-width:none] overflow-auto bg-transparent px-2 py-0 font-mono text-xs leading-7 whitespace-pre outline-none aria-invalid:text-destructive pointer-coarse:text-base",
							colored && "text-transparent caret-foreground selection:text-transparent"
						)}
						onScroll={event => {
							const { scrollLeft: left, scrollTop: top } = event.currentTarget

							setScroll(previous => (previous.left === left && previous.top === top ? previous : { left, top }))
						}}
						onFocus={event => {
							if (editing !== null) {
								return
							}

							const bar = event.currentTarget

							// The in-cell editor takes focus as it appears; the entry is typed here, so focus comes back.
							flushSync(() => {
								model.startEditing(null, "edit")
							})
							bar.focus({ preventScroll: true })
						}}
						onChange={event => {
							model.setEditText(event.target.value)
						}}
						onKeyDown={handleKey}
						onBlur={event => {
							const related = event.relatedTarget

							if (related instanceof Element && related.closest("[data-sheet-editor]") !== null) {
								return
							}

							if (model.getSnapshot().editing !== null && document.hasFocus()) {
								void model.commitEditing(null)
							}
						}}
					/>
				</div>
			) : (
				<span
					aria-label={t("previewSpreadsheetCellContents")}
					className="min-w-0 flex-1 truncate font-mono text-xs"
				>
					{active.input}
				</span>
			)}
			{cached ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<span
								role="img"
								tabIndex={0}
								aria-label={t("previewSheetCachedResult")}
								className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<HistoryIcon className="size-3.5" />
							</span>
						}
					/>
					<TooltipContent>{t("previewSheetCachedResult")}</TooltipContent>
				</Tooltip>
			) : null}
			{children}
		</div>
	)
}
