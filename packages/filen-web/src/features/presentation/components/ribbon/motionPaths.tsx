import { useEffect, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import {
	ArrowLeftRightIcon,
	LockIcon,
	PenLineIcon,
	PenToolIcon,
	RouteIcon,
	SignatureIcon,
	SplineIcon,
	WaypointsIcon,
	type LucideIcon
} from "lucide-react"
import { addEffectsOp, type DeckOp, type SlideRef } from "@filen/office/core/presentation"
import {
	MOTION_TOOLS,
	MotionPathLayer,
	customPathPreset,
	deletePoint,
	isCustomPath,
	kindOf,
	motionPathViews,
	readEditablePath,
	reversePath,
	segmentCount,
	setClosed,
	setPointKind,
	setSegmentType,
	slideShapes,
	writeEditablePath,
	type EditablePath,
	type MotionPathLabels,
	type MotionPathView,
	type MotionTool,
	type PointKind
} from "@filen/office/react/presentation"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator
} from "@/components/ui/dropdown-menu"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import { animationPane, useSlideAnimations, type SlideAnimations } from "@/features/presentation/components/ribbon/animations"
import type { PresentationGroups, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import type { PreviewKey } from "@/lib/i18n"

// The Animations tab's Motion Paths group and the motion-path layer on the slide. Custom Path draws a new path for the
// one selected object with a tool (Line, Curve, Freeform, Scribble) and adds it as a custom path effect; Edit Points
// edits the chosen path on the slide (its points, their handles and types, the segments' types); Reverse Path
// Direction, Close / Open and Locked / Unlocked change the chosen path. "The chosen path" is the motion path of the
// effect chosen in the Animation Pane, else of the selected object's first path effect. Every change is one
// motionPath or timing op (one undo step). The layer reads the slide's timing from the Animations store, so the paths
// cost no request of their own; the tool and Edit Points state live in this file's small store.

export interface MotionPathsState {
	// The tool drawing a path for `shape`.
	readonly tool?: MotionTool
	readonly shape?: number
	// The behaviour in Edit Points, its slide, and the selected point.
	readonly editing?: number
	readonly slide?: SlideRef
	readonly point?: number | undefined
}

function createMotionPaths() {
	let state: MotionPathsState = {}
	const listeners = new Set<() => void>()
	const set = (next: MotionPathsState): void => {
		state = next

		for (const listener of listeners) listener()
	}

	return {
		subscribe: (listener: () => void): (() => void) => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		getSnapshot: (): MotionPathsState => state,
		draw: (tool: MotionTool, shape: number): void => {
			set({ tool, shape })
		},
		edit: (slide: SlideRef, node: number): void => {
			set({ editing: node, slide })
		},
		point: (point: number | undefined): void => {
			if (state.point !== point) set({ ...state, point })
		},
		reset: (): void => {
			if (state.tool !== undefined || state.editing !== undefined) set({})
		}
	}
}

export const motionPaths = createMotionPaths()

export function useMotionPaths(): MotionPathsState {
	return useSyncExternalStore(motionPaths.subscribe, motionPaths.getSnapshot, motionPaths.getSnapshot)
}

const TOOL_KEYS: Readonly<Record<MotionTool, PreviewKey>> = {
	line: "previewPptxMotionToolLine",
	curve: "previewPptxMotionToolCurve",
	freeform: "previewPptxMotionToolFreeform",
	scribble: "previewPptxMotionToolScribble"
}

const TOOL_ICONS: Readonly<Record<MotionTool, LucideIcon>> = {
	line: PenLineIcon,
	curve: SplineIcon,
	freeform: WaypointsIcon,
	scribble: SignatureIcon
}

const KIND_KEYS: Readonly<Record<PointKind, PreviewKey>> = {
	auto: "previewPptxMotionPointAuto",
	smooth: "previewPptxMotionPointSmooth",
	straight: "previewPptxMotionPointStraight",
	corner: "previewPptxMotionPointCorner"
}

const KINDS: readonly PointKind[] = ["auto", "smooth", "straight", "corner"]

// The name of a custom path effect in the pane (presetID 0 has no preset of ours).
export function customPathLabel(
	t: TFunction<"preview">,
	presetClass: string | undefined,
	presetID: number | undefined
): string | undefined {
	return isCustomPath(presetClass, presetID) ? t("previewPptxMotionCustomPath") : undefined
}

export function motionPathLabels(t: TFunction<"preview">): MotionPathLabels {
	return {
		drawing: t("previewPptxMotionDrawing"),
		editing: t("previewPptxMotionEditing"),
		point: (index, count) => t("previewPptxMotionPointOf", { index, count })
	}
}

interface SlidePaths {
	readonly animations: SlideAnimations
	readonly views: readonly MotionPathView[]
	// The path the commands act on.
	readonly chosen: MotionPathView | undefined
}

// The slide's motion paths, from the timing the Animations store last read for the slide in view.
function useSlidePaths(editor: PresentationRibbonEditor): SlidePaths {
	const animations = useSlideAnimations(editor)
	const render = editor.render
	const source = animations.pane.slide === render?.ref ? animations.pane.source : undefined
	const views = motionPathViews(source?.timing, source?.geometry, slideShapes(render))
	const rows = animations.active.filter(row => row.presetClass === "path")
	const chosen = rows.map(row => views.find(view => view.effect === row.id)).find(view => view !== undefined)

	return { animations, views, chosen }
}

function aspectOf(editor: PresentationRibbonEditor): number {
	const { cx, cy } = editor.info.size

	return cy > 0 ? cx / cy : 16 / 9
}

function pathOp(
	slide: SlideRef,
	view: MotionPathView,
	path: EditablePath,
	extra: Pick<Extract<DeckOp, { family: "motionPath" }>, "pathEditMode"> = {}
): DeckOp {
	return { family: "motionPath", kind: "setPath", slide, node: view.node, ...writeEditablePath(path), ...extra }
}

function run(editor: PresentationRibbonEditor, op: DeckOp | undefined): void {
	if (op !== undefined) void editor.command(op)
}

// Each view's path as Edit Points reads it, once per view (the views are kept per slide timing).
const readOf = new WeakMap<MotionPathView, ReturnType<typeof readEditablePath>>()

function readOnce(view: MotionPathView): ReturnType<typeof readEditablePath> {
	let read = readOf.get(view)

	if (read === undefined) {
		read = readEditablePath(view.path, view.ptsTypes)
		readOf.set(view, read)
	}

	return read
}

function editableOf(view: MotionPathView | undefined): EditablePath | undefined {
	if (view === undefined) return undefined

	const path = readOnce(view)

	return "reason" in path ? undefined : path
}

// ---- the layer on the slide --------------------------------------------------------------------------------------

export function PresentationMotionPaths({ editor, scale }: { editor: PresentationRibbonEditor; scale: number }) {
	const { t } = useTranslation("preview")
	const { animations, views } = useSlidePaths(editor)
	const state = useMotionPaths()
	const render = editor.render
	const slide = render?.ref
	const editingView = state.editing === undefined || state.slide !== slide ? undefined : views.find(view => view.node === state.editing)
	const shape = state.shape === undefined ? undefined : slideShapes(render).find(candidate => candidate.id === state.shape)

	// Another slide, or the path or the object gone: the tool and Edit Points end.
	useEffect(() => {
		if (state.editing !== undefined && (state.slide !== slide || (animations.pane.source !== undefined && editingView === undefined)))
			motionPaths.reset()
	}, [slide, state.editing, state.slide, editingView, animations.pane.source])

	useEffect(() => {
		if (state.tool !== undefined && shape === undefined) motionPaths.reset()
	}, [state.tool, shape])

	if (render === undefined || slide === undefined) return null

	const chosenEffects = animations.pane.selected.length > 0 ? animations.pane.selected : animations.active.map(row => row.id)

	return (
		<MotionPathLayer
			size={editor.info.size}
			scale={scale}
			paths={views}
			selected={chosenEffects}
			editable={editor.info.editable}
			pickable={animations.pane.open}
			{...(state.tool === undefined || shape === undefined
				? {}
				: { tool: state.tool, origin: { x: shape.xfrm.x + shape.xfrm.cx / 2, y: shape.xfrm.y + shape.xfrm.cy / 2 } })}
			{...(editingView === undefined ? {} : { editing: editingView.node })}
			{...(state.point === undefined ? {} : { point: state.point })}
			labels={motionPathLabels(t)}
			onSelect={effect => {
				animationPane.select([effect])
			}}
			onDrawn={path => {
				const target = state.shape

				motionPaths.reset()

				if (path === undefined || target === undefined) return

				run(
					editor,
					addEffectsOp(slide, animations.rows, [{ id: target }], {
						preset: customPathPreset(writeEditablePath(path)),
						aspect: aspectOf(editor)
					})
				)
			}}
			onEdit={(node, path) => {
				const view = views.find(candidate => candidate.node === node)

				if (view !== undefined) run(editor, pathOp(slide, view, path))
			}}
			onPoint={point => {
				motionPaths.point(point)
			}}
			onEditEnd={() => {
				motionPaths.reset()
			}}
		/>
	)
}

// ---- the ribbon group --------------------------------------------------------------------------------------------

function DrawMenu({ editor, animations }: { editor: PresentationRibbonEditor; animations: SlideAnimations }) {
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()
	const only = animations.shapes.length === 1 ? animations.shapes[0] : undefined

	return (
		<DropdownMenu
			onOpenChange={focus.opened}
			onOpenChangeComplete={focus.closed}
		>
			<RibbonMenuTrigger
				label={only === undefined ? t("previewPptxMotionSelectOne") : t("previewPptxMotionDraw")}
				text={t("previewPptxMotionDraw")}
				icon={<PenToolIcon />}
				disabled={!editor.info.editable || only === undefined || animations.unsupported}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
				className="min-w-56"
			>
				<DropdownMenuGroup>
					{MOTION_TOOLS.map(tool => {
						const Icon = TOOL_ICONS[tool]

						return (
							<DropdownMenuItem
								key={tool}
								onClick={() => {
									if (only === undefined) return

									// After the menu gives focus back, so the slide keeps it for the drawing.
									focus.afterClose(() => {
										motionPaths.draw(tool, only.id)
									})
								}}
							>
								<Icon />
								{t(TOOL_KEYS[tool])}
							</DropdownMenuItem>
						)
					})}
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<p className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">{t("previewPptxMotionDrawHint")}</p>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function PathMenu({
	editor,
	slide,
	view
}: {
	editor: PresentationRibbonEditor
	slide: SlideRef | undefined
	view: MotionPathView | undefined
}) {
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()
	const path = editableOf(view)
	const locked = view?.pathEditMode === "fixed"

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<RibbonMenuTrigger
				label={t("previewPptxMotionPathOptions")}
				text={t("previewPptxMotionPathOptions")}
				icon={<LockIcon />}
				disabled={!editor.info.editable || view === undefined || slide === undefined}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
				className="min-w-48"
			>
				<DropdownMenuRadioGroup
					value={path?.closed === true ? "closed" : "open"}
					onValueChange={value => {
						if (slide === undefined || view === undefined || path === undefined) return

						run(editor, pathOp(slide, view, setClosed(path, value === "closed")))
					}}
				>
					<DropdownMenuRadioItem
						closeOnClick
						value="open"
						disabled={path === undefined}
					>
						{t("previewPptxMotionOpen")}
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem
						closeOnClick
						value="closed"
						disabled={path === undefined || path.xs.length < 2}
					>
						{t("previewPptxMotionClose")}
					</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<DropdownMenuRadioGroup
					value={locked ? "fixed" : "relative"}
					onValueChange={value => {
						if (slide === undefined || view === undefined) return

						run(editor, {
							family: "motionPath",
							kind: "setPath",
							slide,
							node: view.node,
							path: view.path,
							...(view.ptsTypes === undefined ? {} : { ptsTypes: view.ptsTypes }),
							pathEditMode: value === "fixed" ? "fixed" : "relative"
						})
					}}
				>
					<DropdownMenuRadioItem
						value="relative"
						closeOnClick
					>
						{t("previewPptxMotionUnlocked")}
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem
						value="fixed"
						closeOnClick
					>
						{t("previewPptxMotionLocked")}
					</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function PointMenu({
	editor,
	slide,
	view,
	point
}: {
	editor: PresentationRibbonEditor
	slide: SlideRef
	view: MotionPathView
	point: number
}) {
	const { t } = useTranslation("preview")
	const focus = useCommandMenuFocus()
	const path = editableOf(view)
	const hasSegment = path !== undefined && point < segmentCount(path)
	const curved = path !== undefined && hasSegment && path.curves[point] === 1

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<RibbonMenuTrigger
				label={t("previewPptxMotionPointMenu")}
				text={t("previewPptxMotionPointMenu")}
				icon={<RouteIcon />}
				disabled={path === undefined || point >= path.xs.length}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
				className="min-w-52"
			>
				<DropdownMenuGroup>
					<DropdownMenuLabel>{t("previewPptxMotionPointType")}</DropdownMenuLabel>
					<DropdownMenuRadioGroup
						value={path === undefined ? "auto" : kindOf(path, point)}
						onValueChange={value => {
							if (path === undefined) return

							run(editor, pathOp(slide, view, setPointKind(path, point, value as PointKind)))
						}}
					>
						{KINDS.map(kind => (
							<DropdownMenuRadioItem
								closeOnClick
								key={kind}
								value={kind}
							>
								{t(KIND_KEYS[kind])}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuLabel>{t("previewPptxMotionSegment")}</DropdownMenuLabel>
					<DropdownMenuRadioGroup
						value={curved ? "curve" : "line"}
						onValueChange={value => {
							if (path === undefined || !hasSegment) return

							run(editor, pathOp(slide, view, setSegmentType(path, point, value === "curve" ? "curve" : "line")))
						}}
					>
						<DropdownMenuRadioItem
							closeOnClick
							value="line"
							disabled={!hasSegment}
						>
							{t("previewPptxMotionSegmentStraight")}
						</DropdownMenuRadioItem>
						<DropdownMenuRadioItem
							closeOnClick
							value="curve"
							disabled={!hasSegment}
						>
							{t("previewPptxMotionSegmentCurved")}
						</DropdownMenuRadioItem>
					</DropdownMenuRadioGroup>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					disabled={path === undefined || deletePoint(path, point) === path}
					onClick={() => {
						if (path === undefined) return

						const next = deletePoint(path, point)

						focus.ran()
						motionPaths.point(Math.min(point, next.xs.length - 1))
						run(editor, pathOp(slide, view, next))
					}}
				>
					{t("previewPptxMotionDeletePoint")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function MotionPathControls({ editor }: { editor: PresentationRibbonEditor }) {
	const { t } = useTranslation("preview")
	const { animations, views, chosen } = useSlidePaths(editor)
	const state = useMotionPaths()
	const slide = editor.render?.ref
	const editingView = state.editing === undefined || state.slide !== slide ? undefined : views.find(view => view.node === state.editing)
	const editing = state.editing !== undefined && state.slide === slide
	const read = chosen === undefined ? undefined : readOnce(chosen)
	const canEdit = read !== undefined && !("reason" in read)
	const refusal =
		read === undefined || !("reason" in read)
			? undefined
			: read.reason === "tooLarge"
				? t("previewPptxMotionTooManyPoints")
				: t("previewPptxMotionNotEditable")

	return (
		<>
			<DrawMenu
				editor={editor}
				animations={animations}
			/>
			<RibbonButton
				label={refusal ?? t("previewPptxMotionEditPoints")}
				text={t("previewPptxMotionEditPoints")}
				icon={<RouteIcon />}
				pressed={editing}
				disabled={!editor.info.editable || (!editing && (!canEdit || slide === undefined))}
				onClick={() => {
					if (editing) motionPaths.reset()
					else if (slide !== undefined && chosen !== undefined) motionPaths.edit(slide, chosen.node)
				}}
			/>
			<RibbonButton
				label={t("previewPptxMotionReverse")}
				icon={<ArrowLeftRightIcon />}
				disabled={!editor.info.editable || !canEdit || slide === undefined}
				onClick={() => {
					const path = editableOf(chosen)

					if (slide !== undefined && chosen !== undefined && path !== undefined)
						run(editor, pathOp(slide, chosen, reversePath(path)))
				}}
			/>
			<PathMenu
				editor={editor}
				slide={slide}
				view={chosen}
			/>
			{editingView !== undefined && slide !== undefined && state.point !== undefined ? (
				<PointMenu
					editor={editor}
					slide={slide}
					view={editingView}
					point={state.point}
				/>
			) : null}
		</>
	)
}

// Widths with their gaps, as the browsers lay the controls out (ribbonFit's estimates).
const DRAW = 132
const EDIT = 120
const REVERSE = 34
const OPTIONS = 82
const POINT = 86

export const motionPathsGroups: PresentationGroups = context => {
	const editor = context.editor

	if (editor === undefined || !context.editable) return []

	return [
		{
			id: "animMotionPaths",
			label: context.t("previewPptxMotionGroup", { ns: "preview" }),
			icon: RouteIcon,
			width: DRAW + EDIT + REVERSE + OPTIONS + POINT,
			priority: 3,
			content: <MotionPathControls editor={editor} />
		}
	]
}
