import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { PresentationDocument } from "@filen/office/react/presentation"
import { GATE_KEYS } from "@/features/presentation/components/deckChrome.logic"

// The strip under the command bar: why the deck is read-only, macros, linked files, and the caller's own notes;
// dismissed for this open.
export function DeckNotes({ deck, extra }: { deck: PresentationDocument; extra?: readonly string[] }) {
	const { t } = useTranslation("preview")
	const [dismissed, setDismissed] = useState(false)
	const notes: string[] = [
		...(deck.info?.gate ?? []).map(reason => t(GATE_KEYS[reason])),
		...deck.notices.flatMap(notice =>
			notice.kind === "macros" ? [t("previewPptxMacros")] : notice.kind === "linkedFile" ? [t("previewPptxLinkedFile")] : []
		),
		...(extra ?? [])
	]

	if (notes.length === 0 || dismissed) return null

	return (
		<div
			role="status"
			className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground"
		>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				{[...new Set(notes)].map(note => (
					<p key={note}>{note}</p>
				))}
			</div>
			<button
				type="button"
				className="shrink-0 underline-offset-2 hover:underline"
				onClick={() => {
					setDismissed(true)
				}}
			>
				{t("previewPptxDismiss")}
			</button>
		</div>
	)
}
