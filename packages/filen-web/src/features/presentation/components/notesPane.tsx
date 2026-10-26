import { useState } from "react"
import { useTranslation } from "react-i18next"
import { NotesPanel } from "@filen/office/react/presentation"

const STORAGE_KEY = "filen.presentation.notes"

interface NotesLayout {
	collapsed: boolean
	height: number
}

// The viewer's own preference, remembered in this browser only (absent or unreadable storage: the defaults).
function readLayout(): NotesLayout | null {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")

		if (typeof parsed === "object" && parsed !== null) {
			const { collapsed, height } = parsed as Partial<NotesLayout>

			if (typeof collapsed === "boolean" && typeof height === "number" && Number.isFinite(height)) return { collapsed, height }
		}
	} catch {
		// Storage blocked or the value damaged: the defaults.
	}

	return null
}

function writeLayout(layout: NotesLayout): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
	} catch {
		// Storage blocked: the layout lasts for this viewer only.
	}
}

// The slide's speaker notes under it: collapsible and resizable, collapsed on first use at phone widths.
export function PresentationNotesPane({ text, phone }: { text: string; phone: boolean }) {
	const { t } = useTranslation("preview")
	const [layout, setLayout] = useState<NotesLayout>(() => readLayout() ?? { collapsed: phone, height: 120 })
	const update = (next: NotesLayout): void => {
		setLayout(next)
		writeLayout(next)
	}

	return (
		<div
			data-preview-surface
			className="shrink-0 border-t border-border"
		>
			<NotesPanel
				text={text}
				label={t("previewPptxNotesLabel")}
				expandLabel={t("previewPptxNotesShow")}
				collapseLabel={t("previewPptxNotesHide")}
				resizeLabel={t("previewPptxNotesResize")}
				emptyText={t("previewPptxNotesEmpty")}
				collapsed={layout.collapsed}
				onCollapsedChange={collapsed => {
					update({ ...layout, collapsed })
				}}
				height={layout.height}
				onHeightChange={height => {
					update({ ...layout, height })
				}}
				maxHeight={phone ? 240 : 480}
			/>
		</div>
	)
}
