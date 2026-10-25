import { Fragment, useEffect, useRef, useState, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import {
	newSheetName,
	type LayerKey,
	type SheetAxis,
	type SheetCommand,
	type SheetFileKind,
	type SheetFormatPatch,
	type SheetId
} from "@filen/office/core/sheet"
import {
	MAX_FIT_INDICES,
	SheetGrid,
	autofitSizes,
	cellsEditable,
	celllessSheet,
	createSheetGrid,
	editingChanged,
	useSheetGrid,
	type SheetGridHandle,
	type SheetGridSizes,
	wholeAxis,
	type SheetShortcut
} from "@filen/office/react/sheet"
import { paneAfter } from "@/features/spreadsheet/components/sheetPanes"
import "@filen/office/css/sheet.css"
import "@/features/spreadsheet/sheetTheme.css"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { PasswordBadge } from "@/features/preview/components/docxToolbar"
import { useSizeLayer } from "@/features/spreadsheet/hooks/useSizeLayer"
import type { SpreadsheetSaveSource, SpreadsheetSnapshot } from "@/features/spreadsheet/save/sheetSave.logic"
import { assertSealedUpload } from "@/features/spreadsheet/lib/xlsxEncryption"
import { sayClipboardRefusal, useSheetClipboard } from "@/features/spreadsheet/clipboard/useSheetClipboard"
import { SheetFormulaBar } from "@/features/spreadsheet/components/sheetFormulaBar"
import { openSheetFind, stepSheetFind } from "@/features/spreadsheet/find/findState"
import { SheetAxisDialog, type SheetAxisDialogKind } from "@/features/spreadsheet/components/sheetAxisDialog"
import { SheetFindBar } from "@/features/spreadsheet/find/sheetFindBar"
import { SheetGridMenu } from "@/features/spreadsheet/components/sheetGridMenu"
import {
	extensionShortcut,
	gridExtensions,
	menuGroups,
	ribbonCommands,
	type SheetBodyExtension
} from "@/features/spreadsheet/components/sheetExtension"
import { selectionSpans } from "@/features/spreadsheet/menus/structure.logic"
import { structureShortcut } from "@/features/spreadsheet/menus/structureShortcuts"
import { useMergeCommands } from "@/features/spreadsheet/menus/useMergeCommands"
import { SheetModifyPassword } from "@/features/spreadsheet/menus/modifyPassword"
import { SheetTabs } from "@/features/spreadsheet/tabs/sheetTabs"
import type { SheetHandle } from "@/features/spreadsheet/hooks/useSheetSession"
import { isTextSheetKind } from "@/features/spreadsheet/lib/sheetHosts"
import { isLegacySheetKind } from "@/features/spreadsheet/lib/sheetKind"
import { saveAsXlsxBodyKey } from "@/features/spreadsheet/save/sheetSaveAs"
import { csvRefusalKey, readOnlyNoteKey, refusalKey } from "@/features/spreadsheet/lib/sheetMessages.logic"
import { SheetToolbar, type SheetRibbonActions } from "@/features/spreadsheet/toolbar/sheetToolbar"
import { borderShortcut, setFormatCellsOpen } from "@/features/spreadsheet/toolbar/formatCellsState"
import { downloadSheetCsv } from "@/features/spreadsheet/save/sheetCsv"
import { SheetFileMenu } from "@/features/spreadsheet/save/sheetFileMenu"
import { useSheetPdfExport } from "@/features/spreadsheet/save/useSheetPdfExport"
import { formOf, pdfFile, pdfRequest, printRequests } from "@/features/spreadsheet/print/print.logic"
import { sheetSettings } from "@/features/spreadsheet/print/printSettings"
import { browserLanguage } from "@/features/spreadsheet/formulaBar/sheetLocale"
import { usePreviewDownloadable } from "@/features/preview/lib/accessMode"
import { useSheetAutosave } from "@/features/spreadsheet/save/useSheetAutosave"
import { useSheetFill } from "@/features/spreadsheet/fill/useSheetFill"
import { useSheetObjects } from "@/features/spreadsheet/objects/useSheetObjects"
import { useSheetCharts } from "@/features/spreadsheet/charts/useSheetCharts"
import { useSheetAnnotations } from "@/features/spreadsheet/comments/useSheetAnnotations"
import { useSheetSortFilter } from "@/features/spreadsheet/data/filterExtension"
import { useSheetConditional } from "@/features/spreadsheet/data/cfExtension"
import { useSheetFormula } from "@/features/spreadsheet/formulaBar/useSheetFormula"
import { useSheetTouch } from "@/features/spreadsheet/touch/useSheetTouch"
import { useSheetPrint } from "@/features/spreadsheet/print/useSheetPrint"
import { commitForExport, liveConversion } from "@/features/spreadsheet/save/sheetConvert"
import { resolveTheme, useTheme } from "@/providers/themeProvider"
import { log } from "@/lib/log"

export interface SheetBodyProps {
	handle: SheetHandle
	kind: SheetFileKind
	alt: string
	// This user may write the file here (their drive, a writable share).
	editable: boolean
	unnamed: boolean
	renamed: boolean
	readOnlyReason: "renamed" | undefined
	// Nothing will ever edit this file here (a public link): the session lets go of what only a save needs.
	neverEditable: boolean
	onDirtyChange: ((dirty: boolean) => void) | undefined
	saveRef: RefObject<SpreadsheetSaveSource | null> | undefined
	// The author recommends read-only: reopens the file for editing.
	editAnyway: (() => void) | undefined
	// The workbook has a password to modify that was not given: called once it is.
	modifyLocked: (() => void) | undefined
	// Where the sizes kept beside the file live (a text file's, a view-only workbook's).
	layerKey: LayerKey
	// A text file or legacy workbook the user may write beside: saves it as an .xlsx next to it (a text file with its
	// edits). Resolves once done or failed.
	onSaveAsXlsx: (() => Promise<void>) | undefined
	// Idle autosave asks the overlay to save; true when a save started.
	onAutosave: (() => boolean) | undefined
	// A password-protected workbook as stored: its PDF asks for the password and is encrypted with it.
	encryptedFile?: Uint8Array | undefined
}

// The features whose menu groups are about a chartsheet's chart (the others' are about cells, which it has none of).
const CHARTSHEET_MENU_GROUPS: ReadonlySet<string> = new Set(["objects", "charts"])

// An open session as a grid, with the formula bar, the formatting toolbar, the sheet tabs and the grid's menu. The
// session holds the cells; the grid's model (react/sheet) holds what is on show and talks to the session.
export function SheetBody({
	handle,
	kind,
	alt,
	editable,
	unnamed,
	renamed,
	readOnlyReason,
	neverEditable,
	onDirtyChange,
	saveRef,
	editAnyway,
	modifyLocked,
	layerKey,
	onSaveAsXlsx,
	onAutosave,
	encryptedFile
}: SheetBodyProps) {
	const { t } = useTranslation(["preview", "common"])
	const downloadable = usePreviewDownloadable()
	const [model] = useState(() => createSheetGrid(handle))
	const grid = useSheetGrid(model)
	const { theme } = useTheme()
	// Sizes beside the file, for a session that cannot hold them (the grid decides when): the layer is kept by sheet
	// index, the grid names sheets by id.
	const sizeLayer = useSizeLayer(layerKey)
	const indexOf = (sheet: SheetId): number => grid.sheets.findIndex(entry => entry.id === sheet)
	const sizes: SheetGridSizes = {
		sizes: sheet => sizeLayer.layer.get(indexOf(sheet)),
		update: (sheet, axis, entries) => {
			const index = indexOf(sheet)

			if (index >= 0) {
				sizeLayer.update(index, axis, entries)
			}
		},
		follow: (sheet, shift) => {
			const index = indexOf(sheet)

			if (index >= 0) {
				sizeLayer.follow(index, shift)
			}
		}
	}
	const gridRef = useRef<SheetGridHandle>(null)
	const containerRef = useRef<HTMLDivElement>(null)
	const [xlsxAsked, setXlsxAsked] = useState(false)
	const [axisAsked, setAxisAsked] = useState<SheetAxisDialogKind | null>(null)
	const [xlsxSaving, setXlsxSaving] = useState(false)
	const text = isTextSheetKind(kind)
	const mayEdit = editable && !unnamed && !renamed && !neverEditable
	const canEdit = mayEdit && grid.writability.state !== "viewOnly" && grid.failed === null
	// A workbook that turns out read-only keeps the toolbar, disabled, so the grid never moves as the verdict lands.
	const toolbarShown = canEdit || (mayEdit && !text)
	const noteKey = readOnlyNoteKey({ editable, readOnlyReason, unnamed, renamed, writability: grid.writability, kind })
	const entryChanged = grid.editing !== null && editingChanged(grid.editing)
	const dirty = grid.state.dirty || entryChanged
	const shown = grid.sheets.find(sheet => sheet.id === grid.sheet)
	const sheetName = shown?.name ?? ""
	// A chartsheet or dialog sheet has no cells; a macro sheet's are shown, not edited (the session refuses both).
	const cellless = celllessSheet(grid)
	const cellsWritable = canEdit && cellsEditable(grid)

	useEffect(
		() =>
			handle.events.attach(event => {
				// A feature that cannot read its part beside a sheet (a damaged comments part) shows nothing there.
				if (event.type === "featureUnavailable") {
					log.warn("preview", "spreadsheet feature unavailable", event.feature, event.message)
				}

				model.handleEvent(event)
			}),
		[handle, model]
	)

	useEffect(() => {
		model.setReadOnly(!mayEdit)
	}, [model, mayEdit])

	useEffect(() => {
		// Nothing here will save it: the session lets go of what only a save needs.
		if (neverEditable || unnamed || grid.writability.state === "viewOnly") {
			handle.session.viewOnly()
		}
	}, [handle, neverEditable, unnamed, grid.writability.state])

	const merges = useMergeCommands(grid)
	const askMerge = merges.ask

	useEffect(() => {
		model.setRefusalHandler((refusal, command) => {
			// A merge repeated elsewhere (F4) asks about the values it would drop, as the menu's does.
			if (refusal.reason === "mergeLosesValues" && typeof command !== "string" && command.type === "merge.cells") {
				askMerge(command)

				return
			}

			// One toast per reason: edits queued behind a failing proof are all refused alike.
			toast.error(t(refusalKey(refusal, kind)), { id: refusal.reason })
		})

		return () => {
			model.setRefusalHandler(null)
		}
	}, [model, t, kind, askMerge])

	useEffect(() => {
		onDirtyChange?.(dirty)
	}, [dirty, onDirtyChange])

	useSheetAutosave({
		version: grid.state.version,
		dirty: grid.state.dirty,
		editing: grid.editing !== null,
		canSave: canEdit && saveRef !== undefined,
		onAutosave
	})

	const clipboard = useSheetClipboard({
		model,
		container: containerRef,
		canEdit,
		onRefused: reason => {
			toast.error(t(reason === "tooLarge" ? "previewSpreadsheetCopyTooLarge" : "previewSpreadsheetEditFailed"))
		}
	})

	function run(command: SheetCommand): void {
		void model.intent()
		void model.command(command)
	}

	function format(patch: SheetFormatPatch): void {
		run({ type: "format.apply", sheet: grid.sheet, ranges: grid.selection.ranges, patch })
	}

	// An open entry is committed first; the session saves after every edit already sent. A protected workbook's
	// save comes back sealed, and nothing else leaves it.
	async function save(): Promise<SpreadsheetSnapshot> {
		await model.commitEditing(null)

		const result = await handle.session.save()

		if (!result.ok) {
			throw new Error(`spreadsheet: the save failed (${result.reason}): ${result.message}`)
		}

		if (handle.info.encrypted !== undefined) {
			assertSealedUpload(result.bytes)
		}

		return {
			bytes: result.bytes,
			commit: () => {
				handle.session.markSaved(result.version).then(
					state => {
						model.apply({ state, patches: [], invalidated: [], layouts: [] })
					},
					() => undefined
				)
			}
		}
	}

	// Excel's "CSV UTF-8": the sheet on show, as each cell shows; a password-protected workbook's cells stay sealed.
	// Neither CSV nor PDF of a file that may not be downloaded.
	// An export stopped by a formula the sheet cannot read says so as the sheet does (one toast, however often asked).
	const sayInvalidEntry = (): void => {
		toast.error(t("previewSpreadsheetFormulaInvalid"), { id: "sheet-entry-invalid" })
	}
	const downloadCsv =
		downloadable && handle.info.encrypted === undefined && grid.failed === null
			? () => {
					const sheet = grid.sheets.find(entry => entry.id === grid.sheet)

					if (sheet === undefined) {
						return
					}

					void commitForExport(model, sayInvalidEntry)
						.then(done => (done ? downloadSheetCsv(handle, sheet, grid.sheets.length, alt) : null))
						.then(
							result => {
								if (result !== null && !result.ok) {
									toast.error(t(csvRefusalKey(result.refusal)))
								}
							},
							() => {
								toast.error(t("previewSheetDownloadCsvFailed"))
							}
						)
				}
			: undefined

	// The sheet on show as it prints (its print area and page setup), made in the worker beside the session; a
	// protected workbook's password is asked first.
	const pdf = useSheetPdfExport({
		session: handle.session,
		fileName: alt,
		encryptedFile,
		offered: downloadable && grid.failed === null
	})
	const workbookOf = () => ({ kind, sheets: grid.sheets, date1904: model.date1904, showFormulas: grid.showFormulas })
	const fileOf = () => pdfFile(alt, handle.info, browserLanguage())
	const startPdf = pdf.start
	const downloadPdf =
		startPdf !== undefined
			? () => {
					const sheet = grid.sheets.find(entry => entry.id === grid.sheet)

					if (sheet === undefined) {
						return
					}

					startPdf(async () => {
						if (!(await commitForExport(model, sayInvalidEntry))) {
							return null
						}

						const active = await sheetSettings(model, kind, sheet)

						if (active === null) {
							return null
						}

						const requests = printRequests(formOf(active.setup), active, [active], grid.selection.ranges) ?? []

						return pdfRequest(requests, fileOf(), workbookOf())
					})
				}
			: undefined

	useEffect(() => {
		if (saveRef === undefined) {
			return undefined
		}

		saveRef.current = canEdit ? save : null

		return () => {
			saveRef.current = null
		}
	})

	const annotations = useSheetAnnotations({ grid, gridRef, handle, canEdit: cellsWritable, text })
	const sortFilter = useSheetSortFilter({ grid, gridRef, handle, canEdit: cellsWritable, text, run })
	const conditional = useSheetConditional({ grid, model, gridRef, session: handle.session, canEdit: cellsWritable, text, run })
	const formula = useSheetFormula({ grid, gridRef, handle, canEdit: cellsWritable, run })
	const fill = useSheetFill({ grid, canEdit: cellsWritable, run })
	const touch = useSheetTouch({ grid, gridRef, canEdit: cellsWritable, clipboard })
	const print = useSheetPrint({
		grid,
		model,
		kind,
		name: alt,
		offered: downloadable,
		canEdit,
		run,
		onSavePdf:
			startPdf === undefined
				? undefined
				: requests => {
						startPdf(() => Promise.resolve(pdfRequest(requests, fileOf(), workbookOf())))
					}
	})
	const charts = useSheetCharts({ grid, gridRef, handle, canEdit, text })
	// Pictures, shapes and chart frames: their overlay goes first, under the other features' cards and popovers.
	const objects = useSheetObjects({
		grid,
		gridRef,
		handle,
		canEdit,
		text,
		renderChart: charts.renderChart,
		onEditObject: charts.onEditObject
	})
	// Features' parts of the view (sheetExtension.ts), in this order: their grid layers, overlays, menu groups,
	// dialogs and shortcuts (the first to take a pointer press or a shortcut has it). The touch menu is the last
	// overlay.
	const extensions: readonly SheetBodyExtension[] = [
		objects,
		charts.extension,
		annotations,
		sortFilter,
		conditional,
		formula,
		fill,
		{ id: "touch", overlay: touch.overlay },
		print.extension
	]

	// The grid's shortcuts only this view can do (react/sheet/keys.ts): Find and Replace (Mod+F, Mod+H, Shift+F4),
	// a new sheet (Shift+F11) and the insert and delete dialogs for cells; the features' own first. The rest the grid
	// does itself.
	function handleShortcut(shortcut: SheetShortcut): boolean {
		if (extensionShortcut(extensions, shortcut)) {
			return true
		}

		switch (shortcut) {
			case "find":
			case "replace":
				openSheetFind(model, shortcut === "replace" && canEdit ? "replace" : "find")

				return true
			case "findNext":
			case "findPrevious":
				stepSheetFind(model, shortcut === "findNext" ? 1 : -1)

				return true
			// Whole rows or columns the grid inserts and deletes itself; on cells, a dialog asks which.
			case "insertCells":
			case "deleteCells":
				if (wholeAxis(grid.selection) !== null) {
					return false
				}

				if (cellsWritable) {
					setAxisAsked(shortcut === "insertCells" ? "insert" : "delete")
				}

				return true
			case "formatCells":
				if (cellsWritable && !text) {
					setFormatCellsOpen(model, true)
				}

				return true
			case "borderOutline":
			case "borderNone":
				if (cellsWritable && !text) {
					run(borderShortcut(shortcut, grid.sheet, grid.selection.ranges))
				}

				return true
			case "newSheet":
				if (canEdit && !text) {
					run({
						type: "sheet.add",
						name: newSheetName(
							grid.sheets.map(sheet => sheet.name),
							number => t("previewSpreadsheetNewSheetName", { number })
						)
					})
				}

				return true
			// F6 and Shift+F6: the pane after the sheet (the chart editor when open) or before it, as Excel moves between
			// the worksheet and its panes.
			case "nextPane":
			case "previousPane": {
				const root = containerRef.current
				const cells = root?.querySelector(".fo-sheet-scroller") ?? null
				const target = root === null || cells === null ? null : paneAfter(root, cells, shortcut === "nextPane")

				target?.focus()

				return target !== null
			}
			// Shift+F10: the grid's menu, at the active cell.
			case "contextMenu": {
				const cells = containerRef.current?.querySelector(".fo-sheet-scroller")
				const active = grid.selection.active

				gridRef.current?.reveal(active)

				const box = gridRef.current?.clientRect(active)

				if (cells === null || cells === undefined || box === null || box === undefined) {
					return false
				}

				cells.dispatchEvent(
					new MouseEvent("contextmenu", {
						bubbles: true,
						cancelable: true,
						clientX: box.left + Math.min(box.width / 2, 16),
						clientY: box.top + Math.min(box.height / 2, 12)
					})
				)

				return true
			}
			// Not taken here: the key goes on to the preview's own Save (preview.save, Mod+S), the one save path, which
			// commits an open entry first and keeps the browser's Save Page As away whether or not there is a save.
			case "save":
				return false
			// Hide and unhide rows and columns (Ctrl+9, Ctrl+0, Ctrl+Shift+9, Ctrl+Shift+0); a text file has none.
			default:
				return structureShortcut(grid, shortcut, cellsWritable && !text)
		}
	}

	// Home ▸ Cells ▸ Format ▸ AutoFit: the selection's rows or columns as the grid measures them, as a header's double
	// click fits them.
	function autofit(axis: SheetAxis): void {
		const renderer = gridRef.current?.renderer
		const measurer = renderer?.measurerFor() ?? null

		if (renderer === undefined || measurer === null || !model.canResize()) {
			return
		}

		const sheet = grid.sheet
		const indices: number[] = []

		for (const span of selectionSpans(grid.selection.ranges, axis)) {
			for (let index = span.start; index <= span.end && indices.length < MAX_FIT_INDICES; index++) {
				indices.push(index)
			}
		}

		void autofitSizes(model, sheet, axis, indices, measurer, renderer.themeFont()).then(
			fitted => {
				if (fitted.indices.length > 0) {
					model.resize(sheet, axis, fitted.indices, fitted.sizes).catch(() => undefined)
				}
			},
			() => undefined
		)
	}

	const ribbonActions: SheetRibbonActions = {
		copy: cut => {
			void clipboard.copy(cut).then(result => {
				sayClipboardRefusal(result, cut ? "X" : "C", t)
			})
		},
		paste: values => {
			void clipboard.paste(values).then(result => {
				sayClipboardRefusal(result, "V", t)
			})
		},
		shortcut: shortcut => {
			handleShortcut(shortcut)
		},
		insertCells: () => {
			if (cellsWritable) {
				setAxisAsked("insert")
			}
		},
		deleteCells: () => {
			if (cellsWritable) {
				setAxisAsked("delete")
			}
		},
		autofit,
		commands: ribbonCommands(extensions)
	}
	const fileMenu = (
		<SheetFileMenu
			text={text}
			onDownloadCsv={downloadCsv}
			onDownloadPdf={downloadPdf}
			liveConversion={liveConversion(handle, kind, alt, () => commitForExport(model, sayInvalidEntry))}
			onPrint={print.open}
			onSaveAsXlsx={
				onSaveAsXlsx === undefined
					? undefined
					: () => {
							setXlsxAsked(true)
						}
			}
			autosave={canEdit && onAutosave !== undefined}
		/>
	)
	// The File menu has something to offer (SheetFileMenu shows nothing else).
	const fileOffered =
		downloadCsv !== undefined ||
		downloadPdf !== undefined ||
		print.open !== undefined ||
		onSaveAsXlsx !== undefined ||
		(canEdit && onAutosave !== undefined)

	return (
		<div
			ref={containerRef}
			data-preview-surface
			className="flex size-full flex-col"
			// F6 and Shift+F6 from anywhere in the view (the cells take theirs as shortcuts): the next or previous pane.
			onKeyDown={event => {
				if (event.key !== "F6" || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
					return
				}

				const target = paneAfter(event.currentTarget, event.target as Element, !event.shiftKey)

				if (target !== null) {
					event.preventDefault()
					target.focus()
				}
			}}
		>
			{toolbarShown || fileOffered ? (
				<div
					data-sheet-pane="toolbar"
					className="contents"
				>
					<SheetToolbar
						grid={grid}
						disabled={!canEdit}
						formats={!text}
						onFormat={format}
						actions={ribbonActions}
						viewOnly={!mayEdit}
						file={fileMenu}
						status={
							handle.info.encrypted === undefined ? null : (
								<PasswordBadge
									integrity={handle.info.encrypted}
									saving={canEdit}
								/>
							)
						}
					/>
				</div>
			) : null}
			<SheetFindBar
				grid={grid}
				gridRef={gridRef}
				canEdit={canEdit}
			/>
			<div
				data-sheet-pane="formula"
				className="contents"
			>
				<SheetFormulaBar
					grid={grid}
					gridRef={gridRef}
					canEdit={cellsWritable}
					formula={formula}
				>
					{grid.failed !== null ? (
						<span
							role="alert"
							className="max-w-1/2 shrink truncate text-xs text-destructive"
						>
							{t("previewSheetFailed")}
						</span>
					) : grid.editing?.invalid === true ? (
						<span
							role="alert"
							className="max-w-1/2 shrink truncate text-xs text-destructive"
						>
							{t("previewSpreadsheetFormulaInvalid")}
						</span>
					) : noteKey === null ? null : (
						<span
							role="status"
							title={t(noteKey)}
							className="max-w-1/2 shrink truncate text-xs text-muted-foreground"
						>
							{t(noteKey)}
						</span>
					)}
					{editAnyway !== undefined && editable && !unnamed && !renamed && !neverEditable ? (
						<Button
							variant="outline"
							size="xs"
							className="shrink-0"
							onClick={editAnyway}
						>
							{t("previewSheetEditAnyway")}
						</Button>
					) : null}
					{modifyLocked !== undefined && editable && !unnamed && !renamed && !neverEditable ? (
						<SheetModifyPassword
							session={handle.session}
							name={alt}
							onUnlock={modifyLocked}
						/>
					) : null}
					{/* The ribbon shows it when there is one. */}
					{handle.info.encrypted === undefined || toolbarShown || fileOffered ? null : (
						<PasswordBadge
							integrity={handle.info.encrypted}
							saving={canEdit}
						/>
					)}
					{/* A legacy workbook is only ever edited as its .xlsx: the way there is in plain sight. */}
					{onSaveAsXlsx === undefined || !isLegacySheetKind(kind) ? null : (
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
					{pdf.prompt}
				</SheetFormulaBar>
			</div>
			{/* The chart editor's side panel takes a column at the right; on a narrow screen it covers the grid's lower part. */}
			<div className="relative flex min-h-0 flex-1">
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					<SheetGridMenu
						grid={grid}
						canEdit={cellsWritable}
						run={run}
						text={text}
						items={menuGroups(cellless ? extensions.filter(extension => CHARTSHEET_MENU_GROUPS.has(extension.id)) : extensions)}
						onOpenChange={touch.onGridMenu}
						{...(text && { localPane: layerKey })}
					>
						{/* A finger's long press is the grid's own touch menu, not this menu's. */}
						<div
							data-sheet-pane="grid"
							className="flex min-h-0 flex-1 flex-col"
							{...touch.wrapper}
						>
							<SheetGrid
								ref={gridRef}
								grid={model}
								className="min-h-0 flex-1"
								label={sheetName === "" ? alt : `${alt} – ${sheetName}`}
								editorLabel={t("previewSheetCellEditor")}
								sizes={sizes}
								themeKey={resolveTheme(theme)}
								resizeLabel={(axis, px) =>
									t(axis === "cols" ? "previewSpreadsheetWidthPx" : "previewSpreadsheetHeightPx", { size: px })
								}
								describeCell={(cell, value) => (value === "" ? cell : t("previewSheetActiveCell", { cell, text: value }))}
								describeSelection={range => t("previewSheetRangeSelected", { range })}
								onTouchMenu={touch.onTouchMenu}
								onShortcut={handleShortcut}
								extensions={gridExtensions(extensions)}
							>
								{extensions.map(extension => (
									<Fragment key={extension.id}>{extension.overlay}</Fragment>
								))}
							</SheetGrid>
						</div>
					</SheetGridMenu>
				</div>
				{charts.panel === null ? null : (
					<div
						data-sheet-pane="panel"
						className="border-border max-sm:absolute max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-20 max-sm:h-[55%] max-sm:border-t sm:w-80 sm:shrink-0 sm:border-l"
					>
						{charts.panel}
					</div>
				)}
			</div>
			{extensions.map(extension => (
				<Fragment key={extension.id}>{extension.dialogs}</Fragment>
			))}
			{merges.dialog}
			<SheetAxisDialog
				kind={axisAsked}
				grid={grid}
				run={run}
				onClose={() => {
					setAxisAsked(null)
				}}
			/>
			{text ? null : (
				<div
					data-sheet-pane="tabs"
					className="contents"
				>
					<SheetTabs
						grid={grid}
						canEdit={canEdit}
						run={run}
					/>
				</div>
			)}
			{onSaveAsXlsx === undefined ? null : (
				<ConfirmDialog
					open={xlsxAsked}
					pending={xlsxSaving}
					title={t("previewSpreadsheetSaveAsXlsxTitle")}
					body={t(saveAsXlsxBodyKey(kind))}
					confirmLabel={t("previewSpreadsheetSaveAsXlsx")}
					cancelLabel={t("common:cancel")}
					onOpenChange={setXlsxAsked}
					onConfirm={() => {
						setXlsxSaving(true)
						// A text file's copy holds its edits: an open entry is committed first (one that does not read as
						// an entry stays open, and nothing is saved).
						void model
							.commitEditing(null)
							.then(done => (done ? onSaveAsXlsx() : undefined))
							.finally(() => {
								setXlsxSaving(false)
								setXlsxAsked(false)
							})
					}}
				/>
			)}
		</div>
	)
}
