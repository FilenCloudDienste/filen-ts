import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { toast } from "sonner"
import {
	ArrowDownIcon,
	ArrowLeftIcon,
	ArrowRightIcon,
	ArrowUpIcon,
	CircleIcon,
	CloudIcon,
	DiamondIcon,
	FrameIcon,
	HeartIcon,
	HexagonIcon,
	ImageIcon,
	MinusIcon,
	OctagonIcon,
	PentagonIcon,
	PlusIcon,
	RectangleHorizontalIcon,
	ShapesIcon,
	SmileIcon,
	SquareIcon,
	StarIcon,
	TableIcon,
	TriangleIcon,
	TriangleRightIcon,
	TypeIcon,
	type LucideIcon
} from "lucide-react"
import { imageDimensions } from "@filen/office/core/opc"
import {
	DEFAULT_PRESENTATION_BUDGETS,
	MAX_INSERT_COLS,
	MAX_INSERT_ROWS,
	SHAPE_GALLERY,
	insertPictureOp,
	insertShapeOp,
	insertTableOp,
	insertTextBoxOp,
	nextShapeIdOf,
	type DeckOp,
	type GalleryPreset,
	type InsertDeck,
	type InsertedImage,
	type ShapeGalleryGroup,
	type SlideRef
} from "@filen/office/core/presentation"
import type { PresentationSessionApi } from "@filen/office/dom/presentation"
import { slideShapes, useShapeSelection } from "@filen/office/react/presentation"
import { cn } from "@filen/shared"
import { FormDialog } from "@/components/dialogs/formDialog"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator
} from "@/components/ui/dropdown-menu"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { DriveFilePickerDialog } from "@/features/drive/components/driveFilePickerDialog"
import type { DriveItem } from "@/features/drive/lib/item"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { keepFocus } from "@/features/office/lib/officeControls"
import { useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import { BROWSER_PICTURE_CODECS, driveSource, fileSource } from "@/features/preview/lib/docxImages"
import {
	isPictureFile,
	pictureRefusalKey,
	preparePicture,
	type DocxPictureRefusal,
	type PictureCodecs,
	type PictureSource
} from "@/features/preview/lib/docxImages.logic"
import { useRibbonDialog } from "@/features/presentation/components/ribbon/ribbonDialogs"
import type { PresentationGroups, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import type { PreviewKey } from "@/lib/i18n"
import { log } from "@/lib/log"

// The Insert tab's objects: a table (a size grid, or any size), pictures (this device, the drive; pasted and dropped
// ones through usePresentationPictureDrop), the preset shapes gallery and a text box. Each insert is one op through
// the editor's session, its new shape selected once the slide shows it. Pictures go through the DOCX editor's
// preparation (sized from their header before any decode, WebP and SVG made PNG), with the presentation's own pixel
// budget (≤ 50 megapixels, the deck's decodedPixels budget) in place of Word's.

const BUTTON = 30
const MENU = 44
const GRID_COLS = 10
const GRID_ROWS = 8
// A presentation's picture budget (decoded pixels), above Word's 20 megapixels.
const PRESENTATION_PIXELS = DEFAULT_PRESENTATION_BUDGETS.decodedPixels
const PICTURE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.svg,.webp"

const GROUP_KEYS: Readonly<Record<ShapeGalleryGroup, PreviewKey>> = {
	lines: "previewPptxShapesLines",
	rectangles: "previewPptxShapesRectangles",
	basic: "previewPptxShapesBasic",
	arrows: "previewPptxShapesArrows",
	stars: "previewPptxShapesStars"
}

const PRESETS: Readonly<Record<GalleryPreset, { readonly label: PreviewKey; readonly icon: LucideIcon }>> = {
	line: { label: "previewPptxShapeLine", icon: MinusIcon },
	rect: { label: "previewPptxShapeRect", icon: RectangleHorizontalIcon },
	roundRect: { label: "previewPptxShapeRoundRect", icon: SquareIcon },
	ellipse: { label: "previewPptxShapeEllipse", icon: CircleIcon },
	triangle: { label: "previewPptxShapeTriangle", icon: TriangleIcon },
	rtTriangle: { label: "previewPptxShapeRtTriangle", icon: TriangleRightIcon },
	parallelogram: { label: "previewPptxShapeParallelogram", icon: RectangleHorizontalIcon },
	trapezoid: { label: "previewPptxShapeTrapezoid", icon: TriangleIcon },
	diamond: { label: "previewPptxShapeDiamond", icon: DiamondIcon },
	pentagon: { label: "previewPptxShapePentagon", icon: PentagonIcon },
	hexagon: { label: "previewPptxShapeHexagon", icon: HexagonIcon },
	octagon: { label: "previewPptxShapeOctagon", icon: OctagonIcon },
	plus: { label: "previewPptxShapePlus", icon: PlusIcon },
	donut: { label: "previewPptxShapeDonut", icon: CircleIcon },
	frame: { label: "previewPptxShapeFrame", icon: FrameIcon },
	heart: { label: "previewPptxShapeHeart", icon: HeartIcon },
	smileyFace: { label: "previewPptxShapeSmileyFace", icon: SmileIcon },
	cloud: { label: "previewPptxShapeCloud", icon: CloudIcon },
	rightArrow: { label: "previewPptxShapeRightArrow", icon: ArrowRightIcon },
	leftArrow: { label: "previewPptxShapeLeftArrow", icon: ArrowLeftIcon },
	upArrow: { label: "previewPptxShapeUpArrow", icon: ArrowUpIcon },
	downArrow: { label: "previewPptxShapeDownArrow", icon: ArrowDownIcon },
	star5: { label: "previewPptxShapeStar5", icon: StarIcon }
}

// The slide in view: the ribbon's render reaches it only while shapes are selected, the selection store always.
export function useSlideInView(editor: PresentationRibbonEditor): SlideRef | undefined {
	const state = useShapeSelection(editor.selection)

	return editor.render?.ref ?? state.slide
}

// Runs an insert (built with the slide's next shape id) and selects what it made once the slide shows it. The slide's
// shapes come from the ribbon's render, else from the session's (rendered once for the insert).
export async function insertObject(
	editor: PresentationRibbonEditor,
	build: (slide: SlideRef, id: number) => DeckOp | undefined
): Promise<void> {
	const slide = editor.render?.ref ?? editor.selection.getSnapshot().slide

	if (slide === undefined) return

	const render = editor.render?.ref === slide ? editor.render : (await editor.session.render([slide]))[0]

	if (render === undefined) return

	const order = slideShapes(render).map(shape => shape.id)
	const op = build(slide, nextShapeIdOf(render.layers.map(layer => layer.shape.id)))

	if (op === undefined) return

	const withdraw = editor.selection.selectNew(slide, order)

	if (!(await editor.command(op)).ok) withdraw()
}

// ---- pictures ----------------------------------------------------------------------------------------------------

type Prepared = { readonly ok: true; readonly image: InsertedImage } | { readonly ok: false; readonly refusal: DocxPictureRefusal }

// A picture made what a slide holds: the DOCX preparation (read once, sized from its header as its EXIF orientation
// turns it, WebP made PNG, SVG with its PNG rendition) within a presentation's pixel budget in place of Word's.
export async function preparePresentationPicture(
	source: PictureSource,
	signal: AbortSignal,
	codecs: PictureCodecs = BROWSER_PICTURE_CODECS
): Promise<Prepared> {
	const prepared = await preparePicture(source, codecs, signal, PRESENTATION_PIXELS)

	if (!prepared.ok) return prepared

	const value = prepared.value
	// An SVG goes in as its PNG rendition (every reader of the deck draws that).
	const bytes = value.fallback ?? value.bytes
	const size = value.fallback === undefined ? { width: value.info.width, height: value.info.height } : imageDimensions(bytes)
	const contentType = value.fallback === undefined ? value.info.contentType : "image/png"

	if (size === undefined || size.width < 1 || size.height < 1) return { ok: false, refusal: "corrupt" }

	return { ok: true, image: { bytes, contentType, width: size.width, height: size.height } }
}

// Pictures into the slide in view, or in place of a picture (`replace`): prepared one by one, each one op. `signal`
// ends the run; a refusal or a failure before then is said in a toast.
async function takePictures(
	editor: PresentationRibbonEditor,
	sources: readonly PictureSource[],
	replace: number | undefined,
	signal: AbortSignal,
	t: TFunction<"preview">
): Promise<void> {
	for (const source of sources) {
		try {
			const prepared = await preparePresentationPicture(source, signal)

			if (!prepared.ok) {
				toast.error(t(pictureRefusalKey(prepared.refusal)))

				continue
			}

			if (replace !== undefined) {
				// Change Picture acts on the selected picture, on the slide in view.
				const slide = editor.render?.ref ?? editor.selection.getSnapshot().slide

				if (slide !== undefined)
					void editor.command({
						family: "picture",
						kind: "replace",
						target: { slide, id: replace },
						image: prepared.image
					})
			} else {
				// Onto the slide in view, selected or not (insertObject finds it); no alt text until the user writes one.
				const deck: InsertDeck = { size: editor.info.size, format: editor.info.format }

				await insertObject(editor, (at, id) => insertPictureOp(deck, at, prepared.image, id))
			}
		} catch (error) {
			if (!signal.aborted) {
				log.warn("pptx", "picture not inserted", { error })
				toast.error(t(pictureRefusalKey("failed")))
			}
		}
	}
}

// Picture runs a ribbon command started, per session. The command's control may be gone before they end (one run from
// the ribbon's overflow closes it with the popup), so they end with the session: when the editor's own pictures hook
// (usePresentationPictures, mounted for the session) lets go of it.
const sessionRuns = new WeakMap<PresentationSessionApi, Set<AbortController>>()

function takeForSession(
	editor: PresentationRibbonEditor,
	sources: readonly PictureSource[],
	replace: number | undefined,
	t: TFunction<"preview">
): void {
	let runs = sessionRuns.get(editor.session)

	if (runs === undefined) {
		runs = new Set()
		sessionRuns.set(editor.session, runs)
	}

	const all = runs
	const controller = new AbortController()

	all.add(controller)
	void takePictures(editor, sources, replace, controller.signal, t).finally(() => {
		all.delete(controller)
	})
}

// Pictures into the slide in view, or in place of a picture (`replace`), for as long as the hook is mounted; the
// session's ribbon runs (takeForSession) end once it lets go of the session.
export function usePresentationPictures(editor: PresentationRibbonEditor | undefined): {
	readonly take: (sources: readonly PictureSource[], replace?: number) => Promise<void>
} {
	const { t } = useTranslation("preview")
	const running = useRef(new Set<AbortController>())
	const session = editor?.session

	useEffect(() => {
		const all = running.current

		return () => {
			for (const controller of all) controller.abort()
		}
	}, [])

	useEffect(() => {
		if (session === undefined) return

		return () => {
			for (const controller of sessionRuns.get(session) ?? []) controller.abort()

			sessionRuns.delete(session)
		}
	}, [session])

	return {
		take: async (sources, replace) => {
			if (editor === undefined) return

			const controller = new AbortController()

			running.current.add(controller)

			try {
				await takePictures(editor, sources, replace, controller.signal, t)
			} finally {
				running.current.delete(controller)
			}
		}
	}
}

// Pictures pasted or dropped on the editor (the shell puts these on the slide's container).
export function usePresentationPictureDrop(editor: PresentationRibbonEditor | undefined): {
	readonly onPasteCapture: (event: React.ClipboardEvent) => void
	readonly onDragOverCapture: (event: React.DragEvent) => void
	readonly onDropCapture: (event: React.DragEvent) => void
} {
	const pictures = usePresentationPictures(editor)
	const editable = editor?.info.editable === true

	return {
		onDragOverCapture: event => {
			if (!event.dataTransfer.types.includes("Files")) return

			event.preventDefault()
			event.dataTransfer.dropEffect = editable ? "copy" : "none"
		},
		onDropCapture: event => {
			const files = [...event.dataTransfer.files]

			if (files.length === 0) return

			// Never left to the browser (it would open the file in place of the app).
			event.preventDefault()
			event.stopPropagation()

			if (editable) void pictures.take(files.map(fileSource))
		},
		onPasteCapture: event => {
			const files = [...event.clipboardData.files].filter(file => file.type.startsWith("image/"))

			// Text on the clipboard is the text editor's to paste.
			if (files.length === 0 || event.clipboardData.getData("text/plain") !== "") return

			event.preventDefault()
			event.stopPropagation()

			if (editable) void pictures.take(files.map(fileSource))
		}
	}
}

// Opens the file chooser for pictures. The input is the chooser's own, not the control's: a command run from the
// ribbon's overflow closes it, and the control with it, while the chooser is still open.
export function choosePictures(onFiles: (files: File[]) => void): void {
	const input = document.createElement("input")

	input.type = "file"
	input.accept = PICTURE_ACCEPT
	input.multiple = true
	input.addEventListener(
		"change",
		() => {
			const files = [...(input.files ?? [])]

			if (files.length > 0) onFiles(files)
		},
		{ once: true }
	)
	input.click()
}

// This device or the drive; `replace` puts the first picture taken in place of that picture.
export function PictureSourceMenu({
	editor,
	label,
	icon,
	replace,
	text
}: {
	editor: PresentationRibbonEditor
	label: string
	icon: React.ReactNode
	replace?: number
	text?: string
}) {
	const { t } = useTranslation("preview")
	const slide = useSlideInView(editor)
	const dialog = useRibbonDialog(editor)
	const focus = useCommandMenuFocus()

	return (
		<>
			<DropdownMenu onOpenChange={focus.opened}>
				<RibbonMenuTrigger
					label={label}
					icon={icon}
					text={text}
					disabled={slide === undefined}
				/>
				<DropdownMenuContent
					finalFocus={focus.finalFocus}
					data-preview-surface
				>
					<DropdownMenuItem
						onClick={() => {
							focus.ran()
							choosePictures(files => {
								takeForSession(editor, (replace === undefined ? files : files.slice(0, 1)).map(fileSource), replace, t)
							})
						}}
					>
						{t("previewPptxInsertPictureDevice")}
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => {
							focus.ran()
							dialog.open((live, close) => (
								<DriveFilePickerDialog
									title={t("previewPptxInsertPictureDriveTitle")}
									description={t("previewPptxInsertPictureDriveDescription")}
									accept={isPictureFile}
									onPick={async (item: DriveItem, signal: AbortSignal) => {
										// The picker's signal: it ends with the dialog, and the dialog with the session.
										await takePictures(live, [driveSource(item)], replace, signal, t)

										if (!signal.aborted) close()
									}}
									onClose={close}
								/>
							))
						}}
					>
						{t("previewPptxInsertPictureDrive")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{dialog.view}
		</>
	)
}

// ---- table -------------------------------------------------------------------------------------------------------

function TableSizeDialog({ editor, onClose }: { editor: PresentationRibbonEditor; onClose: () => void }) {
	const { t } = useTranslation("preview")
	const [rows, setRows] = useState("2")
	const [cols, setCols] = useState("5")
	const rowsId = useId()
	const colsId = useId()
	const parsed = (value: string, max: number): number | undefined => {
		const number = Number(value)

		return Number.isInteger(number) && number >= 1 && number <= max ? number : undefined
	}
	const rowCount = parsed(rows, MAX_INSERT_ROWS)
	const colCount = parsed(cols, MAX_INSERT_COLS)

	return (
		<FormDialog
			open
			pending={false}
			title={t("previewPptxInsertTableTitle")}
			description={t("previewPptxInsertTableDescription")}
			submitLabel={t("previewPptxInsertApply")}
			cancelLabel={t("previewPptxInsertCancel")}
			canSubmit={rowCount !== undefined && colCount !== undefined}
			onOpenChange={open => {
				if (!open) onClose()
			}}
			onSubmit={event => {
				event.preventDefault()

				if (rowCount === undefined || colCount === undefined) return

				const deck: InsertDeck = { size: editor.info.size, format: editor.info.format }

				void insertObject(editor, (slide, id) => insertTableOp(deck, slide, rowCount, colCount, id))
				onClose()
			}}
		>
			<Field data-invalid={colCount === undefined}>
				<FieldLabel htmlFor={colsId}>{t("previewPptxInsertTableColumns")}</FieldLabel>
				<Input
					id={colsId}
					inputMode="numeric"
					value={cols}
					aria-invalid={colCount === undefined}
					onChange={event => {
						setCols(event.target.value)
					}}
				/>
				{colCount === undefined ? <FieldError>{t("previewPptxInsertTableRange", { max: MAX_INSERT_COLS })}</FieldError> : null}
			</Field>
			<Field data-invalid={rowCount === undefined}>
				<FieldLabel htmlFor={rowsId}>{t("previewPptxInsertTableRows")}</FieldLabel>
				<Input
					id={rowsId}
					inputMode="numeric"
					value={rows}
					aria-invalid={rowCount === undefined}
					onChange={event => {
						setRows(event.target.value)
					}}
				/>
				{rowCount === undefined ? <FieldError>{t("previewPptxInsertTableRange", { max: MAX_INSERT_ROWS })}</FieldError> : null}
			</Field>
		</FormDialog>
	)
}

// Up and Down in the size grid move a row (the menu's own order moves a cell). Down from the last row goes to the
// menu's next item (Insert table); Up from the first row is the menu's to take.
function gridKey(event: React.KeyboardEvent<HTMLElement>, index: number): void {
	const step = event.key === "ArrowDown" ? GRID_COLS : event.key === "ArrowUp" ? -GRID_COLS : 0
	const target = index + step
	const cells = event.currentTarget.parentElement?.children

	if (step === 0 || target < 0 || cells === undefined) return

	let next: Element | null | undefined = cells.item(target)

	if (target >= cells.length) {
		const last = cells.item(cells.length - 1)
		const items = [...(event.currentTarget.closest('[role="menu"]')?.querySelectorAll('[role^="menuitem"]') ?? [])]

		next = last === null ? undefined : items[items.indexOf(last) + 1]
	}

	if (!(next instanceof HTMLElement)) return

	event.preventDefault()
	event.stopPropagation()
	next.focus()
}

function TableMenu({ editor }: { editor: PresentationRibbonEditor }) {
	const slide = useSlideInView(editor)
	const { t } = useTranslation("preview")
	const [hover, setHover] = useState<{ readonly rows: number; readonly cols: number }>({ rows: 0, cols: 0 })
	const dialog = useRibbonDialog(editor)
	const focus = useCommandMenuFocus()
	const insert = (rows: number, cols: number): void => {
		const deck: InsertDeck = { size: editor.info.size, format: editor.info.format }

		void insertObject(editor, (slide, id) => insertTableOp(deck, slide, rows, cols, id))
	}

	return (
		<>
			<DropdownMenu onOpenChange={focus.opened}>
				<RibbonMenuTrigger
					label={t("previewPptxInsertTable")}
					icon={<TableIcon />}
					disabled={slide === undefined}
				/>
				<DropdownMenuContent
					finalFocus={focus.finalFocus}
					data-preview-surface
				>
					<DropdownMenuGroup>
						<DropdownMenuLabel>
							{hover.rows === 0
								? t("previewPptxInsertTable")
								: t("previewPptxInsertTableGrid", { cols: hover.cols, rows: hover.rows })}
						</DropdownMenuLabel>
						<div
							role="group"
							aria-label={t("previewPptxInsertTable")}
							className="grid gap-0.5 p-1"
							style={{ gridTemplateColumns: `repeat(${String(GRID_COLS)}, 1rem)` }}
							onMouseLeave={() => {
								setHover({ rows: 0, cols: 0 })
							}}
						>
							{Array.from({ length: GRID_ROWS * GRID_COLS }, (_, index) => {
								const rows = Math.floor(index / GRID_COLS) + 1
								const cols = (index % GRID_COLS) + 1
								const lit = rows <= hover.rows && cols <= hover.cols

								return (
									<DropdownMenuItem
										key={index}
										aria-label={t("previewPptxInsertTableGrid", { cols, rows })}
										className={cn(
											"size-4 rounded-none border border-border p-0",
											lit && "border-primary bg-primary/20"
										)}
										onFocus={() => {
											setHover({ rows, cols })
										}}
										onMouseEnter={() => {
											setHover({ rows, cols })
										}}
										onMouseDown={keepFocus}
										onKeyDown={event => {
											gridKey(event, index)
										}}
										onClick={() => {
											focus.ran()
											insert(rows, cols)
										}}
									/>
								)
							})}
						</div>
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onClick={() => {
							focus.ran()
							dialog.open((live, close) => (
								<TableSizeDialog
									editor={live}
									onClose={close}
								/>
							))
						}}
					>
						{t("previewPptxInsertTableCustom")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{dialog.view}
		</>
	)
}

// ---- shapes and text box -----------------------------------------------------------------------------------------

function ShapesMenu({ editor }: { editor: PresentationRibbonEditor }) {
	const slide = useSlideInView(editor)
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()
	const deck: InsertDeck = { size: editor.info.size, format: editor.info.format }

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<RibbonMenuTrigger
				label={t("previewPptxInsertShapes")}
				icon={<ShapesIcon />}
				disabled={slide === undefined}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
				className="max-h-96 overflow-y-auto"
			>
				{(Object.keys(SHAPE_GALLERY) as ShapeGalleryGroup[]).map((group, index) => (
					<DropdownMenuGroup key={group}>
						{index === 0 ? null : <DropdownMenuSeparator />}
						<DropdownMenuLabel>{t(GROUP_KEYS[group])}</DropdownMenuLabel>
						{SHAPE_GALLERY[group].map(preset => {
							const { label, icon: Icon } = PRESETS[preset]

							return (
								<DropdownMenuItem
									key={preset}
									onClick={() => {
										focus.ran()
										void insertObject(editor, (slide, id) => insertShapeOp(deck, slide, preset, id))
									}}
								>
									<Icon />
									{t(label)}
								</DropdownMenuItem>
							)
						})}
					</DropdownMenuGroup>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function TextBoxButton({ editor }: { editor: PresentationRibbonEditor }) {
	const slide = useSlideInView(editor)
	const { t } = useTranslation("preview")
	const deck: InsertDeck = { size: editor.info.size, format: editor.info.format }

	return (
		<RibbonButton
			label={t("previewPptxInsertTextBox")}
			icon={<TypeIcon />}
			disabled={slide === undefined}
			onClick={() => {
				void insertObject(editor, (slide, id) => insertTextBoxOp(deck, slide, id))
			}}
		/>
	)
}

function PicturesControl({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")

	return (
		<PictureSourceMenu
			editor={editor}
			label={t("previewPptxInsertPictures")}
			icon={<ImageIcon />}
		/>
	)
}

export const insertObjectsGroups: PresentationGroups = context => {
	const editor = context.editor

	if (editor === undefined || !context.editable) return []

	const t = context.t

	return [
		{
			id: "table",
			label: t("previewPptxInsertTable", { ns: "preview" }),
			icon: TableIcon,
			width: MENU,
			priority: 4,
			single: true,
			content: <TableMenu editor={editor} />
		},
		{
			id: "pictures",
			label: t("previewPptxInsertPictures", { ns: "preview" }),
			icon: ImageIcon,
			width: MENU,
			priority: 4,
			single: true,
			content: <PicturesControl editor={editor} />
		},
		{
			id: "shapes",
			label: t("previewPptxInsertShapes", { ns: "preview" }),
			icon: ShapesIcon,
			width: MENU,
			priority: 3,
			single: true,
			content: <ShapesMenu editor={editor} />
		},
		{
			id: "textBox",
			label: t("previewPptxInsertTextBox", { ns: "preview" }),
			icon: TypeIcon,
			width: BUTTON,
			priority: 3,
			single: true,
			content: <TextBoxButton editor={editor} />
		}
	]
}
