import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { formatBytes } from "@filen/shared"
import { pageRangesCount } from "@filen/office/core/pdfedit/pageRanges"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import { printPdf } from "@/features/pdf/print/pdfPrint"
import {
	defaultPdfPrintForm,
	pdfPrintMemoryBytes,
	pdfPrintQualities,
	pdfPrintRanges,
	PDF_PRINT_DESKTOP_MAX_PIXELS,
	PDF_PRINT_DPI,
	PDF_PRINT_MEMORY_WARN_BYTES,
	PDF_PRINT_MOBILE_MAX_PIXELS,
	type PdfPrintForm,
	type PdfPrintPermissions
} from "@/features/pdf/print/pdfPrint.logic"
import { PDF_FULL_READ_WARN_BYTES } from "@/features/preview/lib/pdfLimits"
import { PrintDialogFrame } from "@/lib/print/printDialogFrame"
import { log } from "@/lib/log"

export interface PdfPrintDialogProps {
	document: PdfDomDocument
	// The page in view, 1-based.
	current: number
	// The file's bytes: printing every page of a large file reads all of it.
	size: number
	permissions: PdfPrintPermissions
	// A phone or tablet: Standard quality only, smaller canvases.
	constrained: boolean
	// Every page of a large file read: asked first (false cancels the print), and held while the print is prepared so the
	// viewer keeps the read document until it is done.
	fullRead: PdfPrintFullRead | undefined
	onClose: () => void
}

const PAGE_CHOICES = ["all", "current", "range"] as const

// The PDF's print dialog: which pages (all, the one in view, typed ranges), the quality, and whether annotations and
// form fields print, with a warning when the pages may need more memory than a browser allows. Mounted anew for each
// opening; the dialog stays open, its Print button counting, while the pages are prepared, then closes once the
// browser's print dialog closed.
export interface PdfPrintFullRead {
	confirm(): Promise<boolean>
	// Returns the release.
	hold(): () => void
}

