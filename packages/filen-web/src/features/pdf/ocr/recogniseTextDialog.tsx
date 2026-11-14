import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { formatBytes } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { OcrLanguagePicker } from "@/features/pdf/ocr/ocrLanguagePicker"
import type { OcrLanguage } from "@/features/pdf/ocr/languages"
import {
	DEFAULT_OCR_PAGES_FORM,
	ocrChosenPages,
	settledCount,
	type OcrDialogRun,
	type OcrPageState,
	type OcrPagesForm
} from "@/features/pdf/ocr/recogniseText.logic"

export interface RecogniseTextDialogProps {
	pageCount: number
	// The scanned pages, 0-based (isOcrCandidate): only they are recognised.
	scanned: readonly number[]
	languages: readonly OcrLanguage[]
	// What starting costs in downloads (the picked languages' models not on this device yet), in bytes.
	downloadBytes: number
	// Null until started.
	run: OcrDialogRun | null
	onLanguagesChange: (languages: OcrLanguage[]) => void
	// The scanned pages chosen, 0-based.
	onStart: (pages: number[]) => void
	onCancel: () => void
	onClose: () => void
}

const PAGE_CHOICES = ["all", "range"] as const

function PageRow({ state }: { state: OcrPageState }) {
	const { t } = useTranslation("preview")
	const status =
		state.status === "waiting"
			? t("previewPdfOcrPageWaiting")
			: state.status === "working"
				? t("previewPdfOcrPageWorking")
				: state.status === "done"
					? t("previewPdfOcrPageWords", { count: state.words })
					: t("previewPdfOcrPageFailed")

	return (
		<li className="flex items-center justify-between gap-3 py-1 text-sm">
			<span>{t("previewPdfOcrPage", { page: state.page + 1 })}</span>
			<span className={state.status === "failed" ? "text-destructive" : "text-muted-foreground"}>{status}</span>
		</li>
	)
}

function RunProgress({ run }: { run: Exclude<OcrDialogRun, { phase: "modelsFailed" }> }) {
	const { t } = useTranslation("preview")

	if (run.phase === "downloading") {
		const percent = run.total > 0 ? Math.floor((run.loaded / run.total) * 100) : 0

		return (
			<Progress
				value={percent}
				aria-label={t("previewPdfOcrDownloading", { percent })}
			>
				<span className="text-sm text-muted-foreground">{t("previewPdfOcrDownloading", { percent })}</span>
			</Progress>
		)
	}

	const done = settledCount(run.pages)
	const failed = run.pages.filter(state => state.status === "failed").length
	const searchable = run.pages.filter(state => state.status === "done").length

	return (
		<div className="flex flex-col gap-3">
			{run.phase === "recognising" ? (
				<Progress
					value={run.pages.length > 0 ? Math.floor((done / run.pages.length) * 100) : 0}
					aria-label={t("previewPdfOcrProgress", { done, pages: run.pages.length })}
				>
					<span className="text-sm text-muted-foreground">{t("previewPdfOcrProgress", { done, pages: run.pages.length })}</span>
				</Progress>
			) : (
				<div
					role="status"
					className="flex flex-col gap-1 text-sm"
				>
					{run.cancelled ? <p>{t("previewPdfOcrCancelled")}</p> : null}
					<p>{t("previewPdfOcrDone", { count: searchable })}</p>
					{failed > 0 ? <p className="text-destructive">{t("previewPdfOcrFailed", { count: failed })}</p> : null}
				</div>
			)}
			<ul className="max-h-48 divide-y overflow-y-auto">
				{run.pages.map(state => (
					<PageRow
						key={state.page}
						state={state}
					/>
				))}
			</ul>
		</div>
	)
}

