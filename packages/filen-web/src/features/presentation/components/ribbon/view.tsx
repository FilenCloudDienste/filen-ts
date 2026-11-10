import { useTranslation } from "react-i18next"
import { MaximizeIcon, PanelLeftIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react"
import { canZoomIn, canZoomOut } from "@filen/office/dom/docx"
import { RibbonButton } from "@/features/office/components/ribbon/ribbonControls"
import type { PresentationGroups } from "@/features/presentation/components/ribbon/tabs"
import { PaneToggles } from "@/features/presentation/components/slideControls"
import { usePresentationEditor, type PresentationZoomView } from "@/features/presentation/hooks/usePresentationSession"
import { StatusZoomMenu, ZoomControls, type FitShortcuts } from "@/features/preview/components/commandBarControls"
import { ZOOM_CONTROLS_WIDTH, type ZoomFit } from "@/features/preview/components/commandBar.logic"
import { DOCX_ZOOM_PRESETS } from "@/features/preview/components/docxViewer.logic"
import { Kbd } from "@/lib/keymap/kbd"

// The presentation ribbon's View groups: the slide list and the notes pane shown or hidden, and the slide's zoom (Zoom
// and Fit to Window, as PowerPoint's). Offered in a deck that can only be viewed too.

const BUTTON = 30
// The zoom menu's fit: the whole slide in the window, on the editor's key.
const FITS: readonly ZoomFit[] = ["fitPage"]
const FIT_SHORTCUTS: FitShortcuts = { fitPage: "presentation.zoomFit" }

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
				canIn={canIn(scale)}
				canOut={canOut(scale)}
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
				inShortcut={<Kbd action="presentation.zoomIn" />}
				outShortcut={<Kbd action="presentation.zoomOut" />}
				fitShortcuts={FIT_SHORTCUTS}
			/>
			<RibbonButton
				label={t("previewPptxRibbonFitToWindow")}
				icon={<MaximizeIcon />}
				pressed={fit}
				shortcut={<Kbd action="presentation.zoomFit" />}
				onClick={() => {
					set("fit")
				}}
			/>
		</>
	)
}

// Whether the slide shown at `scale` (0 while unmeasured) can zoom further in or out.
function canIn(scale: number): boolean {
	return scale > 0 && canZoomIn(scale)
}

function canOut(scale: number): boolean {
	return scale > 0 && canZoomOut(scale)
}

// The status bar's zoom percentage, opening the zoom menu.
export function PresentationStatusZoom() {
	const scope = usePresentationEditor()

	if (scope === undefined) return null

	return <ZoomPercent zoom={scope.view.zoom} />
}

function ZoomPercent({ zoom }: { zoom: PresentationZoomView }) {
	const { scale, fit, set } = zoom

	return (
		<StatusZoomMenu
			percent={Math.round(scale * 100)}
			presets={DOCX_ZOOM_PRESETS}
			fits={FITS}
			mode={fit ? "fitPage" : "custom"}
			fitShortcuts={FIT_SHORTCUTS}
			onPercent={next => {
				set(next / 100)
			}}
			onFit={() => {
				set("fit")
			}}
		/>
	)
}

// The viewer's compact zoom at its command bar's end, the editor's pieces: − / the status bar's percentage and its menu
// / + / Fit, each naming its key.
export function PresentationZoomStrip({ zoom }: { zoom: PresentationZoomView }) {
	const { t } = useTranslation("preview")
	const { scale, fit, set } = zoom

	return (
		<div
			role="group"
			aria-label={t("previewOfficeRibbonZoom")}
			className="flex shrink-0 items-center"
		>
			<RibbonButton
				label={t("previewPdfZoomOutAction")}
				icon={<ZoomOutIcon />}
				disabled={!canOut(scale)}
				shortcut={<Kbd action="presentation.zoomOut" />}
				onClick={() => {
					set("out")
				}}
			/>
			<ZoomPercent zoom={zoom} />
			<RibbonButton
				label={t("previewPdfZoomInAction")}
				icon={<ZoomInIcon />}
				disabled={!canIn(scale)}
				shortcut={<Kbd action="presentation.zoomIn" />}
				onClick={() => {
					set("in")
				}}
			/>
			<RibbonButton
				label={t("previewPptxRibbonFitToWindow")}
				icon={null}
				text={t("previewPptxZoomFitShort")}
				pressed={fit}
				shortcut={<Kbd action="presentation.zoomFit" />}
				onClick={() => {
					set("fit")
				}}
			/>
		</div>
	)
}