export function PdfPrintDialog({ document, current, size, permissions, constrained, fullRead, onClose }: PdfPrintDialogProps) {
	const { t } = useTranslation("preview")
	const id = useId()
	const [form, setForm] = useState<PdfPrintForm>(defaultPdfPrintForm)
	const [progress, setProgress] = useState<{ readonly done: number; readonly pages: number } | null>(null)
	// The page in view's size in points: the memory estimate's measure.
	const [pageSize, setPageSize] = useState<{ readonly width: number; readonly height: number } | null>(null)
	const controller = useRef<AbortController | null>(null)
	const qualities = pdfPrintQualities(constrained, permissions)
	const quality = qualities.includes(form.quality) ? form.quality : "standard"
	const pageCount = document.numPages
	const ranges = pdfPrintRanges(form, pageCount, current)
	const count = ranges === null ? 0 : pageRangesCount(ranges)
	const maxPixels = constrained ? PDF_PRINT_MOBILE_MAX_PIXELS : PDF_PRINT_DESKTOP_MAX_PIXELS
	const memory = pageSize === null ? 0 : pdfPrintMemoryBytes(count, pageSize.width, pageSize.height, PDF_PRINT_DPI[quality], maxPixels)
	const busy = progress !== null
	const rangeInvalid = form.pages === "range" && form.range.trim().length > 0 && ranges === null

	useEffect(() => {
		let live = true

		void document.getPage(current).then(
			page => {
				const viewport = page.getViewport({ scale: 1 })

				if (live) {
					setPageSize({ width: viewport.width, height: viewport.height })
				}
			},
			(error: unknown) => {
				log.warn("preview", "pdf print page size failed", error)
			}
		)

		return () => {
			live = false
		}
	}, [document, current])

	// A print still being prepared stops with the dialog (the preview closed under it).
	useEffect(
		() => () => {
			controller.current?.abort()
		},
		[]
	)

	const change = (patch: Partial<PdfPrintForm>): void => {
		setForm({ ...form, ...patch })
	}

	const start = (): void => {
		if (ranges === null) {
			return
		}

		const job = new AbortController()
		const release = form.pages === "all" ? fullRead?.hold() : undefined

		controller.current = job
		setProgress({ done: 0, pages: count })
		printPdf({
			document,
			ranges,
			dpi: PDF_PRINT_DPI[quality],
			maxPixels,
			annotations: form.annotations,
			signal: job.signal,
			onProgress: (done, pages) => {
				setProgress({ done, pages })
			}
		}).then(
			() => {
				release?.()
				onClose()
			},
			(error: unknown) => {
				release?.()
				controller.current = null
				setProgress(null)

				if (job.signal.aborted) {
					return
				}

				log.warn("preview", "pdf print failed", error)
				toast.error(t("previewPdfPrintFailed"))
			}
		)
	}

	const print = (): void => {
		if (form.pages !== "all" || size <= PDF_FULL_READ_WARN_BYTES || fullRead === undefined) {
			start()

			return
		}

		void fullRead.confirm().then(confirmed => {
			if (confirmed) {
				start()
			}
		})
	}

	return (
		<PrintDialogFrame
			title={t("previewPdfPrintTitle")}
			description={t("previewPdfPrintDescription")}
			className="sm:max-w-md"
			busy={busy}
			canPrint={ranges !== null}
			printLabel={
				progress === null
					? t("previewPdfPrintButton")
					: t("previewPdfPrintProgress", { done: progress.done, pages: progress.pages })
			}
			onPrint={print}
			onCancelBusy={() => {
				controller.current?.abort()
			}}
			onClose={onClose}
		>
			<Field>
				<FieldLabel id={`${id}-pages-label`}>{t("previewPdfPrintPages")}</FieldLabel>
				<RadioGroup
					aria-labelledby={`${id}-pages-label`}
					name={`${id}-pages`}
					value={form.pages}
					disabled={busy}
					className="flex flex-col gap-2"
					onValueChange={(next: unknown) => {
						const found = PAGE_CHOICES.find(choice => choice === next)

						if (found !== undefined) {
							change({ pages: found })
						}
					}}
				>
					<div className="flex items-center gap-2">
						<RadioGroupItem
							id={`${id}-all`}
							value="all"
						/>
						<Label htmlFor={`${id}-all`}>{t("previewPdfPrintAll")}</Label>
					</div>
					<div className="flex items-center gap-2">
						<RadioGroupItem
							id={`${id}-current`}
							value="current"
						/>
						<Label htmlFor={`${id}-current`}>{t("previewPdfPrintCurrent", { page: current })}</Label>
					</div>
					<div className="flex items-center gap-2">
						<RadioGroupItem
							id={`${id}-range`}
							value="range"
						/>
						<Label htmlFor={`${id}-range`}>{t("previewPdfPrintRange")}</Label>
						<Input
							aria-label={t("previewPdfPrintRangeLabel")}
							aria-invalid={rangeInvalid}
							placeholder={t("previewPdfPrintRangePlaceholder")}
							autoComplete="off"
							spellCheck={false}
							className="h-8 min-w-0 flex-1 leading-5"
							value={form.range}
							disabled={busy}
							onChange={event => {
								change({ pages: "range", range: event.target.value })
							}}
						/>
					</div>
				</RadioGroup>
				{rangeInvalid ? <FieldError>{t("previewPdfPrintRangeInvalid", { last: pageCount })}</FieldError> : null}
			</Field>
			<Field>
				<FieldLabel id={`${id}-quality-label`}>{t("previewPdfPrintQuality")}</FieldLabel>
				<RadioGroup
					aria-labelledby={`${id}-quality-label`}
					name={`${id}-quality`}
					value={quality}
					disabled={busy}
					className="flex flex-wrap gap-x-5 gap-y-2"
					onValueChange={(next: unknown) => {
						const found = qualities.find(choice => choice === next)

						if (found !== undefined) {
							change({ quality: found })
						}
					}}
				>
					{qualities.map(value => (
						<div
							key={value}
							className="flex items-center gap-2"
						>
							<RadioGroupItem
								id={`${id}-${value}`}
								value={value}
							/>
							<Label htmlFor={`${id}-${value}`}>
								{t(value === "high" ? "previewPdfPrintHigh" : "previewPdfPrintStandard")}
							</Label>
						</div>
					))}
				</RadioGroup>
				{!constrained && !permissions.highQuality ? (
					<p className="text-xs text-muted-foreground">{t("previewPdfPrintHighRestricted")}</p>
				) : null}
			</Field>
			<Field orientation="horizontal">
				<Switch
					id={`${id}-annotations`}
					checked={form.annotations}
					disabled={busy}
					onCheckedChange={annotations => {
						change({ annotations })
					}}
				/>
				<FieldLabel htmlFor={`${id}-annotations`}>{t("previewPdfPrintAnnotations")}</FieldLabel>
			</Field>
			{memory > PDF_PRINT_MEMORY_WARN_BYTES ? (
				<p
					role="status"
					className="text-xs text-destructive"
				>
					{t("previewPdfPrintMemory", { count, size: formatBytes(memory) })}
				</p>
			) : null}
		</PrintDialogFrame>
	)
}
