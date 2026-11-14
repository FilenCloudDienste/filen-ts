import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { TriangleAlertIcon } from "lucide-react"
import type { RedactionFailure } from "@filen/office/core/pdfedit/redactVerify"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import { failureReason, redactedCopyName, type RedactionDestination } from "@/features/pdf/redact/redaction.logic"

// Apply redactions…: the permanent-deletion warning, Sanitize (on), removing comments over marks (on), and where the
// result goes: a copy "name (redacted).pdf" by default, or a new version of this file (whose earlier versions still
// hold the content; the host shows the shared earlier-versions warning after such a save). When the saved file failed
// the redaction check, the dialog says why and nothing was saved.

export interface ApplyRedactionsOptions {
	readonly sanitize: boolean
	readonly removeAnnotations: boolean
	readonly destination: RedactionDestination
}

export interface ApplyRedactionsDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	// The open file's name, and the names taken in its directory (lowercased).
	fileName: string
	takenNames: ReadonlySet<string>
	// In-place saving offered (a writable drive file).
	canSaveInPlace: boolean
	// The document has accessibility tags, which a redaction may leave incomplete.
	tagged: boolean
	busy: boolean
	// The last attempt's check failure, shown until the next attempt.
	failure: RedactionFailure | null
	onApply: (options: ApplyRedactionsOptions) => void
}

export function ApplyRedactionsDialog({
	open,
	onOpenChange,
	fileName,
	takenNames,
	canSaveInPlace,
	tagged,
	busy,
	failure,
	onApply
}: ApplyRedactionsDialogProps) {
	const { t } = useTranslation("preview")
	const { t: common } = useTranslation("common")
	const id = useId()
	const [sanitize, setSanitize] = useState(true)
	const [removeAnnotations, setRemoveAnnotations] = useState(true)
	const [inPlace, setInPlace] = useState(false)
	const copyName = redactedCopyName(
		fileName,
		number => (number <= 1 ? t("previewPdfRedactCopySuffix") : t("previewPdfRedactCopySuffixNumbered", { number })),
		takenNames
	)
	const reason = failure === null ? null : failureReason(failure)

	return (
		<Dialog
			open={open}
			onOpenChange={next => {
				if (!busy) onOpenChange(next)
			}}
		>
			<DialogContent
				data-preview-surface
				className="sm:max-w-md"
			>
				<DialogHeader>
					<DialogTitle>{t("previewPdfRedactApplyTitle")}</DialogTitle>
					<DialogDescription>{t("previewPdfRedactApplyWarning")}</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					{tagged ? <p className="text-xs text-muted-foreground">{t("previewPdfTagged")}</p> : null}
					<div className="flex items-start gap-2">
						<input
							id={`${id}-sanitize`}
							type="checkbox"
							className="mt-0.5 size-4 shrink-0 accent-primary"
							checked={sanitize}
							disabled={busy}
							aria-describedby={`${id}-sanitize-hint`}
							onChange={event => {
								setSanitize(event.target.checked)
							}}
						/>
						<div className="flex flex-col gap-0.5">
							<Label htmlFor={`${id}-sanitize`}>{t("previewPdfRedactSanitize")}</Label>
							<p
								id={`${id}-sanitize-hint`}
								className="text-xs text-muted-foreground"
							>
								{t("previewPdfRedactSanitizeHint")}
							</p>
						</div>
					</div>
					<div className="flex items-center gap-2">
						<input
							id={`${id}-annotations`}
							type="checkbox"
							className="size-4 shrink-0 accent-primary"
							checked={removeAnnotations}
							disabled={busy}
							onChange={event => {
								setRemoveAnnotations(event.target.checked)
							}}
						/>
						<Label htmlFor={`${id}-annotations`}>{t("previewPdfRedactRemoveAnnotations")}</Label>
					</div>
					{canSaveInPlace ? (
						<div className="flex flex-col gap-2">
							<span
								id={`${id}-save-label`}
								className="text-sm font-medium"
							>
								{t("previewPdfRedactSaveTo")}
							</span>
							<RadioGroup
								aria-labelledby={`${id}-save-label`}
								name={`${id}-save`}
								value={inPlace ? "inPlace" : "copy"}
								disabled={busy}
								className="flex flex-col gap-2"
								onValueChange={(next: unknown) => {
									setInPlace(next === "inPlace")
								}}
							>
								<div className="flex items-center gap-2">
									<RadioGroupItem
										id={`${id}-copy`}
										value="copy"
									/>
									<Label
										htmlFor={`${id}-copy`}
										className="min-w-0 break-all"
									>
										{t("previewPdfRedactSaveCopy", { name: copyName })}
									</Label>
								</div>
								<div className="flex items-center gap-2">
									<RadioGroupItem
										id={`${id}-in-place`}
										value="inPlace"
									/>
									<Label htmlFor={`${id}-in-place`}>{t("previewPdfRedactSaveInPlace")}</Label>
								</div>
							</RadioGroup>
						</div>
					) : (
						<p className="text-sm break-all">{t("previewPdfRedactSaveCopy", { name: copyName })}</p>
					)}
					{reason === null ? null : (
						<p
							role="alert"
							className="flex items-start gap-2 text-sm text-destructive"
						>
							<TriangleAlertIcon
								aria-hidden
								className="mt-0.5 size-4 shrink-0"
							/>
							{t("previewPdfRedactVerifyFailed", { reason: t(reason.key, reason.params) })}
						</p>
					)}
				</div>
				<DialogFooter>
					<Button
						variant="outline"
						disabled={busy}
						onClick={() => {
							onOpenChange(false)
						}}
					>
						{common("cancel")}
					</Button>
					<Button
						variant="destructive"
						disabled={busy}
						onClick={() => {
							onApply({
								sanitize,
								removeAnnotations,
								destination: inPlace && canSaveInPlace ? { kind: "inPlace" } : { kind: "copy", name: copyName }
							})
						}}
					>
						{busy ? <Spinner data-icon="inline-start" /> : null}
						{busy ? t("previewPdfRedactApplying") : t("previewPdfRedactApplyConfirm")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
