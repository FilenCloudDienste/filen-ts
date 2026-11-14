import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import type { PageRange } from "@filen/office/core/pdfedit/pageRanges"
import { FormDialog } from "@/components/dialogs/formDialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { CopyOptions, OutputNames, type PdfCopyContext } from "@/features/pdf/pages/extractDialog"
import { batchCopyNames, partSuffix } from "@/features/pdf/pages/names"
import { copiesProtected, defaultSplitForm, splitPlan, type SplitForm, type SplitMode } from "@/features/pdf/pages/organise.logic"

export interface PdfSplitRequest {
	// One entry per part: its pages (1-based, inclusive) and its name.
	readonly parts: readonly { readonly range: PageRange; readonly name: string }[]
	readonly protect: boolean
}

export interface PdfSplitDialogProps extends PdfCopyContext {
	// The 0-based first page of each top-level bookmark (topLevelBookmarkPages); empty: no bookmarks.
	readonly bookmarks: readonly number[]
	readonly onSplit: (request: PdfSplitRequest) => void
	readonly onClose: () => void
}

const MODES: readonly SplitMode[] = ["count", "selection", "bookmarks", "ranges"]

// Split: the PDF cut into new PDFs beside it ("report (part 1).pdf"…) by page count, before each selected page, at
// top-level bookmarks or by typed ranges (one file each); this PDF does not change. Mounted anew for each opening.
export function PdfSplitDialog({ bookmarks, onSplit, onClose, ...context }: PdfSplitDialogProps) {
	const { t } = useTranslation(["preview", "common"])
	const id = useId()
	const [form, setForm] = useState<SplitForm>(defaultSplitForm)
	const plan = splitPlan(form, context.pageCount, context.selected, bookmarks)
	// One part holding every page splits nothing.
	const useful = plan !== null && plan.length > 1
	const names = useful
		? batchCopyNames(
				context.name,
				plan.map((_, index) => partSuffix(t, index + 1)),
				context.taken
			)
		: []
	const busy = context.progress !== undefined
	const protect = copiesProtected(context.encrypted, context.ownerAccess, form.protect)
	const blocked = protect && context.passwordUnsupported
	const invalid =
		(form.mode === "ranges" && form.ranges.trim().length > 0 && plan === null) ||
		(form.mode === "count" && form.size.trim().length > 0 && plan === null)
	const change = (patch: Partial<SplitForm>): void => {
		setForm({ ...form, ...patch })
	}
	const label = (mode: SplitMode): string => {
		switch (mode) {
			case "count":
				return t("previewPdfSplitByCount")
			case "selection":
				return t("previewPdfSplitBySelection")
			case "bookmarks":
				return t("previewPdfSplitByBookmarks")
			case "ranges":
				return t("previewPdfSplitByRanges")
		}
	}

	return (
		<FormDialog
			open
			pending={busy}
			title={t("previewPdfSplitTitle")}
			description={t("previewPdfSplitDescription")}
			submitLabel={
				context.progress === undefined
					? t("previewPdfSplitSubmit")
					: t("previewPdfExtractProgress", { done: context.progress.done, count: context.progress.count })
			}
			cancelLabel={t("common:cancel")}
			canSubmit={useful && !blocked && context.online}
			onOpenChange={open => {
				if (!open) onClose()
			}}
			onSubmit={event => {
				event.preventDefault()

				if (!useful || blocked) return

				onSplit({
					parts: plan.map((range, index) => ({ range, name: names[index] ?? context.name })),
					protect
				})
			}}
		>
			<Field>
				<FieldLabel id={`${id}-mode-label`}>{t("previewPdfSplitBy")}</FieldLabel>
				<RadioGroup
					aria-labelledby={`${id}-mode-label`}
					name={`${id}-mode`}
					value={form.mode}
					disabled={busy}
					className="flex flex-col gap-2"
					onValueChange={(next: unknown) => {
						const found = MODES.find(mode => mode === next)

						if (found !== undefined) change({ mode: found })
					}}
				>
					{MODES.map(mode => (
						<div
							key={mode}
							className="flex min-h-8 items-center gap-2"
						>
							<RadioGroupItem
								id={`${id}-${mode}`}
								value={mode}
								disabled={
									(mode === "selection" && context.selected.length === 0) ||
									(mode === "bookmarks" && bookmarks.length === 0)
								}
							/>
							<Label htmlFor={`${id}-${mode}`}>{label(mode)}</Label>
							{mode === "count" ? (
								<Input
									aria-label={t("previewPdfSplitCountLabel")}
									aria-invalid={form.mode === "count" && invalid}
									type="number"
									inputMode="numeric"
									min={1}
									max={context.pageCount}
									autoComplete="off"
									className="h-8 w-20 leading-5"
									value={form.size}
									disabled={busy}
									onChange={event => {
										change({ mode: "count", size: event.target.value })
									}}
								/>
							) : null}
							{mode === "ranges" ? (
								<Input
									aria-label={t("previewPdfSplitRangesLabel")}
									aria-invalid={form.mode === "ranges" && invalid}
									placeholder={t("previewPdfSplitRangesPlaceholder")}
									autoComplete="off"
									spellCheck={false}
									className="h-8 min-w-0 flex-1 leading-5"
									value={form.ranges}
									disabled={busy}
									onChange={event => {
										change({ mode: "ranges", ranges: event.target.value })
									}}
								/>
							) : null}
						</div>
					))}
				</RadioGroup>
				{bookmarks.length === 0 ? <FieldDescription>{t("previewPdfSplitNoBookmarks")}</FieldDescription> : null}
				{invalid ? <FieldError>{t("previewPdfPageRangeInvalid", { last: context.pageCount })}</FieldError> : null}
				{plan !== null && plan.length === 1 ? <FieldDescription>{t("previewPdfSplitNothing")}</FieldDescription> : null}
			</Field>
			<CopyOptions
				id={id}
				context={context}
				protect={form.protect}
				onProtect={protect => {
					change({ protect })
				}}
			/>
			<OutputNames names={names} />
		</FormDialog>
	)
}
