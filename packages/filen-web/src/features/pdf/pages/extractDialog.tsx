import { useId, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { PageRange } from "@filen/office/core/pdfedit/pageRanges"
import { FormDialog } from "@/components/dialogs/formDialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import { batchCopyNames, extractSuffix } from "@/features/pdf/pages/names"
import { defaultExtractForm, extractPlan, selectionText, type ExtractForm } from "@/features/pdf/pages/organise.logic"

// Shared by the Extract and Split dialogs: what the PDF is and how the new files are named.
export interface PdfCopyContext {
	// The PDF's file name ("report.pdf").
	readonly name: string
	readonly pageCount: number
	// The rail's selection (0-based).
	readonly selected: readonly number[]
	// Names in the PDF's directory (lowercased), so the shown names are the ones the files get.
	readonly taken: ReadonlySet<string>
	// Password-protected: the "protect the new files" switch shows.
	readonly encrypted: boolean
	// The password cannot be carried (extractSaveOptions refused it).
	readonly passwordUnsupported: boolean
	// Has signatures: the note that they are not copied shows.
	readonly signed: boolean
	// Saving: files done of all; undefined when idle.
	readonly progress: { readonly done: number; readonly count: number } | undefined
	readonly online: boolean
}

export interface PdfExtractRequest {
	// One entry per new file: its pages (1-based ranges) and its name.
	readonly files: readonly { readonly ranges: readonly PageRange[]; readonly name: string }[]
	// 0-based pages to delete from this PDF afterwards.
	readonly deletes: readonly number[]
	readonly protect: boolean
}

export interface PdfExtractDialogProps extends PdfCopyContext {
	readonly onExtract: (request: PdfExtractRequest) => void
	readonly onClose: () => void
}

// The switches and notes both dialogs end with: password protection and the signature note.
export function CopyOptions({
	id,
	context,
	protect,
	onProtect,
	children
}: {
	id: string
	context: PdfCopyContext
	protect: boolean
	onProtect: (protect: boolean) => void
	children?: ReactNode
}) {
	const { t } = useTranslation("preview")
	const busy = context.progress !== undefined

	return (
		<>
			{children}
			{context.encrypted ? (
				<Field orientation="horizontal">
					<Switch
						id={`${id}-protect`}
						checked={protect}
						disabled={busy}
						onCheckedChange={onProtect}
					/>
					<div className="flex flex-col gap-0.5">
						<FieldLabel htmlFor={`${id}-protect`}>{t("previewPdfExtractKeepPassword")}</FieldLabel>
						<FieldDescription>{t("previewPdfExtractKeepPasswordNote")}</FieldDescription>
					</div>
				</Field>
			) : null}
			{context.encrypted && protect && context.passwordUnsupported ? (
				<FieldError>{t("previewPdfExtractPasswordUnsupported")}</FieldError>
			) : null}
			{context.signed ? <p className="text-xs text-muted-foreground">{t("previewPdfExtractSignatures")}</p> : null}
		</>
	)
}

// The names the files will get, as the dialog shows them.
export function OutputNames({ names }: { names: readonly string[] }) {
	const { t } = useTranslation("preview")
	const first = names[0]

	if (first === undefined) return null

	return (
		<p
			className="text-xs break-all text-muted-foreground"
			role="status"
		>
			{t("previewPdfExtractOutput", { count: names.length, name: first })}
		</p>
	)
}

// Extract: pages (the selection or typed ranges) copied into a new PDF beside this one, or one PDF per page; the
// pages may be deleted from this PDF afterwards (never all of them); a password-protected PDF's new files keep its
// password unless switched off. Mounted anew for each opening.
export function PdfExtractDialog({ onExtract, onClose, ...context }: PdfExtractDialogProps) {
	const { t } = useTranslation(["preview", "common"])
	const id = useId()
	const [form, setForm] = useState<ExtractForm>(() => defaultExtractForm(context.selected.length > 0))
	const plan = extractPlan(form, context.pageCount, context.selected)
	const names =
		plan === null
			? []
			: batchCopyNames(
					context.name,
					plan.files.map(ranges => extractSuffix(t, ranges)),
					context.taken
				)
	const busy = context.progress !== undefined
	const rangeInvalid = form.source === "range" && form.range.trim().length > 0 && plan === null
	const blocked = context.encrypted && form.protect && context.passwordUnsupported
	const change = (patch: Partial<ExtractForm>): void => {
		setForm({ ...form, ...patch })
	}

	return (
		<FormDialog
			open
			pending={busy}
			title={t("previewPdfExtractTitle")}
			description={t("previewPdfExtractDescription")}
			submitLabel={
				context.progress === undefined
					? t("previewPdfExtractSubmit")
					: t("previewPdfExtractProgress", { done: context.progress.done, count: context.progress.count })
			}
			cancelLabel={t("common:cancel")}
			canSubmit={plan !== null && !blocked && context.online}
			onOpenChange={open => {
				if (!open) onClose()
			}}
			onSubmit={event => {
				event.preventDefault()

				if (plan === null || blocked) return

				onExtract({
					files: plan.files.map((ranges, index) => ({ ranges, name: names[index] ?? context.name })),
					deletes: plan.deletes,
					protect: context.encrypted && form.protect
				})
			}}
		>
			<Field>
				<FieldLabel id={`${id}-pages-label`}>{t("previewPdfExtractPages")}</FieldLabel>
				<RadioGroup
					aria-labelledby={`${id}-pages-label`}
					name={`${id}-pages`}
					value={form.source}
					disabled={busy}
					className="flex flex-col gap-2"
					onValueChange={(next: unknown) => {
						if (next === "selected" || next === "range") change({ source: next })
					}}
				>
					{context.selected.length > 0 ? (
						<div className="flex items-center gap-2">
							<RadioGroupItem
								id={`${id}-selected`}
								value="selected"
							/>
							<Label htmlFor={`${id}-selected`}>
								{t("previewPdfExtractSelected", { pages: selectionText(context.selected) })}
							</Label>
						</div>
					) : null}
					<div className="flex items-center gap-2">
						<RadioGroupItem
							id={`${id}-range`}
							value="range"
						/>
						<Label htmlFor={`${id}-range`}>{t("previewPdfExtractRange")}</Label>
						<Input
							aria-label={t("previewPdfExtractRangeLabel")}
							aria-invalid={rangeInvalid}
							placeholder={t("previewPdfExtractRangePlaceholder")}
							autoComplete="off"
							spellCheck={false}
							className="h-8 min-w-0 flex-1 leading-5"
							value={form.range}
							disabled={busy}
							onChange={event => {
								change({ source: "range", range: event.target.value })
							}}
						/>
					</div>
				</RadioGroup>
				{rangeInvalid ? <FieldError>{t("previewPdfExtractRangeInvalid", { last: context.pageCount })}</FieldError> : null}
			</Field>
			<CopyOptions
				id={id}
				context={context}
				protect={form.protect}
				onProtect={protect => {
					change({ protect })
				}}
			>
				<Field orientation="horizontal">
					<Switch
						id={`${id}-separate`}
						checked={form.separate}
						disabled={busy}
						onCheckedChange={separate => {
							change({ separate })
						}}
					/>
					<FieldLabel htmlFor={`${id}-separate`}>{t("previewPdfExtractSeparate")}</FieldLabel>
				</Field>
				<Field orientation="horizontal">
					<Switch
						id={`${id}-delete`}
						checked={form.deleteAfter && plan?.coversAll !== true}
						disabled={busy || plan?.coversAll === true}
						onCheckedChange={deleteAfter => {
							change({ deleteAfter })
						}}
					/>
					<div className="flex flex-col gap-0.5">
						<FieldLabel htmlFor={`${id}-delete`}>{t("previewPdfExtractDelete")}</FieldLabel>
						{plan?.coversAll === true ? <FieldDescription>{t("previewPdfExtractDeleteAll")}</FieldDescription> : null}
					</div>
				</Field>
			</CopyOptions>
			<OutputNames names={names} />
		</FormDialog>
	)
}
