import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import type { SheetCommand, SheetFileKind } from "@filen/office/core/sheet"
import type { SheetGridModel, SheetGridState } from "@filen/office/react/sheet"
import {
	layOutPrint,
	pageCount,
	PrintPageTooLarge,
	renderPrintPage,
	type PrintJob,
	type PrintSheetRequest
} from "@filen/office/react/sheet/print"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { isTextSheetKind } from "@/features/spreadsheet/lib/sheetHosts"
import { sheetSettings } from "@/features/spreadsheet/print/printSettings"
import {
	COMMON_PAPERS,
	MAX_BROWSER_PAGES,
	PAPER_KEYS,
	formOf,
	headerValues,
	patchOf,
	percentOf,
	printRequests,
	type PrintForm,
	scalingOf,
	type PrintScaling,
	type PrintScope,
	type PrintSheetSettings
} from "@/features/spreadsheet/print/print.logic"
import { canvasMeasure, printPages, renderPages, svgElement } from "@/features/spreadsheet/print/printRoot"
import type { PreviewKey } from "@/lib/i18n"
import { PrintDialogFrame } from "@/lib/print/printDialogFrame"
import { log } from "@/lib/log"

const SCOPES: readonly { readonly value: PrintScope; readonly key: PreviewKey }[] = [
	{ value: "sheet", key: "previewSheetPrintActiveSheet" },
	{ value: "workbook", key: "previewSheetPrintWorkbook" },
	{ value: "selection", key: "previewSheetPrintSelection" }
]

const SCALINGS: readonly { readonly value: PrintScaling; readonly key: PreviewKey }[] = [
	{ value: "none", key: "previewSheetPrintNoScaling" },
	{ value: "fitSheet", key: "previewSheetPrintFitSheet" },
	{ value: "fitColumns", key: "previewSheetPrintFitColumns" },
	{ value: "fitRows", key: "previewSheetPrintFitRows" },
	{ value: "custom", key: "previewSheetPrintCustomScale" }
]

interface WorkbookSettings {
	readonly sheets: readonly PrintSheetSettings[]
	// Visible sheets that do not print (chart sheets), by name.
	readonly skipped: readonly string[]
}

function PagePreview({ svg, label }: { svg: string | null; label: string }) {
	const ref = useRef<HTMLDivElement>(null)

	useEffect(() => {
		const element = ref.current

		if (element === null) {
			return
		}

		const page = svg === null ? null : svgElement(svg)

		if (page !== null) {
			page.setAttribute("width", "100%")
			page.removeAttribute("height")
		}

		element.replaceChildren(...(page === null ? [] : [page]))
	}, [svg])

	return (
		<div
			ref={ref}
			role="img"
			aria-label={label}
			className="w-full bg-white shadow-sm ring-1 ring-border [&>svg]:block [&>svg]:h-auto"
		/>
	)
}

export interface SheetPrintDialogProps {
	// The active sheet's settings as the dialog opened (it is mounted anew for each opening).
	active: PrintSheetSettings
	grid: SheetGridState
	model: SheetGridModel
	kind: SheetFileKind
	// The file's name, as &F prints it.
	name: string
	// The choices are written into the file (a workbook being edited).
	canSave: boolean
	run: (command: SheetCommand) => void
	// Saves the pages as a PDF instead of printing them (undefined: not offered).
	onSavePdf?: ((requests: readonly PrintSheetRequest[]) => void) | undefined
	onClose: () => void
}

