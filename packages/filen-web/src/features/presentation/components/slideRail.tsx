import { useTranslation } from "react-i18next"
import { SlideRail, type PresentationDocument, type PresentationStore } from "@filen/office/react/presentation"
import { usePhoneWidth } from "@/features/office/components/ribbon/phoneMedia"

// Thumbnail width (css px) of the vertical rail and of the phone's strip under the slide.
export const RAIL_THUMB_WIDTH = 160
export const STRIP_THUMB_WIDTH = 96

// The deck's slides as thumbnails (only the window mounted): beside the slide, or a strip under it at phone widths.
// Selecting one shows it; hidden slides are dimmed and named as hidden.
export function PresentationSlideRail({
	document,
	store,
	current,
	onSelect
}: {
	document: PresentationDocument
	store: PresentationStore
	current: number
	onSelect: (index: number) => void
}) {
	const { t } = useTranslation("preview")
	const phone = usePhoneWidth()
	const size = document.info?.size

	return (
		<div
			data-preview-surface
			className={phone ? "h-24 w-full shrink-0 border-t border-border" : "h-full w-48 shrink-0 border-r border-border"}
		>
			<SlideRail
				slides={document.slides}
				thumbs={document.thumbs}
				aspect={size === undefined || size.cx <= 0 ? 0.5625 : size.cy / size.cx}
				current={current}
				onSelect={onSelect}
				requestThumbnails={(refs, widthPx) => {
					store.requestThumbnails(refs, widthPx)
				}}
				label={t("previewPptxRailLabel")}
				slideLabel={(index, count, hidden) =>
					t(hidden ? "previewPptxSlideHiddenLabel" : "previewPptxSlideLabel", { current: index + 1, total: count })
				}
				orientation={phone ? "horizontal" : "vertical"}
				thumbWidth={phone ? STRIP_THUMB_WIDTH : RAIL_THUMB_WIDTH}
				className="size-full"
			/>
		</div>
	)
}
