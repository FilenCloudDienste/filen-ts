import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { chartWorkbookOp, type ShapeRef } from "@filen/office/core/presentation"
import { createSheetGrid, editingChanged, SheetGrid, useSheetGrid, type SheetGridModel } from "@filen/office/react/sheet"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { openSheet } from "@/features/spreadsheet/lib/sheetHosts"
import { SheetEventRelay } from "@/features/spreadsheet/lib/sheetEvents"
import { withWorkbookDigit } from "@/features/spreadsheet/lib/sheetDigitWidth"
import type { SheetHandle } from "@/features/spreadsheet/hooks/useSheetSession"
import { log } from "@/lib/log"
import { resolveTheme, useTheme } from "@/providers/themeProvider"
import "@filen/office/css/sheet.css"
import "@/features/spreadsheet/sheetTheme.css"

// Edit Data: the chart's data opened as a workbook in the sheet worker (the spreadsheet editor's own engine and grid)
// and handed back whole on Apply, one op (setWorkbook) whose apply refreshes the chart's caches from its cells. The
// presentation worker hands the data over (dom/presentation chartData): a pptx chart's embedded workbook, or an ODP
// chart's own table as a one-sheet workbook. An embedded Excel 97–2003 workbook opens through the spreadsheet's
// legacy conversion and is saved as an .xlsx part on Apply, which the dialog says first.

type Opened =
	| { readonly status: "loading" }
	| { readonly status: "failed" }
	| { readonly status: "ready"; readonly handle: SheetHandle; readonly model: SheetGridModel; readonly converted: boolean }

function opened(result: Awaited<ReturnType<typeof openSheet>>): Extract<Awaited<ReturnType<typeof openSheet>>, { kind: "opened" }> {
	if (result.kind !== "opened") {
		if (result.kind === "needsPassword") result.locked.dispose()

		throw new Error(`the chart's workbook did not open (${result.kind})`)
	}

	return result
}

// The chart's data as an editable .xlsx session: an .xls is opened (view-only, from its conversion) and saved as the
// .xlsx it was converted to, which then opens for editing.
async function openChartData(
	editor: PresentationRibbonEditor,
	target: ShapeRef,
	signal: AbortSignal
): Promise<{ readonly handle: SheetHandle; readonly converted: boolean }> {
	const data = await editor.session.chartData(target, { workbook: true })
	const workbook = data.workbook

	if (workbook === undefined) throw new Error("the chart has no workbook")

	let bytes = workbook.bytes

	if (workbook.kind === "xls") {
		const legacy = opened(await openSheet(bytes.slice(), { kind: "xls", signal }, () => undefined))

		try {
			const saved = await legacy.session.save()

			if (!saved.ok) throw new Error(`the .xls did not convert (${saved.reason})`)

			bytes = saved.bytes
		} finally {
			legacy.session.close()
		}
	}

	const events = new SheetEventRelay()
	const result = opened(await openSheet(bytes, { kind: "xlsx", signal }, events.emit))
	const measured = await withWorkbookDigit(result, events).catch(() => result)

	return { handle: { ...measured, events }, converted: workbook.kind === "xls" }
}

// Whether the grid holds anything Apply would hand the chart: an edit made, or an open cell entry changed. Read at
// dismissal, never subscribed to.
function edited(model: SheetGridModel): boolean {
	const snapshot = model.getSnapshot()

	return snapshot.state.dirty || (snapshot.editing !== null && editingChanged(snapshot.editing))
}

function ChartDataGrid({ model }: { model: SheetGridModel }) {
	const { t } = useTranslation("preview")
	const { theme } = useTheme()

	useSheetGrid(model)

	return (
		<SheetGrid
			grid={model}
			className="min-h-0 flex-1"
			label={t("previewPptxChartDataGrid")}
			editorLabel={t("previewPptxChartDataEditor")}
			themeKey={resolveTheme(theme)}
			describeCell={(cell, value) => (value === "" ? cell : t("previewSheetActiveCell", { cell, text: value }))}
			describeSelection={range => t("previewSheetRangeSelected", { range })}
		/>
	)
}

