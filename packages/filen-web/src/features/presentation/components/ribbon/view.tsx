import { useTranslation } from "react-i18next"
import { MaximizeIcon, PanelLeftIcon, ZoomInIcon } from "lucide-react"
import { canZoomIn, canZoomOut } from "@filen/office/dom/docx"
import { RibbonButton } from "@/features/office/components/ribbon/ribbonControls"
import type { PresentationGroups } from "@/features/presentation/components/ribbon/tabs"
import { PaneToggles } from "@/features/presentation/components/slideControls"
import { usePresentationEditor } from "@/features/presentation/hooks/usePresentationSession"
import { StatusZoomMenu, ZoomControls } from "@/features/preview/components/commandBarControls"
import { ZOOM_CONTROLS_WIDTH, type ZoomFit } from "@/features/preview/components/commandBar.logic"
import { DOCX_ZOOM_PRESETS } from "@/features/preview/components/docxViewer.logic"

// The presentation ribbon's View groups: the slide list and the notes pane shown or hidden, and the slide's zoom (Zoom
// and Fit to Window, as PowerPoint's). Offered in a deck that can only be viewed too.

const BUTTON = 30
// The zoom menu's fit: the whole slide in the window.
const FITS: readonly ZoomFit[] = ["fitPage"]

export const viewGroups: PresentationGroups = context => [
	{
		id: "panes",
		label: context.t("previewPptxRibbonPanes", { ns: "preview" }),
		icon: PanelLeftIcon,
		width: 2 * BUTTON,
		priority: 3,
		content: <PaneToggles />
	},
	{
		id: "zoom",
		label: context.t("previewOfficeRibbonZoom", { ns: "preview" }),
		icon: ZoomInIcon,
		width: ZOOM_CONTROLS_WIDTH + BUTTON,
		priority: 2,
		content: <ZoomGroup />
	}
]

function ZoomGroup() {
	const { t } = useTranslation("preview")
	const scope = usePresentationEditor()

	if (scope === undefined) return null

	const { scale, fit, set } = scope.view.zoom
	const percent = Math.round(scale * 100)

	return (
		<>
			<ZoomControls
				percent={percent}
				presets={DOCX_ZOOM_PRESETS}
				fits={FITS}
				mode={fit ? "fitPage" : "custom"}
				canIn={scale > 0 && canZoomIn(scale)}
				canOut={scale > 0 && canZoomOut(scale)}
				onIn={() => {
					set("in")
				}}
				onOut={() => {
					set("out")
				}}
				onPercent={next => {
					set(next / 100)
				}}
				onFit={() => {
					set("fit")
				}}
			/>
			<RibbonButton
				label={t("previewPptxRibbonFitToWindow")}
				icon={<MaximizeIcon />}
				pressed={fit}
				onClick={() => {
					set("fit")
				}}
			/>
		</>
	)
}

// The status bar's zoom percentage, opening the zoom menu.
export function PresentationStatusZoom() {
	const scope = usePresentationEditor()

	if (scope === undefined) return null

	const { scale, fit, set } = scope.view.zoom

	return (
		<StatusZoomMenu
			percent={Math.round(scale * 100)}
			presets={DOCX_ZOOM_PRESETS}
			fits={FITS}
			mode={fit ? "fitPage" : "custom"}
			onPercent={next => {
				set(next / 100)
			}}
			onFit={() => {
				set("fit")
			}}
		/>
	)
}
