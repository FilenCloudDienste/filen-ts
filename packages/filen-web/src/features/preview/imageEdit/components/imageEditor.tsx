import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { Redo2Icon, SquareSplitHorizontalIcon, Undo2Icon } from "lucide-react"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { PreviewLoading } from "@/features/preview/components/previewErrorState"
import type {
	Adjustments,
	AspectPreset,
	EditCapabilities,
	EditSession,
	ImageEditorCommands,
	ImageEditRecipe,
	ImageEditSource,
	ImageExportSource,
	MarkupColor,
	MarkupItem,
	SourceInfo
} from "@/features/preview/imageEdit/types"
import {
	aspectRect,
	clampCrop,
	geometryMatrix,
	identityRecipe,
	invertMatrix3,
	isIdentity,
	outputSize,
	transformPoint,
	turnedSize,
	type Crop,
	type Size
} from "@/features/preview/imageEdit/lib/recipe"
import { createHistory } from "@/features/preview/imageEdit/lib/history"
import { ImageEditPanel, type EditTab } from "@/features/preview/imageEdit/components/imageEditPanel"
import { CropOverlay } from "@/features/preview/imageEdit/components/cropOverlay"
import { MarkupLayer } from "@/features/preview/imageEdit/components/markupLayer"
import { MARKUP_COLORS, type MarkupMapping, type MarkupTool, type MarkupWidth } from "@/features/preview/imageEdit/components/markupStyle"
import { displayRecipe, exportForTarget, loadOnce } from "@/features/preview/imageEdit/components/editorSession"
import {
	cropFromFrame,
	cropOnFrame,
	fitBox,
	flip,
	normalisedRatio,
	rotateLeft
} from "@/features/preview/imageEdit/components/editorGeometry"
import { matchesCombo } from "@filen/shared/keymap"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { Kbd } from "@/lib/keymap/kbd"
import { useComboFor } from "@/lib/keymap/registry"
import { useEditorLayerKeys } from "@/lib/keymap/editorLayerKeys"
import { useLatestRef } from "@/lib/useLatestRef"
import { log } from "@/lib/log"

export interface ImageEditorProps {
	// The original's pixels; the editor hands them to the session once.
	source: ImageEditSource
	info: SourceInfo
	// Opened by the overlay on entering edit mode, closed by it on leaving.
	session: EditSession
	capabilities: EditCapabilities
	// A save is in flight: nothing can change.
	locked: boolean
	onDirtyChange: (dirty: boolean) => void
	// Registered while mounted: the overlay reads the export through it to save.
	saveRef: RefObject<ImageExportSource | null>
	// Registered while mounted: the overlay header's undo, redo and revert.
	commandsRef: RefObject<ImageEditorCommands | null>
}

// Filter thumbnails, square, in CSS px.
const FILTER_THUMBNAIL_SIZE = 96

// A key in a text field is the field's own (its undo, its typing); a slider thumb's range input is not one.
function isTextField(target: EventTarget | null): boolean {
	return target instanceof Element && target.matches("input:not([type=range]), textarea, [contenteditable]")
}

interface Snapshot {
	recipe: ImageEditRecipe
	canUndo: boolean
	canRedo: boolean
}