// The print dialog: what prints (the active sheet, the workbook or the selection), paper, orientation, scaling,
// gridlines and headings, with the pages as they will print. The choices are saved into the active sheet's page setup
// when the file is edited here, then the browser prints the pages.
export function SheetPrintDialog({ active, grid, model, kind, name, canSave, run, onSavePdf, onClose }: SheetPrintDialogProps) {
	const { t } = useTranslation(["preview", "common"])
	const id = useId()
	const [form, setForm] = useState<PrintForm>(() => formOf(active.setup))
	const [workbook, setWorkbook] = useState<WorkbookSettings | null>(null)
	const [printed, setPrinted] = useState<PrintJob | null>(null)
	const [index, setIndex] = useState(0)
	// The page on show as drawn, or null where it holds too many cells to draw.
	const [preview, setPreview] = useState<{
		readonly printed: PrintJob
		readonly index: number
		readonly svg: string | null
	} | null>(null)
	const [progress, setProgress] = useState<{ done: number; pages: number } | null>(null)
	const [measure] = useState(() => (typeof document === "undefined" ? () => 0 : canvasMeasure()))
	const text = isTextSheetKind(kind)
	// Every sheet's settings, asked once when the workbook is first chosen.
	function loadWorkbook(): void {
		void Promise.all(
			grid.sheets.map(entry => (entry.id === active.sheet.id ? Promise.resolve(active) : sheetSettings(model, kind, entry)))
		).then(
			all => {
				const sheets: PrintSheetSettings[] = []
				const skipped: string[] = []

				all.forEach((settings, k) => {
					const entry = grid.sheets[k]

					if (settings !== null) {
						sheets.push(settings)
					} else if (entry?.state === "visible") {
						skipped.push(entry.name)
					}
				})

				setWorkbook({ sheets, skipped })
			},
			(error: unknown) => {
				log.warn("preview", "spreadsheet print settings failed", error)
				toast.error(t("previewSheetPrintFailed"))
			}
		)
	}

	const waiting = form.scope === "workbook" && workbook === null
	const selection = grid.selection.ranges

	// The pages, laid out again when the choices change.
	useEffect(() => {
		const requests = waiting ? null : printRequests(form, active, workbook?.sheets ?? [active], selection)

		if (requests === null) {
			return undefined
		}

		let live = true
		let current: PrintJob | null = null

		// Laid out only as far as a browser prints.
		void layOutPrint(model, requests, measure, MAX_BROWSER_PAGES).then(
			job => {
				if (live) {
					current = job
					setPrinted(job)
					setIndex(0)
				} else {
					job.dispose()
				}
			},
			(error: unknown) => {
				log.warn("preview", "spreadsheet print layout failed", error)

				if (live) {
					toast.error(t("previewSheetPrintFailed"))
				}
			}
		)

		// A print's pictures are lent for as long as its job stands.
		return () => {
			live = false
			current?.dispose()
		}
	}, [waiting, form, active, workbook, selection, model, measure, t])

	const pages = printed === null ? 0 : pageCount(printed)

	const shown = Math.min(index, Math.max(0, pages - 1))
	// The page on show, once drawn for the pages laid out now.
	const current = preview !== null && preview.printed === printed && preview.index === shown ? preview : null
	const svg = current?.svg ?? null
	const tooLarge = current !== null && current.svg === null

	useEffect(() => {
		if (printed === null || pages === 0) {
			return undefined
		}

		let live = true
		// A large page is drawn in slices: a page left for another stops at the next one.
		const signal = { aborted: false }

		void renderPrintPage({ job: printed, values: headerValues(name), id: `${id}-preview`, signal }, shown).then(
			markup => {
				if (live && markup !== null) {
					setPreview({ printed, index: shown, svg: markup })
				}
			},
			(error: unknown) => {
				if (error instanceof PrintPageTooLarge) {
					if (live) {
						setPreview({ printed, index: shown, svg: null })
					}

					return
				}

				if (signal.aborted) {
					return
				}

				log.warn("preview", "spreadsheet print preview failed", error)
			}
		)

		return () => {
			live = false
			signal.aborted = true
		}
	}, [printed, pages, shown, name, id])

	const percentInvalid = form.scaling === "custom" && percentOf(form.percent) === null
	const busy = progress !== null
	const change = (patch: Partial<PrintForm>): void => {
		if (patch.scope === "workbook" && workbook === null) {
			loadWorkbook()
		}

		setForm({ ...form, ...patch })
	}

	function print(): void {
		if (printed === null) {
			return
		}

		const patch = canSave && !text ? patchOf(active.setup, form) : null

		if (patch !== null) {
			run({ type: "print.setup", sheet: active.sheet.id, patch })
		}

		const total = Math.min(pages, MAX_BROWSER_PAGES)
		setProgress({ done: 0, pages: total })
		renderPages({ job: printed, values: headerValues(name), id: `${id}-print` }, total, done => {
			setProgress({ done, pages: total })
		}).then(
			async out => {
				// Closed once printed: the pages' pictures are the job's until then (the dialog is not printed).
				await printPages(out)
				onClose()
			},
			(error: unknown) => {
				if (error instanceof PrintPageTooLarge) {
					toast.error(t("previewSheetPrintPageTooLarge", { page: error.page }))
				} else {
					log.warn("preview", "spreadsheet print failed", error)
					toast.error(t("previewSheetPrintFailed"))
				}

				setProgress(null)
			}
		)
	}

	// The same pages as a PDF, made in the worker; the dialog closes, the toast counts.
	function savePdf(): void {
		const requests = printRequests(form, active, workbook?.sheets ?? [active], selection)

		if (requests === null || onSavePdf === undefined) {
			return
		}

		onSavePdf(requests)
		onClose()
	}

	const paperItems = [
		...(form.paperSize === 0 ? [{ value: "0", label: t("previewSheetPrintPaperCustom") }] : []),
		...(form.paperSize !== 0 && !COMMON_PAPERS.includes(form.paperSize)
			? [{ value: String(form.paperSize), label: t("previewSheetPrintPaperOther", { size: form.paperSize }) }]
			: []),
		...COMMON_PAPERS.map(size => ({ value: String(size), label: t(PAPER_KEYS.get(size) ?? "previewSheetPrintPaperLetter") }))
	]
	const scalingItems =
		scalingOf(active.setup) === "fitPages"
			? [
					...SCALINGS.map(item => ({ value: item.value, label: t(item.key) })),
					{
						value: "fitPages",
						label: t("previewSheetPrintFitPages", {
							wide: active.setup.fitToWidth === 0 ? t("previewSheetPrintFitAny") : active.setup.fitToWidth,
							tall: active.setup.fitToHeight === 0 ? t("previewSheetPrintFitAny") : active.setup.fitToHeight
						})
					}
				]
			: SCALINGS.map(item => ({ value: item.value, label: t(item.key) }))
	const cut = pages > MAX_BROWSER_PAGES || printed?.more === true

	return (
		<PrintDialogFrame
			title={t("previewSheetPrint")}
			description={t("previewSheetPrintDescription")}
			className="sm:max-w-3xl"
			busy={busy}
			canPrint={pages > 0 && !percentInvalid}
			printLabel={
				progress !== null
					? t("previewSheetPrintProgress", { done: progress.done, pages: progress.pages })
					: t("previewSheetPrintButton")
			}
			onPrint={() => {
				print()
			}}
			onClose={onClose}
			actions={
				onSavePdf !== undefined ? (
					<Button
						type="button"
						variant="outline"
						disabled={busy || pages === 0 || percentInvalid}
						onClick={() => {
							savePdf()
						}}
					>
						{t("previewSheetPrintSaveAsPdf")}
					</Button>
				) : null
			}
			aside={
				<div className="flex w-full flex-col items-center gap-2 sm:w-64">
					{printed === null ? (
						<p
							role="status"
							className="text-sm text-muted-foreground"
						>
							{t("previewSheetPrintPreparing")}
						</p>
					) : pages === 0 ? (
						<p
							role="status"
							className="text-sm text-muted-foreground"
						>
							{t("previewSheetPrintNothing")}
						</p>
					) : (
						<>
							{tooLarge ? (
								<p
									role="status"
									className="text-sm text-muted-foreground"
								>
									{t("previewSheetPrintPageTooLarge", { page: shown + 1 })}
								</p>
							) : (
								<PagePreview
									svg={svg}
									label={t("previewSheetPrintPreview")}
								/>
							)}
							<div className="flex items-center gap-1">
								<Button
									variant="ghost"
									size="icon-xs"
									aria-label={t("previewSheetPrintPreviousPage")}
									disabled={shown === 0}
									onClick={() => {
										setIndex(shown - 1)
									}}
								>
									<ChevronLeftIcon />
								</Button>
								<span
									className="text-xs text-muted-foreground tabular-nums"
									aria-live="polite"
								>
									{t("previewSheetPrintPageOf", { page: shown + 1, pages: cut ? `${String(pages)}+` : pages })}
								</span>
								<Button
									variant="ghost"
									size="icon-xs"
									aria-label={t("previewSheetPrintNextPage")}
									disabled={shown >= pages - 1}
									onClick={() => {
										setIndex(shown + 1)
									}}
								>
									<ChevronRightIcon />
								</Button>
							</div>
						</>
					)}
					{cut ? (
						<p className="text-xs text-destructive">
							{t("previewSheetPrintTooMany", { pages: Math.min(pages, MAX_BROWSER_PAGES) })}
						</p>
					) : null}
					{workbook !== null && workbook.skipped.length > 0 && form.scope === "workbook" ? (
						<p className="text-xs text-muted-foreground">
							{t("previewSheetPrintSkipped", { names: workbook.skipped.join(", ") })}
						</p>
					) : null}
				</div>
			}
		>
			<Field>
				<FieldLabel htmlFor={`${id}-what`}>{t("previewSheetPrintWhat")}</FieldLabel>
				<Select
					items={SCOPES.filter(item => !text || item.value !== "workbook").map(item => ({
						value: item.value,
						label: t(item.key)
					}))}
					value={form.scope}
					disabled={busy}
					onValueChange={(next: string | null) => {
						const found = SCOPES.find(item => item.value === next)

						if (found !== undefined) {
							change({ scope: found.value })
						}
					}}
				>
					<SelectTrigger id={`${id}-what`}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent data-preview-surface>
						<SelectGroup>
							{SCOPES.filter(item => !text || item.value !== "workbook").map(item => (
								<SelectItem
									key={item.value}
									value={item.value}
								>
									{t(item.key)}
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
			</Field>
			{text ? null : (
				<Field orientation="horizontal">
					<Switch
						id={`${id}-ignore`}
						checked={form.ignorePrintArea}
						disabled={busy || form.scope === "selection"}
						onCheckedChange={ignorePrintArea => {
							change({ ignorePrintArea })
						}}
					/>
					<FieldLabel htmlFor={`${id}-ignore`}>{t("previewSheetPrintIgnoreArea")}</FieldLabel>
				</Field>
			)}
			<Field>
				<FieldLabel htmlFor={`${id}-paper`}>{t("previewSheetPrintPaper")}</FieldLabel>
				<Select
					items={paperItems}
					value={String(form.paperSize)}
					disabled={busy}
					onValueChange={(next: string | null) => {
						if (next !== null) {
							change({ paperSize: Number(next) })
						}
					}}
				>
					<SelectTrigger id={`${id}-paper`}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent data-preview-surface>
						<SelectGroup>
							{paperItems.map(item => (
								<SelectItem
									key={item.value}
									value={item.value}
								>
									{item.label}
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
			</Field>
			<Field>
				<FieldLabel id={`${id}-orientation-label`}>{t("previewSheetPrintOrientation")}</FieldLabel>
				<RadioGroup
					aria-labelledby={`${id}-orientation-label`}
					name={`${id}-orientation`}
					value={form.orientation}
					disabled={busy}
					className="flex flex-wrap gap-x-5 gap-y-2"
					onValueChange={(next: unknown) => {
						if (next === "portrait" || next === "landscape") {
							change({ orientation: next })
						}
					}}
				>
					{(["portrait", "landscape"] as const).map(value => (
						<div
							key={value}
							className="flex items-center gap-2"
						>
							<RadioGroupItem
								id={`${id}-${value}`}
								value={value}
							/>
							<Label htmlFor={`${id}-${value}`}>
								{t(value === "portrait" ? "previewSheetPrintPortrait" : "previewSheetPrintLandscape")}
							</Label>
						</div>
					))}
				</RadioGroup>
			</Field>
			<Field>
				<FieldLabel htmlFor={`${id}-scaling`}>{t("previewSheetPrintScaling")}</FieldLabel>
				<Select
					items={scalingItems}
					value={form.scaling}
					disabled={busy}
					onValueChange={(next: string | null) => {
						const found = scalingItems.find(item => item.value === next)

						if (found !== undefined) {
							change({ scaling: found.value as PrintScaling })
						}
					}}
				>
					<SelectTrigger id={`${id}-scaling`}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent data-preview-surface>
						<SelectGroup>
							{scalingItems.map(item => (
								<SelectItem
									key={item.value}
									value={item.value}
								>
									{item.label}
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
			</Field>
			{form.scaling === "custom" ? (
				<Field data-invalid={percentInvalid}>
					<FieldLabel htmlFor={`${id}-percent`}>{t("previewSheetPrintScalePercent")}</FieldLabel>
					<Input
						id={`${id}-percent`}
						inputMode="numeric"
						autoComplete="off"
						value={form.percent}
						disabled={busy}
						aria-invalid={percentInvalid}
						onChange={event => {
							change({ percent: event.target.value })
						}}
					/>
					{percentInvalid ? <FieldError>{t("previewSheetPrintScaleInvalid")}</FieldError> : null}
				</Field>
			) : null}
			<Field orientation="horizontal">
				<Switch
					id={`${id}-gridlines`}
					checked={form.gridLines}
					disabled={busy}
					onCheckedChange={gridLines => {
						change({ gridLines })
					}}
				/>
				<FieldLabel htmlFor={`${id}-gridlines`}>{t("previewSheetPrintGridlines")}</FieldLabel>
			</Field>
			<Field orientation="horizontal">
				<Switch
					id={`${id}-headings`}
					checked={form.headings}
					disabled={busy}
					onCheckedChange={headings => {
						change({ headings })
					}}
				/>
				<FieldLabel htmlFor={`${id}-headings`}>{t("previewSheetPrintHeadings")}</FieldLabel>
			</Field>
			{canSave && !text ? null : <p className="text-xs text-muted-foreground">{t("previewSheetPrintNotSaved")}</p>}
		</PrintDialogFrame>
	)
}