export function ChartDataDialog({ editor, target, onClose }: { editor: PresentationRibbonEditor; target: ShapeRef; onClose: () => void }) {
	const { t } = useTranslation(["preview", "common"])
	const [state, setState] = useState<Opened>({ status: "loading" })
	const [applying, setApplying] = useState(false)
	const [discarding, setDiscarding] = useState(false)
	// Bumped by Retry: opens the chart's data again after it failed.
	const [attempt, setAttempt] = useState(0)

	useEffect(() => {
		const leaving = new AbortController()
		let handle: SheetHandle | undefined

		openChartData(editor, target, leaving.signal).then(
			result => {
				if (leaving.signal.aborted) {
					result.handle.session.close()

					return
				}

				handle = result.handle
				setState({ status: "ready", handle: result.handle, model: createSheetGrid(result.handle), converted: result.converted })
			},
			(error: unknown) => {
				if (leaving.signal.aborted) return

				log.error("presentation", "opening a chart's data failed", error)
				setState({ status: "failed" })
			}
		)

		return () => {
			leaving.abort()
			handle?.session.close()
		}
	}, [editor, target, attempt])

	async function apply(): Promise<void> {
		if (state.status !== "ready" || applying) return

		setApplying(true)

		try {
			await state.model.commitEditing(null)

			const saved = await state.handle.session.save()

			if (!saved.ok) throw new Error(`the chart's workbook did not save (${saved.reason})`)

			const result = await editor.command(chartWorkbookOp(target, saved.bytes))

			if (result.ok) {
				onClose()

				return
			}

			toast.error(t("previewPptxChartDataApplyFailed"))
		} catch (error) {
			log.error("presentation", "applying a chart's data failed", error)
			toast.error(t("previewPptxChartDataApplyFailed"))
		} finally {
			setApplying(false)
		}
	}

	return (
		<Dialog
			open
			// Only Escape, Cancel and the close button dismiss: a stray click beside the grid loses no typed data.
			disablePointerDismissal
			onOpenChange={(open, details) => {
				if (open) return

				if (applying) {
					details.cancel()

					return
				}

				// Escape or the close button with edits made asks first; Cancel is explicit and closes at once.
				if (state.status === "ready" && edited(state.model)) {
					details.cancel()
					setDiscarding(true)

					return
				}

				onClose()
			}}
		>
			<DialogContent
				data-preview-surface
				closeButtonDisabled={applying}
				className="flex h-[min(36rem,calc(100dvh-2rem))] flex-col gap-4 sm:max-w-3xl"
			>
				<DialogHeader>
					<DialogTitle>{t("previewPptxChartDataTitle")}</DialogTitle>
					<DialogDescription>{t("previewPptxChartDataDescription")}</DialogDescription>
				</DialogHeader>
				{state.status === "ready" && state.converted ? (
					<p className="text-sm text-muted-foreground">{t("previewPptxChartDataConverted")}</p>
				) : null}
				<div className="fo-sheet flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border">
					{state.status === "ready" ? (
						<ChartDataGrid model={state.model} />
					) : (
						<div
							role="status"
							className="flex flex-1 items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground"
						>
							{state.status === "loading" ? (
								<>
									<Spinner />
									{t("previewPptxChartDataLoading")}
								</>
							) : (
								<>
									{t("previewPptxChartDataFailed")}
									<Button
										variant="outline"
										size="sm"
										onClick={() => {
											setState({ status: "loading" })
											setAttempt(previous => previous + 1)
										}}
									>
										{t("common:tryAgain")}
									</Button>
								</>
							)}
						</div>
					)}
				</div>
				<DialogFooter>
					<Button
						variant="outline"
						disabled={applying}
						onClick={onClose}
					>
						{t("common:cancel")}
					</Button>
					<Button
						disabled={state.status !== "ready" || applying}
						onClick={() => {
							void apply()
						}}
					>
						{applying ? <Spinner /> : null}
						{t("previewPptxChartDataApply")}
					</Button>
				</DialogFooter>
			</DialogContent>
			<ConfirmDialog
				open={discarding}
				pending={false}
				destructive
				title={t("previewPptxChartDataDiscardTitle")}
				body={t("previewPptxChartDataDiscardBody")}
				confirmLabel={t("previewDiscardAction")}
				cancelLabel={t("common:cancel")}
				onOpenChange={setDiscarding}
				onConfirm={() => {
					setDiscarding(false)
					onClose()
				}}
			/>
		</Dialog>
	)
}