// Tools › Recognise text: which pages (all, or typed ranges; only the scanned ones among them), the languages, the
// one-time download, then each page's progress with Cancel, and what failed. Mounted anew for each opening; the
// host runs recognition (ocrRun.ts) and feeds `run`.
export function RecogniseTextDialog({
	pageCount,
	scanned,
	languages,
	downloadBytes,
	run,
	onLanguagesChange,
	onStart,
	onCancel,
	onClose
}: RecogniseTextDialogProps) {
	const { t } = useTranslation(["preview", "common"])
	const id = useId()
	const [form, setForm] = useState<OcrPagesForm>(DEFAULT_OCR_PAGES_FORM)
	const chosen = ocrChosenPages(form, pageCount, scanned)
	const rangeInvalid = form.pages === "range" && form.range.trim().length > 0 && chosen === null
	const busy = run !== null && (run.phase === "downloading" || run.phase === "recognising")
	const started = run !== null && run.phase !== "modelsFailed"

	return (
		<Dialog
			open
			onOpenChange={next => {
				if (!next && !busy) onClose()
			}}
		>
			<DialogContent
				closeButtonDisabled={busy}
				data-preview-surface
				className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
			>
				<DialogHeader>
					<DialogTitle>{t("previewPdfOcrTitle")}</DialogTitle>
					<DialogDescription>{t("previewPdfOcrDescription")}</DialogDescription>
				</DialogHeader>
				{started ? (
					<RunProgress run={run} />
				) : (
					<div className="flex min-w-0 flex-col gap-5">
						<Field>
							<FieldLabel id={`${id}-pages-label`}>{t("previewPdfOcrPages")}</FieldLabel>
							<RadioGroup
								aria-labelledby={`${id}-pages-label`}
								name={`${id}-pages`}
								value={form.pages}
								className="flex flex-col gap-2"
								onValueChange={(next: unknown) => {
									const found = PAGE_CHOICES.find(choice => choice === next)

									if (found !== undefined) setForm({ ...form, pages: found })
								}}
							>
								<div className="flex items-center gap-2">
									<RadioGroupItem
										id={`${id}-all`}
										value="all"
									/>
									<Label htmlFor={`${id}-all`}>{t("previewPdfOcrAllPages")}</Label>
								</div>
								<div className="flex items-center gap-2">
									<RadioGroupItem
										id={`${id}-range`}
										value="range"
									/>
									<Label htmlFor={`${id}-range`}>{t("previewPdfOcrRange")}</Label>
									<Input
										aria-label={t("previewPdfOcrRangeLabel")}
										aria-invalid={rangeInvalid}
										placeholder={t("previewPdfPrintRangePlaceholder")}
										autoComplete="off"
										spellCheck={false}
										className="h-8 min-w-0 flex-1 leading-5"
										value={form.range}
										onChange={event => {
											setForm({ pages: "range", range: event.target.value })
										}}
									/>
								</div>
							</RadioGroup>
							{rangeInvalid ? <FieldError>{t("previewPdfPrintRangeInvalid", { last: pageCount })}</FieldError> : null}
							{chosen === null ? null : (
								<FieldDescription>
									{chosen.length === 0
										? t("previewPdfOcrNoScanned")
										: t("previewPdfOcrScanned", { count: chosen.length })}
								</FieldDescription>
							)}
						</Field>
						<Field>
							<FieldLabel>{t("previewPdfOcrLanguages")}</FieldLabel>
							<OcrLanguagePicker
								languages={languages}
								disabled={false}
								onChange={onLanguagesChange}
							/>
							<FieldDescription>{t("previewPdfOcrLanguagesHint")}</FieldDescription>
							{downloadBytes > 0 ? (
								<p className="text-xs text-muted-foreground">
									{t("previewPdfOcrDownload", { size: formatBytes(downloadBytes) })}
								</p>
							) : null}
						</Field>
						{run?.phase === "modelsFailed" ? (
							<p
								role="alert"
								className="text-sm text-destructive"
							>
								{t("previewPdfOcrModelsFailed")}
							</p>
						) : null}
					</div>
				)}
				<DialogFooter>
					{busy ? (
						<Button
							type="button"
							variant="outline"
							onClick={onCancel}
						>
							{t("common:cancel")}
						</Button>
					) : (
						<Button
							type="button"
							variant="outline"
							onClick={onClose}
						>
							{t(started ? "common:close" : "common:cancel")}
						</Button>
					)}
					{started ? null : (
						<Button
							type="button"
							disabled={chosen === null || chosen.length === 0 || languages.length === 0}
							onClick={() => {
								if (chosen !== null) onStart(chosen)
							}}
						>
							{t("previewPdfOcrStart")}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
