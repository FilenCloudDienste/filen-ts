import { useId } from "react"
import { useTranslation } from "react-i18next"
import { XIcon } from "lucide-react"
import type { RedactionMark } from "@filen/office/core/pdfedit/redactVerify"
import { Button } from "@/components/ui/button"
import { markLabel } from "@/features/pdf/redact/redaction.logic"

// "Marked for redaction (n)": every pending mark in document order, each removable with ✕ (nothing is redacted until
// Apply redactions…), and the button opening the Apply redactions dialog.

export interface RedactionMarksListProps {
	marks: readonly RedactionMark[]
	// The marked text of text marks, by mark id, when the host has read it.
	texts?: ReadonlyMap<number, string> | undefined
	onSelect?: ((mark: RedactionMark) => void) | undefined
	onRemove: (mark: RedactionMark) => void
	onApply: () => void
	disabled?: boolean | undefined
}

export function RedactionMarksList({ marks, texts, onSelect, onRemove, onApply, disabled }: RedactionMarksListProps) {
	const { t } = useTranslation("preview")
	const id = useId()

	return (
		<section
			aria-labelledby={`${id}-title`}
			className="flex h-full min-h-0 flex-col gap-2 p-3"
		>
			<h2
				id={`${id}-title`}
				className="text-sm font-semibold"
			>
				{t("previewPdfRedactMarked", { count: marks.length })}
			</h2>
			{marks.length === 0 ? (
				<p className="text-sm text-muted-foreground">{t("previewPdfRedactMarkedEmpty")}</p>
			) : (
				<ul className="min-h-0 flex-1 overflow-y-auto">
					{marks.map(mark => {
						const label = markLabel(mark, texts?.get(mark.id))

						return (
							<li
								key={mark.id}
								className="flex items-center gap-2 rounded-xl py-1 pr-1 pl-2 hover:bg-muted"
							>
								<button
									type="button"
									className="flex min-w-0 flex-1 flex-col items-start text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
									disabled={onSelect === undefined}
									onClick={() => {
										onSelect?.(mark)
									}}
								>
									<span className="max-w-full truncate">{t(label.key, label.params)}</span>
									<span className="text-xs text-muted-foreground">
										{t("previewPdfRedactMarkPageNumber", { page: mark.page + 1 })}
									</span>
								</button>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={t("previewPdfRedactRemoveMark")}
									disabled={disabled === true}
									onClick={() => {
										onRemove(mark)
									}}
								>
									<XIcon aria-hidden />
								</Button>
							</li>
						)
					})}
				</ul>
			)}
			<Button
				disabled={marks.length === 0 || disabled === true}
				onClick={onApply}
			>
				{t("previewPdfRedactApply")}
			</Button>
		</section>
	)
}