// The image editing surface inside the preview overlay: the picture (drawn by the render worker on a canvas this
// component hands it), the crop frame or the drawing layer over it, undo/redo and hold-to-compare floating beneath it, and
// the tools panel beside it (a bottom sheet under the sm breakpoint). The overlay owns the header (cancel, revert, save).
export function ImageEditor(props: ImageEditorProps) {
	const { t } = useTranslation("preview")
	const idBase = useId()
	const rootRef = useRef<HTMLDivElement | null>(null)
	const stageRef = useRef<HTMLDivElement | null>(null)
	const slotRef = useRef<HTMLDivElement | null>(null)
	const [history] = useState(() => createHistory(identityRecipe()))
	// What renders reads: the history is mutable and read in handlers only.
	const [snapshot, setSnapshot] = useState<Snapshot>(() => ({ recipe: history.current, canUndo: false, canRedo: false }))
	const [loaded, setLoaded] = useState<Size | null>(null)
	const [failed, setFailed] = useState(false)
	const [stage, setStage] = useState<Size>({ width: 0, height: 0 })
	const [tab, setTab] = useState<EditTab>("adjust")
	const [compare, setCompare] = useState(false)
	const [tool, setTool] = useState<MarkupTool>("pen")
	const [color, setColor] = useState<MarkupColor>(MARKUP_COLORS[0]?.color ?? "#ef4444")
	const [width, setWidth] = useState<MarkupWidth>(1)
	const [editingText, setEditingText] = useState<string | null>(null)
	const [thumbnails, setThumbnails] = useState<{ key: string; bitmaps: readonly ImageBitmap[] } | null>(null)
	// The bitmaps on show, closed when replaced or on unmount.
	const thumbnailsRef = useRef<readonly ImageBitmap[]>([])
	// The crop a run of straightening started from, so straightening back gives it back whole.
	const straightenBase = useRef<Crop | null>(null)
	const dirtyRef = useRef(false)
	const undoCombo = useComboFor("preview.imageUndo")
	const redoCombo = useComboFor("preview.imageRedo")

	const recipe = snapshot.recipe
	const geometry = recipe.geometry
	const sourceSize: Size = loaded ?? { width: props.info.width, height: props.info.height }
	const frameSize = turnedSize(geometry.quarterTurns, sourceSize)

	const sync = (): void => {
		setSnapshot({ recipe: history.current, canUndo: history.canUndo, canRedo: history.canRedo })
	}

	const commit = (next: ImageEditRecipe, coalesceKey: string | undefined): void => {
		if (props.locked) {
			return
		}

		history.push(next, coalesceKey)
		sync()
	}

	const commitGeometry = (next: ImageEditRecipe["geometry"]): void => {
		straightenBase.current = null
		commit({ ...history.current, geometry: next }, undefined)
	}

	const undo = (): void => {
		if (props.locked) {
			return
		}

		straightenBase.current = null
		history.undo()
		sync()
	}

	const redo = (): void => {
		if (props.locked) {
			return
		}

		straightenBase.current = null
		history.redo()
		sync()
	}

	const revert = (): void => {
		straightenBase.current = null
		commit(identityRecipe(), undefined)
	}

	const handleAdjust = (key: keyof Adjustments, value: number, coalesce: boolean): void => {
		const current = history.current

		commit({ ...current, adjustments: { ...current.adjustments, [key]: value } }, coalesce ? `adjust-${key}` : undefined)
	}

	// The crop shrinks just enough to stay inside the turned picture, from the crop the run started with.
	const handleStraighten = (angle: number): void => {
		const current = history.current.geometry
		const base = straightenBase.current ?? current.crop
		const frame = turnedSize(current.quarterTurns, sourceSize)

		straightenBase.current = base
		commit({ ...history.current, geometry: { ...current, angle, crop: clampCrop(base, angle, frame) } }, "straighten")
	}

	const handleAspect = (aspect: AspectPreset): void => {
		const current = history.current.geometry
		const frame = turnedSize(current.quarterTurns, sourceSize)

		commitGeometry({
			...current,
			aspect,
			crop: aspect === "free" ? current.crop : clampCrop(aspectRect(aspect, frame), current.angle, frame)
		})
	}

	const handleTurn = (next: ImageEditRecipe["geometry"]): void => {
		commitGeometry({ ...next, crop: clampCrop(next.crop, next.angle, turnedSize(next.quarterTurns, sourceSize)) })
	}

	const handleCrop = (shown: Crop, coalesceKey: string | undefined): void => {
		const current = history.current.geometry
		const frame = turnedSize(current.quarterTurns, sourceSize)

		straightenBase.current = null
		commit(
			{
				...history.current,
				geometry: { ...current, crop: clampCrop(cropFromFrame(shown, current.angle, frame), current.angle, frame) }
			},
			coalesceKey
		)
	}

	const handleMarkup = (markup: readonly MarkupItem[], coalesceKey: string | undefined): void => {
		commit({ ...history.current, markup }, coalesceKey)
	}

	const handleResetAdjustments = (keys: readonly (keyof Adjustments)[]): void => {
		const current = history.current
		const adjustments = { ...current.adjustments }

		for (const key of keys) {
			adjustments[key] = 0
		}

		commit({ ...current, adjustments }, undefined)
	}

	const handleKey = (event: KeyboardEvent | ReactKeyboardEvent): void => {
		if (props.locked || event.defaultPrevented || isTextField(event.target)) {
			return
		}

		const mac = isMacPlatform()

		if (matchesCombo(event, undoCombo, mac)) {
			event.preventDefault()
			undo()
		} else if (matchesCombo(event, redoCombo, mac)) {
			event.preventDefault()
			redo()
		}
	}

	useEditorLayerKeys(rootRef, handleKey)

	const display = displayRecipe(recipe, tab === "crop", editingText)
	const displaySize = outputSize(display, sourceSize)
	const frame = fitBox(displaySize, stage)
	const renderArgs = useLatestRef({ recipe, cropping: tab === "crop", editingText, compare })

	// The canvas is made per run: transferControlToOffscreen works once per element.
	useEffect(() => {
		const slot = slotRef.current
		const stageElement = stageRef.current

		if (slot === null || stageElement === null) {
			return
		}

		const canvas = document.createElement("canvas")

		canvas.className = "block size-full"
		slot.replaceChildren(canvas)

		// Layout size, not the bounding box: the entrance animation scales the stage while it attaches.
		const boxWidth = stageElement.clientWidth
		const boxHeight = stageElement.clientHeight
		let alive = true

		props.session
			.attach(canvas.transferControlToOffscreen(), boxWidth, boxHeight, window.devicePixelRatio)
			.then(() => loadOnce(props.session, props.source, props.info))
			.then(
				size => {
					if (!alive) {
						return
					}

					setLoaded(size)
					// This canvas is new even when the load is not: draw on it now.
					const latest = renderArgs.current

					props.session.render(displayRecipe(latest.recipe, latest.cropping, latest.editingText), { compare: latest.compare })
				},
				(error: unknown) => {
					log.error("[imageEditor] attach/load failed", error)

					if (alive) {
						setFailed(true)
					}
				}
			)

		const observer = new ResizeObserver(entries => {
			const entry = entries[entries.length - 1]

			if (entry === undefined) {
				return
			}

			const { width: cssWidth, height: cssHeight } = entry.contentRect

			props.session.resize(cssWidth, cssHeight, window.devicePixelRatio)
			setStage({ width: cssWidth, height: cssHeight })
		})

		observer.observe(stageElement)

		return () => {
			alive = false
			observer.disconnect()
			canvas.remove()
		}
	}, [props.session, props.source, props.info, renderArgs])

	useEffect(() => {
		if (loaded !== null) {
			props.session.render(displayRecipe(recipe, tab === "crop", editingText), { compare })
		}
	}, [props.session, loaded, recipe, tab, editingText, compare])

	// Thumbnails follow the geometry only: a slider move would otherwise redraw nine pictures per frame.
	const geometryKey = JSON.stringify(geometry)
	const latestRecipe = useLatestRef(recipe)
	const thumbnailsKey = thumbnails?.key ?? null

	useEffect(() => {
		if (tab !== "filters" || loaded === null || thumbnailsKey === geometryKey) {
			return
		}

		let alive = true

		props.session.filterThumbnails({ ...latestRecipe.current, filter: null }, FILTER_THUMBNAIL_SIZE).then(
			bitmaps => {
				if (!alive) {
					for (const bitmap of bitmaps) {
						bitmap.close()
					}

					return
				}

				for (const bitmap of thumbnailsRef.current) {
					bitmap.close()
				}

				thumbnailsRef.current = bitmaps
				setThumbnails({ key: geometryKey, bitmaps })
			},
			(error: unknown) => {
				log.warn("[imageEditor] filter thumbnails failed", error)
			}
		)

		return () => {
			alive = false
		}
	}, [tab, loaded, geometryKey, thumbnailsKey, props.session, latestRecipe])

	useEffect(() => {
		return () => {
			for (const bitmap of thumbnailsRef.current) {
				bitmap.close()
			}

			thumbnailsRef.current = []
		}
	}, [])

	const onDirtyChange = useLatestRef(props.onDirtyChange)

	useEffect(() => {
		const dirty = !isIdentity(recipe)

		if (dirty !== dirtyRef.current) {
			dirtyRef.current = dirty
			onDirtyChange.current(dirty)
		}
	}, [recipe, onDirtyChange])

	const commands = useLatestRef({ undo, redo, revert })

	const { saveRef, commandsRef, session, info } = props

	useEffect(() => {
		saveRef.current = target => exportForTarget(session, info, history.current, target)
		commandsRef.current = {
			undo: () => {
				commands.current.undo()
			},
			redo: () => {
				commands.current.redo()
			},
			revert: () => {
				commands.current.revert()
			}
		}

		return () => {
			saveRef.current = null
			commandsRef.current = null
		}
	}, [saveRef, commandsRef, session, info, history, commands])

	// Pressing the picture shows the original while the colour tabs are open (the others draw on it).
	const pressCompares = tab === "adjust" || tab === "filters"

	let mapping: MarkupMapping | null = null

	if (tab === "markup" && frame.width > 0 && displaySize.width > 0) {
		const toSourceMatrix = geometryMatrix(recipe, sourceSize)
		const toOutputMatrix = invertMatrix3(toSourceMatrix)
		const screenPerOutput = frame.width / displaySize.width
		const sourcePerOutput = Math.sqrt(Math.abs(toSourceMatrix[0] * toSourceMatrix[4] - toSourceMatrix[1] * toSourceMatrix[3]))

		mapping = {
			toSource: (x, y) => transformPoint(toSourceMatrix, x / screenPerOutput, y / screenPerOutput),
			toScreen: (x, y) => {
				const [outX, outY] = transformPoint(toOutputMatrix, x, y)

				return [outX * screenPerOutput, outY * screenPerOutput]
			},
			scale: screenPerOutput / sourcePerOutput
		}
	}

	const stopCompare = (): void => {
		setCompare(false)
	}

	// A darkroom in either app theme: the picture reads truest on a neutral dark surround.
	return (
		<div
			ref={rootRef}
			data-preview-surface=""
			inert={props.locked}
			className="dark flex size-full min-h-0 flex-col bg-canvas text-foreground scheme-dark sm:flex-row"
			onKeyDown={handleKey}
			onPointerUpCapture={() => {
				// A drag or slider gesture is one undo step.
				history.seal()
			}}
		>
			<div className="relative flex min-h-0 min-w-0 flex-1 animate-in flex-col duration-300 ease-out fade-in-0 zoom-in-98 motion-reduce:animate-none">
				{/* The bottom gutter keeps the picture (and the crop frame's lower handles) clear of the floating toolbar. */}
				<div className="min-h-0 flex-1 px-4 pt-2 pb-16 sm:px-6 sm:pt-4 sm:pb-18">
					<div
						ref={stageRef}
						role="img"
						aria-label={t("previewImageEditCanvas")}
						className="relative size-full"
					>
						<div
							ref={slotRef}
							className="absolute inset-0 touch-none"
							onPointerDown={event => {
								if (pressCompares && event.button === 0 && loaded !== null) {
									event.currentTarget.setPointerCapture(event.pointerId)
									setCompare(true)
								}
							}}
							onPointerUp={stopCompare}
							onPointerCancel={stopCompare}
						/>
						{loaded === null && !failed ? (
							<div className="pointer-events-none absolute inset-0">
								<PreviewLoading />
							</div>
						) : null}
						{failed ? (
							<p className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-destructive">
								{t("previewImageEditLoadFailed")}
							</p>
						) : null}
						{loaded !== null && tab === "crop" ? (
							<CropOverlay
								frame={frame}
								crop={cropOnFrame(geometry.crop, geometry.angle, frameSize)}
								ratio={normalisedRatio(geometry.aspect, frameSize)}
								onCommit={handleCrop}
							/>
						) : null}
						{loaded !== null && mapping !== null ? (
							<MarkupLayer
								frame={frame}
								mapping={mapping}
								longerSide={Math.max(sourceSize.width, sourceSize.height)}
								markup={recipe.markup}
								tool={tool}
								color={color}
								width={width}
								onCommit={handleMarkup}
								onEditingChange={setEditingText}
							/>
						) : null}
					</div>
				</div>
				<div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-popover/75 p-1 shadow-lg ring-1 ring-border backdrop-blur-md backdrop-saturate-150 sm:bottom-4">
					<TooltipIconButton
						label={t("previewImageEditUndo")}
						disabled={!snapshot.canUndo}
						shortcut={<Kbd action="preview.imageUndo" />}
						className="rounded-full"
						onClick={undo}
					>
						<Undo2Icon />
					</TooltipIconButton>
					<TooltipIconButton
						label={t("previewImageEditRedo")}
						disabled={!snapshot.canRedo}
						shortcut={<Kbd action="preview.imageRedo" />}
						className="rounded-full"
						onClick={redo}
					>
						<Redo2Icon />
					</TooltipIconButton>
					<Separator
						orientation="vertical"
						className="mx-1 my-1.5"
					/>
					<Tooltip>
						<TooltipTrigger
							render={
								<Button
									variant={compare ? "secondary" : "ghost"}
									size="icon-sm"
									aria-label={t("previewImageEditCompare")}
									aria-pressed={compare}
									disabled={loaded === null}
									className={cn(
										"touch-none rounded-full",
										compare && "bg-foreground text-background hover:bg-foreground"
									)}
									onPointerDown={event => {
										if (event.button === 0) {
											event.currentTarget.setPointerCapture(event.pointerId)
											setCompare(true)
										}
									}}
									onPointerUp={stopCompare}
									onPointerCancel={stopCompare}
									onBlur={stopCompare}
									onKeyDown={event => {
										if ((event.key === " " || event.key === "Enter") && !event.repeat) {
											event.preventDefault()
											setCompare(true)
										}
									}}
									onKeyUp={event => {
										if (event.key === " " || event.key === "Enter") {
											setCompare(false)
										}
									}}
								>
									<SquareSplitHorizontalIcon />
								</Button>
							}
						/>
						<TooltipContent>{t("previewImageEditCompare")}</TooltipContent>
					</Tooltip>
				</div>
			</div>
			{/* A floating inspector beside the picture; under the sm breakpoint a bottom sheet of fixed height, so
			    switching tabs never resizes the picture. */}
			<aside
				aria-label={t("previewImageEditTools")}
				className="flex h-[44dvh] shrink-0 animate-in flex-col rounded-t-3xl bg-background shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.6)] ring-1 ring-border duration-300 ease-out fade-in-0 slide-in-from-bottom-4 motion-reduce:animate-none sm:my-3 sm:mr-3 sm:h-auto sm:w-80 sm:rounded-3xl sm:shadow-lg sm:slide-in-from-bottom-0 sm:slide-in-from-right-4"
			>
				<span
					aria-hidden="true"
					className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-foreground/20 sm:hidden"
				/>
				<ImageEditPanel
					idBase={idBase}
					tab={tab}
					recipe={recipe}
					thumbnails={thumbnails?.bitmaps ?? null}
					tool={tool}
					color={color}
					width={width}
					onTab={next => {
						// The text field commits on blur as focus leaves it; its item must not stay hidden.
						setEditingText(null)
						setTab(next)
					}}
					onAdjust={handleAdjust}
					onResetAdjustments={handleResetAdjustments}
					onStraighten={handleStraighten}
					onRotateLeft={() => {
						handleTurn(rotateLeft(history.current.geometry))
					}}
					onFlip={axis => {
						handleTurn(flip(history.current.geometry, axis))
					}}
					onAspect={handleAspect}
					onResetGeometry={() => {
						commitGeometry(identityRecipe().geometry)
					}}
					onFilter={id => {
						commit({ ...history.current, filter: id }, undefined)
					}}
					onTool={setTool}
					onColor={setColor}
					onWidth={setWidth}
				/>
			</aside>
		</div>
	)
}
