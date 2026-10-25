import { useEffect, useState, type CSSProperties } from "react"
import { useTranslation } from "react-i18next"
import { BookOpenIcon, ListTreeIcon, MaximizeIcon, RotateCcwIcon, RotateCwIcon, SearchIcon, ZoomInIcon } from "lucide-react"
import { formatBytes } from "@filen/shared"
import {
	isPdfCommandEnabled,
	loadPdfInfo,
	pdfPercentScale,
	resolveDestination,
	PDF_ZOOM_PRESETS,
	type PdfDocumentInfo,
	type PdfOutlineItem,
	type PdfViewerCommand,
	type PdfViewerState
} from "@filen/office/dom/pdf"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import { OfficeCommandBar, type RibbonGroup } from "@/features/office/components/ribbon/officeRibbon"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { usePhoneWidth } from "@/features/office/components/ribbon/phoneMedia"
import { CommandFileMenu, FullScreenButton, PageControls, ZoomControls } from "@/features/preview/components/commandBarControls"
import { BAR_BUTTON, BAR_MENU, pageControlsWidth, ZOOM_CONTROLS_WIDTH } from "@/features/preview/components/commandBar.logic"
import { DocxFindField } from "@/features/preview/components/docxToolbar"
import type { DocxFindControls } from "@/features/preview/components/docxViewer.logic"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { fullscreenSupported } from "@/lib/media/fullscreen"
import { formatDateTime } from "@/lib/formatDate"
import { Kbd } from "@/lib/keymap/kbd"

// The PDF viewer's command bar (OfficeCommandBar): File (Download, Document properties), then Pages (first,
// previous, the page number field, next, last), Zoom (out, the zoom menu with its steps and fits, in), Rotate,
// Outline (the document's bookmarks, when it has any), Full screen and Find; the page and the zoom at the end. The
// find field takes the groups' place while finding. Everything it shows is the viewer's state, everything it does a
// viewer command. Print is not offered: the CSP allows no frame (the browser's own PDF viewer cannot be asked to
// print), and printing from here would mean rendering every page at print resolution.

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

function OutlineMenu({
	document,
	outline,
	dispatch
}: {
	document: PdfDomDocument
	outline: readonly PdfOutlineItem[]
	dispatch: (command: PdfViewerCommand) => void
}) {
	const { t } = useTranslation("preview")

	return (
		<DropdownMenu>
			<RibbonMenuTrigger
				label={t("previewCommandBarOutline")}
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
									void resolveDestination(document, dest).then(page => {
										if (page !== null) {
											dispatch({ type: "page.goto", page })
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
	onProperties: () => void
}

export function PdfCommandBar({
	state,
	dispatch,
	document,
	outline,
	findFocus,
	onFindClosed,
	onDownload,
	onProperties
}: PdfCommandBarProps) {
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
						onClick={command({ type: "rotate.counterClockwise" })}
					/>
					<RibbonButton
						label={t("previewCommandBarRotateRight")}
						icon={<RotateCwIcon />}
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
			content: (
				<OutlineMenu
					document={document}
					outline={outline}
					dispatch={dispatch}
				/>
			)
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

	return (
		<OfficeCommandBar
			label={t("previewOfficeRibbonCommands")}
			file={
				<CommandFileMenu>
					{onDownload === null ? null : <DropdownMenuItem onClick={onDownload}>{t("previewDownloadAction")}</DropdownMenuItem>}
					<DropdownMenuItem onClick={onProperties}>{t("previewCommandBarProperties")}</DropdownMenuItem>
				</CommandFileMenu>
			}
			groups={groups}
			replacement={
				state.find.open ? (
					<DocxFindField
						find={findControls(state, dispatch)}
						focus={findFocus}
						onClosed={onFindClosed}
					/>
				) : undefined
			}
			status={
				<span className="flex items-center gap-3 text-xs whitespace-nowrap text-muted-foreground tabular-nums max-sm:hidden">
					<span>{t("previewPdfPageIndicator", { current: state.page, total: state.pageCount })}</span>
					<span>{t("previewPdfZoomIndicator", { percent: state.zoom })}</span>
				</span>
			}
		/>
	)
}

function PropertyRow({ label, value }: { label: string; value: string | null }) {
	const { t } = useTranslation("preview")

	return (
		<>
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="min-w-0 break-words">{value ?? t("previewCommandBarPropertyNone")}</dd>
		</>
	)
}

// What the document says about itself (its Info dictionary, read once per document) and what the viewer knows.
export function PdfPropertiesDialog({
	open,
	onOpenChange,
	document,
	size
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	document: PdfDomDocument
	// The file's bytes.
	size: number
}) {
	const { t } = useTranslation("preview")
	const [info, setInfo] = useState<{ document: PdfDomDocument; info: PdfDocumentInfo } | null>(null)
	const shown = info?.document === document ? info.info : null

	useEffect(() => {
		if (!open) {
			return undefined
		}

		let live = true

		void loadPdfInfo(document).then(read => {
			if (live) {
				setInfo({ document, info: read })
			}
		})

		return () => {
			live = false
		}
	}, [open, document])

	const date = (value: Date | null | undefined): string | null =>
		value === null || value === undefined ? null : formatDateTime(value.getTime())

	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent data-preview-surface>
				<DialogHeader>
					<DialogTitle>{t("previewCommandBarProperties")}</DialogTitle>
				</DialogHeader>
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
					<PropertyRow
						label={t("previewCommandBarPropertyTitle")}
						value={shown?.title ?? null}
					/>
					<PropertyRow
						label={t("previewCommandBarPropertyAuthor")}
						value={shown?.author ?? null}
					/>
					<PropertyRow
						label={t("previewCommandBarPropertySubject")}
						value={shown?.subject ?? null}
					/>
					<PropertyRow
						label={t("previewCommandBarPropertyKeywords")}
						value={shown?.keywords ?? null}
					/>
					<PropertyRow
						label={t("previewCommandBarPropertyCreator")}
						value={shown?.creator ?? null}
					/>
					<PropertyRow
						label={t("previewCommandBarPropertyProducer")}
						value={shown?.producer ?? null}
					/>
					<PropertyRow
						label={t("previewCommandBarPropertyCreated")}
						value={date(shown?.created)}
					/>
					<PropertyRow
						label={t("previewCommandBarPropertyModified")}
						value={date(shown?.modified)}
					/>
					<PropertyRow
						label={t("previewCommandBarPropertyPages")}
						value={String(document.numPages)}
					/>
					<PropertyRow
						label={t("previewCommandBarPropertySize")}
						value={formatBytes(size)}
					/>
					<PropertyRow
						label={t("previewCommandBarPropertyVersion")}
						value={shown?.version ?? null}
					/>
				</dl>
			</DialogContent>
		</Dialog>
	)
}
