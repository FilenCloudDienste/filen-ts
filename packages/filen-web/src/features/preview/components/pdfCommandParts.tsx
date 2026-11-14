import type { CSSProperties, ReactNode, RefObject } from "react"
import { useTranslation } from "react-i18next"
import { BookOpenIcon, ListTreeIcon, MaximizeIcon, RotateCcwIcon, RotateCwIcon, SearchIcon, ZoomInIcon } from "lucide-react"
import {
	isPdfCommandEnabled,
	pdfPercentScale,
	resolveDestination,
	PDF_ZOOM_PRESETS,
	type PdfOutlineItem,
	type PdfViewerCommand,
	type PdfViewerState
} from "@filen/office/dom/pdf"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import type { RibbonGroup } from "@/features/office/components/ribbon/officeRibbon"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { usePhoneWidth } from "@/features/office/components/ribbon/phoneMedia"
import {
	CommandFileMenu,
	FullScreenButton,
	PageControls,
	ZoomControls,
	type FitShortcuts
} from "@/features/preview/components/commandBarControls"
import { BAR_BUTTON, BAR_MENU, pageControlsWidth, ZOOM_CONTROLS_WIDTH } from "@/features/preview/components/commandBar.logic"
import { DocxFindField } from "@/features/preview/components/docxToolbar"
import type { DocxFindControls } from "@/features/preview/components/docxViewer.logic"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { fullscreenSupported } from "@/lib/media/fullscreen"
import { Kbd } from "@/lib/keymap/kbd"
import { MenuShortcut } from "@/components/ui/menuShortcut"

// The PDF viewer's commands, shown by its command bar (PdfCommandBar) and by the PDF ribbon's Home tab: File
// (Download, Print, Document properties), then Pages (first, previous, the page number field, next, last), Zoom (out,
// the zoom menu with its steps and fits, in), Rotate, Outline (the document's bookmarks, when it has any), Full screen
// and Find; the page and the zoom as the status. The find field takes the groups' place while finding. Everything it
// shows is the viewer's state, everything it does a viewer command.

// The find field's view of the viewer: a query shows as searched (with its count) once its search finished.
function findControls(state: PdfViewerState, dispatch: (command: PdfViewerCommand) => void): DocxFindControls {
	return {
		query: state.find.done ? state.find.query : "",
		caseSensitive: state.find.caseSensitive,
		count: state.find.count,
		capped: state.find.capped,
		active: state.find.active,
		search: (query, caseSensitive) => {
			dispatch({ type: "find.query", query, caseSensitive })
		},
		step: direction => {
			dispatch({ type: direction > 0 ? "find.next" : "find.previous" })
		},
		close: () => {
			dispatch({ type: "find.close" })
		}
	}
}

