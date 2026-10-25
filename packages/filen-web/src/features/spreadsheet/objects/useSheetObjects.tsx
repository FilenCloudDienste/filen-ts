import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { SheetCommand } from "@filen/office/core/sheet"
import type {
	SheetCellPointer,
	SheetGridExtension,
	SheetGridHandle,
	SheetGridModel,
	SheetGridState,
	SheetShortcut
} from "@filen/office/react/sheet"
import { SheetObjects, objectAt, objectInView, type SheetDrawingObject, type SheetObjectSource } from "@filen/office/react/sheet/drawings"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { ContextMenuItem, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from "@/components/ui/context-menu"
import { DriveFilePickerDialog } from "@/features/drive/components/driveFilePickerDialog"
import type { DriveItem } from "@/features/drive/lib/item"
import { BROWSER_PICTURE_CODECS, driveSource, fileSource } from "@/features/preview/lib/docxImages"
import { isPictureFile, preparePicture, type PictureSource } from "@/features/preview/lib/docxImages.logic"
import type { SheetBodyExtension } from "@/features/spreadsheet/components/sheetExtension"
import type { SheetHandle } from "@/features/spreadsheet/hooks/useSheetSession"
import { clearImageRequest, useImageRequest } from "@/features/spreadsheet/objects/insertRequests"
import { objectLabel, objectsEditable, pictureRefusalKey } from "@/features/spreadsheet/objects/objects.logic"
import { selectObject, useObjectSelection } from "@/features/spreadsheet/objects/objectSelection"
import type { PreviewKey } from "@/lib/i18n"
import { log } from "@/lib/log"

// Pictures, shapes, text boxes and chart frames over the grid: drawn on their anchors, selected by a click (a click
// on a cell gives the selection back to the cells), moved and resized by dragging, nudged by the arrows, deleted,
// given alternative text from the grid's menu, and pictures inserted at the active cell from this device or the drive
// (the grid's menu, the toolbar's Insert menu through insertRequests). Ctrl+Alt+5 selects the first object in view
// from the cells (Excel's key for floating shapes); Tab then cycles them. Chart frames are drawn by `renderChart`.

// What the file chooser offers: pictures a workbook shows, and WebP (converted).
const PICTURE_ACCEPT = "image/*,.svg,.emf,.wmf,.tif,.tiff,.webp"

export interface SheetObjectsOptions {
	grid: SheetGridState
	gridRef: RefObject<SheetGridHandle | null>
	handle: SheetHandle
	canEdit: boolean
	// A text file: it holds no objects.
	text: boolean
	// Draws a chart frame at its size in px and the zoom (the charts feature); a placeholder without it.
	renderChart?: ((object: SheetDrawingObject, width: number, height: number, scale: number) => ReactNode) | undefined
	// A chart frame double-clicked: its editor opens.
	onEditObject?: ((object: SheetDrawingObject) => void) | undefined
}

interface TakeDeps {
	// Controllers of the pictures under way (aborted when the view closes).
	readonly running: Set<AbortController>
	readonly model: SheetGridModel
	readonly run: (command: SheetCommand) => Promise<boolean>
	readonly say: (key: PreviewKey, kind: "info" | "error") => void
}

// One picture through the shared pipeline (size, header, WebP to PNG, an SVG's PNG), then into the sheet at the
// active cell; the new picture is selected. True when it went in.
async function takePicture(source: PictureSource, outer: AbortSignal | undefined, deps: TakeDeps): Promise<boolean> {
	const controller = new AbortController()
	const abort = (): void => {
		controller.abort()
	}

	outer?.addEventListener("abort", abort, { once: true })
	deps.running.add(controller)

	try {
		const prepared = await preparePicture(source, BROWSER_PICTURE_CODECS, controller.signal)

		if (!prepared.ok) {
			deps.say(pictureRefusalKey(prepared.refusal), "error")

			return false
		}

		const { sheet, selection } = deps.model.getSnapshot()
		const inserted = await deps.run({
			type: "drawing.insertImage",
			sheet,
			placement: { from: { row: selection.active.row, col: selection.active.col, rowOff: 0, colOff: 0 } },
			bytes: prepared.value.bytes,
			...(prepared.value.fallback === undefined ? {} : { fallback: prepared.value.fallback }),
			name: "",
			alt: ""
		})

		if (!inserted) {
			return false
		}

		if (prepared.value.animated === true) {
			deps.say("previewSheetObjectAnimated", "info")
		}

		const added = deps.model.layout(sheet)?.extensions?.drawings?.objects.at(-1)

		if (added !== undefined) {
			selectObject(deps.model, { sheet, key: added.key })
		}

		return true
	} catch (error) {
		if (!controller.signal.aborted) {
			log.warn("preview", "spreadsheet picture not inserted", { error })
			deps.say("previewSheetObjectFailed", "error")
		}

		return false
	} finally {
		outer?.removeEventListener("abort", abort)
		deps.running.delete(controller)
	}
}

export function useSheetObjects({
	grid,
	gridRef,
	handle,
	canEdit,
	text,
	renderChart,
	onEditObject
}: SheetObjectsOptions): SheetBodyExtension {
	const { t } = useTranslation(["preview", "common"])
	const model = grid.model
	const selection = useObjectSelection(model)
	const request = useImageRequest(model)
	const fileInputRef = useRef<HTMLInputElement | null>(null)
	const runningRef = useRef(new Set<AbortController>())
	const [driveOpen, setDriveOpen] = useState(false)
	const [altFor, setAltFor] = useState<SheetDrawingObject | null>(null)
	const drawings = text ? undefined : grid.layout?.extensions?.drawings
	const selected = selection !== null && selection.sheet === grid.sheet ? selection.key : null
	const selectedObject = selected === null ? undefined : drawings?.objects.find(object => object.key === selected)
	const session = handle.session
	const [source] = useState<SheetObjectSource>(() => ({
		render: (sheet, key, stamp, since) =>
			session.query("drawing.render", { sheet, key, stamp, ...(since === undefined ? {} : { since }) }),
		media: partName => session.query("drawing.media", { partName })
	}))

	// Another sheet, or the object gone (deleted, undone): the cells have the selection again.
	useEffect(() => {
		if (selection !== null && (selection.sheet !== grid.sheet || (drawings !== undefined && selectedObject === undefined))) {
			selectObject(model, null)
		}
	}, [model, selection, grid.sheet, drawings, selectedObject])

	useEffect(() => {
		const running = runningRef.current

		return () => {
			for (const controller of running) {
				controller.abort()
			}
		}
	}, [])

	const run = async (command: SheetCommand): Promise<boolean> => {
		void model.intent()

		const result = await model.command(command)

		return result.ok
	}

	const take = (source: PictureSource, outer?: AbortSignal): Promise<boolean> =>
		takePicture(source, outer, {
			running: runningRef.current,
			model,
			run,
			say: (key, kind) => {
				if (kind === "info") {
					toast.info(t(key))
				} else {
					toast.error(t(key))
				}
			}
		})

	// A sheet whose protection locks its objects takes no edits of them (the session refuses them alike).
	const editable = canEdit && !text && objectsEditable(grid.layout)
	const insertable = editable

	// The toolbar's Insert menu asks: the chooser opens in the commit of the click that asked (a user activation); the
	// drive's picker shows while its request stands.
	const driveRequest = request?.source === "drive" ? request : null

	useLayoutEffect(() => {
		if (request === null || (request.source === "drive" && insertable)) {
			return
		}

		clearImageRequest(model, request.nonce)

		if (insertable) {
			fileInputRef.current?.click()
		}
	}, [model, request, insertable])

	const closeDrive = (): void => {
		setDriveOpen(false)

		if (driveRequest !== null) {
			clearImageRequest(model, driveRequest.nonce)
		}
	}

	const onSelect = (object: SheetDrawingObject | null): void => {
		selectObject(model, object === null ? null : { sheet: grid.sheet, key: object.key })
	}

	const remove = (object: SheetDrawingObject): void => {
		void run({ type: "drawing.delete", sheet: grid.sheet, objects: [{ key: object.key, stamp: object.stamp }] }).then(done => {
			if (done) {
				selectObject(model, null)
				gridRef.current?.focus()
			}
		})
	}

	const gridExtension: SheetGridExtension = {
		id: "objects",
		pointer: (event: SheetCellPointer) => {
			if (event.kind !== "down") {
				return undefined
			}

			// A tap on an object selects it (on a touch screen objects let the finger through until selected); any other
			// press on a cell selects cells again.
			const key = event.pointerType === "touch" ? objectAt(document, event.clientX, event.clientY) : null

			selectObject(model, key === null ? null : { sheet: grid.sheet, key })

			return key === null ? undefined : true
		}
	}

	// Ctrl+Alt+5: the first object in view (else the sheet's first, scrolled to) takes the keys.
	const shortcut = (pressed: SheetShortcut): boolean => {
		if (pressed !== "selectObject") {
			return false
		}

		const found = objectInView(gridRef.current, model, grid.sheet, drawings)

		if (found === null) {
			return false
		}

		const { anchor } = found.object

		if (!found.onScreen && anchor.mode !== "absolute") {
			gridRef.current?.reveal({ row: anchor.from.row, col: anchor.from.col })
		}

		selectObject(model, { sheet: grid.sheet, key: found.object.key })

		return true
	}

	const takeDriveFile = async (item: DriveItem, signal: AbortSignal): Promise<void> => {
		if (await take(driveSource(item), signal)) {
			closeDrive()
		}
	}

	return {
		id: "objects",
		grid: gridExtension,
		shortcut,
		...(selectedObject !== undefined && {
			ribbon: {
				object: {
					chart: selectedObject.kind === "chart" || selectedObject.kind === "chartex",
					altText: editable
						? () => {
								setAltFor(selectedObject)
							}
						: undefined,
					remove: editable
						? () => {
								remove(selectedObject)
							}
						: undefined
				}
			}
		}),
		overlay:
			drawings === undefined ? undefined : (
				<SheetObjects
					grid={model}
					handle={gridRef}
					sheet={grid.sheet}
					drawings={drawings}
					source={source}
					selected={selected}
					canEdit={editable}
					onSelect={onSelect}
					onMove={(object, anchor) =>
						run({ type: "drawing.move", sheet: grid.sheet, key: object.key, stamp: object.stamp, anchor })
					}
					onDelete={remove}
					onActivate={object => {
						// A chart opens its editor; any other object its alternative text, the one thing edited of it here.
						if (object.kind === "chart" || object.kind === "chartex") {
							onEditObject?.(object)
						} else if (editable) {
							setAltFor(object)
						}
					}}
					{...(renderChart === undefined ? {} : { renderGraphic: renderChart })}
					label={object => objectLabel(object, key => t(key))}
				/>
			),
		menuItems: (
			<>
				{selectedObject === undefined ? null : (
					<>
						<ContextMenuItem
							disabled={!editable}
							onClick={() => {
								setAltFor(selectedObject)
							}}
						>
							{t("previewSheetObjectAltText")}
						</ContextMenuItem>
						<ContextMenuItem
							disabled={!editable}
							onClick={() => {
								remove(selectedObject)
							}}
						>
							{t("previewSheetObjectDelete")}
						</ContextMenuItem>
					</>
				)}
				{insertable ? (
					<ContextMenuSub>
						<ContextMenuSubTrigger>{t("previewSheetObjectInsertImage")}</ContextMenuSubTrigger>
						<ContextMenuSubContent>
							<ContextMenuItem
								onClick={() => {
									fileInputRef.current?.click()
								}}
							>
								{t("previewSheetObjectImageFromFile")}
							</ContextMenuItem>
							<ContextMenuItem
								onClick={() => {
									setDriveOpen(true)
								}}
							>
								{t("previewSheetObjectImageFromDrive")}
							</ContextMenuItem>
						</ContextMenuSubContent>
					</ContextMenuSub>
				) : null}
			</>
		),
		dialogs: text ? undefined : (
			<>
				<input
					ref={fileInputRef}
					type="file"
					accept={PICTURE_ACCEPT}
					multiple
					hidden
					data-sheet-picture-input
					onChange={event => {
						const files = [...(event.target.files ?? [])]

						event.target.value = ""
						void (async () => {
							for (const file of files) {
								await take(fileSource(file))
							}
						})()
					}}
				/>
				{driveOpen || driveRequest !== null ? (
					<DriveFilePickerDialog
						title={t("previewSheetObjectDriveTitle")}
						description={t("previewSheetObjectDriveDescription")}
						accept={isPictureFile}
						onPick={takeDriveFile}
						onClose={closeDrive}
					/>
				) : null}
				{altFor === null ? null : (
					<InputDialog
						open
						pending={false}
						title={t("previewSheetObjectAltTextTitle")}
						body={t("previewSheetObjectAltTextDescription")}
						label={t("previewSheetObjectAltTextLabel")}
						initialValue={altFor.alt}
						maxLength={4000}
						submitLabel={t("previewSheetObjectAltTextApply")}
						validate={value => value.length <= 4000}
						onOpenChange={open => {
							if (!open) {
								setAltFor(null)
							}
						}}
						onSubmit={value => {
							void run({ type: "drawing.alt", sheet: grid.sheet, key: altFor.key, stamp: altFor.stamp, alt: value.trim() })
							setAltFor(null)
						}}
					/>
				)}
			</>
		)
	}
}