// The bookmarks menu (a plain render function: this module exports a hook, not components).
function outlineMenu(
	label: string,
	document: PdfDomDocument,
	outline: readonly PdfOutlineItem[],
	dispatch: (command: PdfViewerCommand) => void
): ReactNode {
	return (
		<DropdownMenu>
			<RibbonMenuTrigger
				label={label}
				icon={<ListTreeIcon />}
			/>
			<DropdownMenuContent
				align="start"
				data-preview-surface
				className="max-h-[min(28rem,var(--available-height))] max-w-80 overflow-y-auto"
			>
				{outline.map((item, index) => {
					const dest = item.dest
					const style: CSSProperties = { paddingInlineStart: `${String(0.5 + item.depth * 0.75)}rem` }

					return (
						<DropdownMenuItem
							key={index}
							disabled={dest === null}
							style={style}
							className="whitespace-normal"
							onClick={() => {
								if (dest !== null) {
									void resolveDestination(document, dest).then(to => {
										if (to !== null) {
											dispatch({ type: "page.goto", page: to.page, left: to.left, top: to.top })
										}
									})
								}
							}}
						>
							{item.title}
						</DropdownMenuItem>
					)
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

export interface PdfCommandBarProps {
	state: PdfViewerState
	dispatch: (command: PdfViewerCommand) => void
	document: PdfDomDocument
	// The document's bookmarks (loadPdfOutline), empty without any.
	outline: readonly PdfOutlineItem[]
	findFocus: number
	onFindClosed: () => void
	// The host's download, null where the file may not be saved.
	onDownload: (() => void) | null
	// Opens the print dialog; undefined where printing is not offered.
	onPrint: (() => void) | undefined
	onProperties: () => void
	// The page field, for the Go to Page key.
	pageInputRef: RefObject<HTMLInputElement | null>
}

// The fit keys the zoom menu's fit entries show.
const PDF_FIT_SHORTCUTS: FitShortcuts = { fitWidth: "preview.pdfFitWidth", fitPage: "preview.pdfFitPage" }

// The viewer's commands as parts of a bar: the File menu, the groups, the status (page and zoom) and the find field
// that takes the groups' place while finding. The read-only bar (PdfCommandBar) and the editor's ribbon both show them.
export interface PdfCommandParts {
	readonly file: ReactNode
	readonly groups: RibbonGroup[]
	readonly status: ReactNode
	readonly replacement: ReactNode | undefined
}

export function usePdfCommandParts({
	state,
	dispatch,
	document,
	outline,
	findFocus,
	onFindClosed,
	onDownload,
	onPrint,
	onProperties,
	pageInputRef
}: PdfCommandBarProps): PdfCommandParts {
	const { t } = useTranslation("preview")
	const phone = usePhoneWidth()
	const command = (next: PdfViewerCommand) => () => {
		dispatch(next)
	}
	const groups: RibbonGroup[] = [
		{
			id: "pages",
			label: t("previewCommandBarPages"),
			icon: BookOpenIcon,
			width: pageControlsWidth(!phone),
			priority: Infinity,
			content: (
				<PageControls
					page={state.page}
					total={state.pageCount}
					ends={!phone}
					canPrevious={isPdfCommandEnabled(state, "page.previous")}
					canNext={isPdfCommandEnabled(state, "page.next")}
					onGo={page => {
						dispatch({ type: "page.goto", page })
					}}
					onPrevious={command({ type: "page.previous" })}
					onNext={command({ type: "page.next" })}
					onFirst={command({ type: "page.first" })}
					onLast={command({ type: "page.last" })}
					inputRef={pageInputRef}
				/>
			)
		},
		{
			id: "zoom",
			label: t("previewOfficeRibbonZoom"),
			icon: ZoomInIcon,
			width: ZOOM_CONTROLS_WIDTH,
			priority: 5,
			content: (
				<ZoomControls
					percent={state.zoom}
					presets={PDF_ZOOM_PRESETS}
					fits={["fitWidth", "fitPage"]}
					mode={state.zoomMode}
					canIn={isPdfCommandEnabled(state, "zoom.in")}
					canOut={isPdfCommandEnabled(state, "zoom.out")}
					onIn={command({ type: "zoom.in" })}
					onOut={command({ type: "zoom.out" })}
					inShortcut={<Kbd action="preview.pdfZoomIn" />}
					outShortcut={<Kbd action="preview.pdfZoomOut" />}
					fitShortcuts={PDF_FIT_SHORTCUTS}
					onPercent={percent => {
						dispatch({ type: "zoom.set", scale: pdfPercentScale(percent) })
					}}
					onFit={fit => {
						dispatch({ type: fit === "fitWidth" ? "zoom.fitWidth" : "zoom.fitPage" })
					}}
				/>
			)
		},
		{
			id: "rotate",
			label: t("previewCommandBarRotate"),
			icon: RotateCwIcon,
			width: 2 * BAR_BUTTON,
			priority: 2,
			content: (
				<>
					<RibbonButton
						label={t("previewCommandBarRotateLeft")}
						icon={<RotateCcwIcon />}
						shortcut={<Kbd action="preview.pdfRotateCcw" />}
						onClick={command({ type: "rotate.counterClockwise" })}
					/>
					<RibbonButton
						label={t("previewCommandBarRotateRight")}
						icon={<RotateCwIcon />}
						shortcut={<Kbd action="preview.pdfRotateCw" />}
						onClick={command({ type: "rotate.clockwise" })}
					/>
				</>
			)
		}
	]

	if (outline.length > 0) {
		groups.push({
			id: "outline",
			label: t("previewCommandBarOutline"),
			icon: ListTreeIcon,
			width: BAR_MENU,
			priority: 3,
			single: true,
			content: outlineMenu(t("previewCommandBarOutline"), document, outline, dispatch)
		})
	}

	if (fullscreenSupported()) {
		groups.push({
			id: "view",
			label: t("previewOfficeRibbonTabView"),
			icon: MaximizeIcon,
			width: BAR_BUTTON,
			priority: 1,
			single: true,
			content: <FullScreenButton />
		})
	}

	groups.push({
		id: "find",
		label: t("previewEditorFind"),
		icon: SearchIcon,
		width: BAR_BUTTON,
		priority: Infinity,
		single: true,
		content: (
			<RibbonButton
				label={t("previewDocxFindAction")}
				icon={<SearchIcon />}
				shortcut={<Kbd action="editor.find" />}
				onClick={command({ type: "find.open" })}
			/>
		)
	})

	return {
		file: (
			<CommandFileMenu>
				{onDownload === null ? null : <DropdownMenuItem onClick={onDownload}>{t("previewDownloadAction")}</DropdownMenuItem>}
				{onPrint === undefined ? null : (
					<DropdownMenuItem onClick={onPrint}>
						{t("previewPdfPrintMenu")}
						<MenuShortcut>
							<Kbd action="office.print" />
						</MenuShortcut>
					</DropdownMenuItem>
				)}
				<DropdownMenuItem onClick={onProperties}>{t("previewCommandBarProperties")}</DropdownMenuItem>
			</CommandFileMenu>
		),
		groups,
		replacement: state.find.open ? (
			<DocxFindField
				find={findControls(state, dispatch)}
				focus={findFocus}
				onClosed={onFindClosed}
			/>
		) : undefined,
		status: (
			<span className="flex items-center gap-3 text-xs whitespace-nowrap text-muted-foreground tabular-nums max-sm:hidden">
				<span>{t("previewPdfPageIndicator", { current: state.page, total: state.pageCount })}</span>
				<span>{t("previewPdfZoomIndicator", { percent: state.zoom })}</span>
			</span>
		)
	}
}
