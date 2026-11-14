import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react"
import { useTranslation } from "react-i18next"
import type { PdfAnnotationInfo, PdfPoint, PdfPresetStamp, PdfRect } from "@filen/office/core/pdfedit/annotations"
import type { PdfCommandResult } from "@filen/office/core/pdfedit"
import { isMupdfDocument, type PdfEditSessionModel } from "@filen/office/react/pdfedit"
import {
	canMove,
	canResize,
	INK_IDLE,
	inkPointer,
	markupPointer,
	markupTool,
	PdfPlacementIndicator,
	PdfSelectionFrame,
	PdfTextBoxEditor,
	PdfToolDraftOverlay,
	quadsFromLines,
	RECT_TOOL_IDLE,
	rectStyle,
	rectToolDraft,
	rectToolKey,
	rectToolPointer,
	SELECT_IDLE,
	selectPointer,
	shapeKey,
	shapePointer,
	shapeTool,
	stampSize,
	TEXT_BOX_IDLE,
	TOOL_CLICK_SLOP,
	textBoxEdit,
	textBoxFinish,
	textBoxInput,
	textBoxKey,
	textBoxPointer,
	type InkState,
	type MarkupState,
	type PdfToolDraft,
	type RectSize,
	type RectToolState,
	type SelectState,
	type ShapeState,
	type TextBoxCommit,
	type TextBoxState,
	type ToolKey,
	type ToolPointer
} from "@filen/office/react/pdfedit/tools"
import { PdfAnnotationPopover, type PdfAnnotationStyleChange } from "@/features/pdf/annotations/annotationPopover"
import { annotationStoreOf, type PdfAnnotationStore } from "@/features/pdf/annotations/annotationStore"
import { downloadAttachment } from "@/features/pdf/annotations/attachments"
import {
	ANNOTATION_TEXT_STYLE,
	markupKindOf,
	placementToolKey,
	PRESET_STAMP_SIZE,
	shapeKindOf,
	stampVariantOf,
	type AnnotationMode
} from "@/features/pdf/annotations/annotationTools.logic"
import {
	pageLayerStyle,
	pageSpace,
	textLines,
	viewBox,
	viewerAnnotationInfos,
	type PageSpace
} from "@/features/pdf/annotations/pageSpace.logic"
import type { PdfToolContext, PdfToolOverlayProps } from "@/features/pdf/tools/registry"
import "@filen/office/css/pdfedit.css"

// The annotation tools on one page: the overlay every annotation tool draws with (tools/*.tool.tsx pick its mode).
// Pointer and keyboard input go through the headless tool state machines (react/pdfedit/tools) in page space; a
// finished gesture is one editor command through the tool context, which starts the editor first when the viewer
// still shows pdf.js (the gesture is replayed into it). Selecting shows the popover; a new annotation is selected and,
// for one-shot tools, the tool goes back to selection. Before the swap the page's annotations come from pdf.js (same
// object numbers as the editor's); after it, from the editor (the store).

// How far (CSS pixels) a press may miss an annotation or a handle.
const HIT_SLOP_PX = 5
const POPOVER_GAP_PX = 8

type PointerType = ToolPointer["type"]

interface LayerProps extends PdfToolOverlayProps {
	readonly mode: AnnotationMode
}

// The page's own /Rotate (pdf.js pages report it; the editor's pages carry it already), read once per page object.
function usePageRotate(document: PdfToolOverlayProps["document"], page: number): number | null {
	const engine = isMupdfDocument(document)
	const [read, setRead] = useState<{ readonly document: unknown; readonly page: number; readonly rotate: number } | null>(null)

	useEffect(() => {
		if (engine) return

		let live = true

		void document.getPage(page + 1).then(
			proxy => {
				if (live) setRead({ document, page, rotate: proxy.rotate })
			},
			() => undefined
		)

		return () => {
			live = false
		}
	}, [document, page, engine])

	if (engine) return 0

	return read?.document === document && read.page === page ? read.rotate : null
}

// The viewer's annotations of the page (before the swap).
function useViewerAnnotations(document: PdfToolOverlayProps["document"], page: number): readonly unknown[] | null {
	const engine = isMupdfDocument(document)
	const [read, setRead] = useState<{ readonly document: unknown; readonly page: number; readonly annotations: unknown[] } | null>(null)

	useEffect(() => {
		if (engine) return

		let live = true

		void document
			.getPage(page + 1)
			.then(proxy => proxy.getAnnotations({ intent: "display" }))
			.then(
				annotations => {
					if (live) setRead({ document, page, annotations })
				},
				() => undefined
			)

		return () => {
			live = false
		}
	}, [document, page, engine])

	return read?.document === document && read.page === page ? read.annotations : null
}

// The page's text items, for a markup drag's draft.
function usePageText(document: PdfToolOverlayProps["document"], page: number, wanted: boolean): readonly unknown[] | null {
	const [read, setRead] = useState<{ readonly document: unknown; readonly page: number; readonly items: readonly unknown[] } | null>(null)

	useEffect(() => {
		if (!wanted) return

		let live = true

		void document
			.getPage(page + 1)
			.then(proxy => proxy.getTextContent())
			.then(
				content => {
					if (live) setRead({ document, page, items: content.items })
				},
				() => undefined
			)

		return () => {
			live = false
		}
	}, [document, page, wanted])

	return read?.document === document && read.page === page ? read.items : null
}

// The nearest ancestor that scrolls (the page column), for the hand.
function scrollParent(element: Element | null): HTMLElement | null {
	for (let current = element?.parentElement ?? null; current !== null; current = current.parentElement) {
		const overflow = getComputedStyle(current).overflowY

		if ((overflow === "auto" || overflow === "scroll") && current.scrollHeight > current.clientHeight) return current
	}

	return null
}

export function PdfAnnotationLayer(props: LayerProps) {
	const rotate = usePageRotate(props.document, props.page)

	if (rotate === null) return null

	return (
		<AnnotationLayer
			{...props}
			space={pageSpace(props.viewport, rotate)}
		/>
	)
}

// Runs a command that makes an annotation, with the author's name (asked for the first time), then selects what it
// made; `then` runs after it (back to selection, keep a drawing going).
function made(
	context: PdfToolContext,
	store: PdfAnnotationStore,
	make: (session: PdfEditSessionModel, author: string) => Promise<PdfCommandResult>,
	then?: (result: PdfCommandResult) => void
): void {
	if (!context.editable) return

	void store.author().then(author => {
		if (author === null) return

		context.edit(async session => {
			const result = await make(session, author)

			if (result.created !== undefined) store.selectRef(result.created)

			then?.(result)

			return result
		})
	})
}

function AnnotationLayer({ context, page, document, variant, mode, space }: LayerProps & { readonly space: PageSpace }) {
	const { t } = useTranslation("preview")
	const store = annotationStoreOf(context.swap)
	const shared = useSyncExternalStore(store.subscribe, store.getState)
	const engine = isMupdfDocument(document)
	const viewerAnnotations = useViewerAnnotations(document, page)
	const items = usePageText(document, page, mode === "markup")
	const rootRef = useRef<HTMLDivElement | null>(null)
	const dropped = useRef(false)
	const hand = useRef<{ readonly x: number; readonly y: number; readonly left: number; readonly top: number } | null>(null)
	const [select, setSelect] = useState<SelectState>(SELECT_IDLE)
	const [textBox, setTextBox] = useState<TextBoxState>(TEXT_BOX_IDLE)
	const [ink, setInk] = useState<InkState>(INK_IDLE)
	const [markup, setMarkup] = useState<MarkupState>(() => markupTool(markupKindOf(variant)))
	const [shape, setShape] = useState<ShapeState>(() => shapeTool(shapeKindOf(variant)))
	const [rect, setRect] = useState<RectToolState>(RECT_TOOL_IDLE)

	// The annotations shown: the editor's (read through the store), else the viewer's.
	const annotations: readonly PdfAnnotationInfo[] = engine
		? (store.annotations(page) ?? [])
		: viewerAnnotationInfos(viewerAnnotations ?? [], page, space)
	const selected = shared.selected?.page === page ? shared.selected : null
	const handing = mode === "hand" || (shared.hand && mode !== "select")
	const kind = markupKindOf(variant)
	const shapeKind = shapeKindOf(variant)

	// A variant chosen anew starts its tool afresh.
	if (markup.kind !== kind) setMarkup(markupTool(kind))
	if (shape.kind !== shapeKind) setShape(shapeTool(shapeKind))

	const tolerance = HIT_SLOP_PX / Math.max(0.01, space.scale)
	const stamp = stampVariantOf(variant)
	const stampRect: RectSize =
		stamp === "image" || stamp === "imageFilen"
			? shared.image === null
				? PRESET_STAMP_SIZE
				: stampSize(shared.image.width, shared.image.height)
			: PRESET_STAMP_SIZE

	const point = (event: { readonly clientX: number; readonly clientY: number }): PdfPoint => {
		const box = rootRef.current?.getBoundingClientRect()

		return box === undefined ? [0, 0] : space.toPage(event.clientX - box.left, event.clientY - box.top)
	}
	const toolPointer = (type: PointerType, event: ReactPointerEvent): ToolPointer => ({
		type,
		page,
		box: space.box,
		point: point(event),
		shift: event.shiftKey
	})

	// --- Commits ---

	const finishTool = (): void => {
		context.finish()
	}

	const commitTextBox = (commit: TextBoxCommit | undefined): void => {
		if (commit === undefined) return

		if (commit.id !== undefined) {
			const ref = { page: commit.page, id: commit.id }

			context.edit(session =>
				commit.text.trim() === ""
					? session.dispatch("annotations.delete", ref)
					: session.dispatch("annotations.text", { ...ref, text: commit.text })
			)

			return
		}

		made(
			context,
			store,
			(session, author) =>
				session.dispatch("annotations.textBox", { ...ANNOTATION_TEXT_STYLE, page, author, rect: commit.rect, text: commit.text }),
			finishTool
		)
	}

	const placeStamp = (placed: { readonly page: number; readonly rect: PdfRect }): void => {
		if (stamp === "image" || stamp === "imageFilen") {
			const image = shared.image

			if (image === null) {
				store.wantImage({
					page: placed.page,
					at: [(placed.rect[0] + placed.rect[2]) / 2, (placed.rect[1] + placed.rect[3]) / 2],
					box: space.box,
					source: stamp === "imageFilen" ? "filen" : "device"
				})

				return
			}

			store.setImage(null)
			made(
				context,
				store,
				(session, author) =>
					session.dispatch("annotations.image", { page: placed.page, author, rect: placed.rect, image: image.bytes }),
				finishTool
			)

			return
		}

		const name: PdfPresetStamp = stamp

		made(
			context,
			store,
			(session, author) => session.dispatch("annotations.stamp", { page: placed.page, author, rect: placed.rect, name }),
			finishTool
		)
	}

	const placeNote = (at: PdfPoint): void => {
		if (!context.editable) return

		store.compose({ kind: "note", page, at })
		context.finish()
	}

	// --- Pointer ---

	const onPointer = (type: PointerType, event: ReactPointerEvent<HTMLDivElement>): void => {
		if (type === "down") {
			if (event.button !== 0) return

			if (event.target instanceof Element) event.target.setPointerCapture(event.pointerId)
		}

		if (handing) {
			const scroller = scrollParent(rootRef.current)

			if (type === "down" && scroller !== null)
				hand.current = { x: event.clientX, y: event.clientY, left: scroller.scrollLeft, top: scroller.scrollTop }
			else if (type === "move" && hand.current !== null && scroller !== null)
				scroller.scrollTo({
					left: hand.current.left - (event.clientX - hand.current.x),
					top: hand.current.top - (event.clientY - hand.current.y)
				})
			else if (type === "up" || type === "cancel") hand.current = null

			return
		}

		const input = toolPointer(type, event)

		switch (mode) {
			case "select": {
				const step = selectPointer({ selected, drag: select.drag }, input, { annotations, tolerance })

				setSelect({ selected: null, drag: step.state.drag })

				if (step.state.selected !== selected) store.select(step.state.selected)

				const commit = step.commit

				if (commit === undefined || commit.kind === "select" || !context.editable) return

				context.edit(session =>
					commit.kind === "move"
						? session.dispatch("annotations.move", { ...commit.ref, dx: commit.dx, dy: commit.dy })
						: commit.kind === "resize"
							? session.dispatch("annotations.resize", { ...commit.ref, rect: commit.rect })
							: session.dispatch("annotations.delete", commit.ref)
				)

				return
			}
			case "textBox": {
				const step = textBoxPointer(textBox, input)

				setTextBox(step.state)
				commitTextBox(step.commit)

				return
			}
			case "draw": {
				const step = inkPointer(ink, input)
				const commit = step.commit

				setInk(step.state)

				if (commit === undefined || !context.editable) return

				void store.author().then(author => {
					if (author === null) return

					context.edit(async session => {
						const revision = session.getSnapshot().state.revision
						const target = store.inkTarget(commit.page, revision)
						const result =
							target === null
								? await session.dispatch("annotations.ink", { page: commit.page, author, strokes: [commit.points] })
								: await session.dispatch("annotations.inkStroke", { page: commit.page, id: target, stroke: commit.points })
						const id = result.created?.id ?? target

						if (id !== null) store.setInk({ page: commit.page, id, revision: result.state.revision })

						return result
					})
				})

				return
			}
			case "markup": {
				const lines = textLines(items ?? [], space)
				const step = markupPointer(markup, input, { quads: (_page, from, to) => quadsFromLines(lines, from, to) })
				const anchor = markup.drag?.anchor

				setMarkup(step.state)

				// The quads the editor marks come from its own text between the drag's ends; the draft's (the shown
				// text's) only decide that the drag went over text, or, with no text read, that it was a drag.
				const over =
					step.commit !== undefined ||
					(lines.length === 0 &&
						anchor !== undefined &&
						Math.hypot(input.point[0] - anchor[0], input.point[1] - anchor[1]) > TOOL_CLICK_SLOP)

				if (type === "up" && anchor !== undefined && over && context.editable) {
					const to = input.point

					made(context, store, (session, author) =>
						session.dispatch("annotations.markup", { page, author, kind: markup.kind, from: anchor, to })
					)
				}

				return
			}
			case "shape": {
				const step = shapePointer(shape, input)
				const commit = step.commit

				setShape(step.state)

				if (commit === undefined) return

				made(
					context,
					store,
					(session, author) =>
						commit.kind === "Line"
							? session.dispatch("annotations.line", {
									page: commit.page,
									author,
									from: commit.from,
									to: commit.to,
									...(variant === "Arrow" ? { end: "OpenArrow" as const } : {})
								})
							: session.dispatch("annotations.shape", { page: commit.page, author, kind: commit.kind, rect: commit.rect }),
					finishTool
				)

				return
			}
			case "stamp": {
				const step = rectToolPointer(rect, input, stampRect)

				setRect(step.state)

				if (step.commit !== undefined) placeStamp(step.commit)

				return
			}
			case "note":
				if (type === "up") placeNote(input.point)

				return
		}
	}

	// --- Keyboard placement (Enter on the page in view, arrows, Alt+arrows, Enter, Escape) ---

	const onKey = useEffectEvent((key: ToolKey): boolean => {
		const target = { page, box: space.box }

		switch (mode) {
			case "textBox": {
				const step = textBoxKey(textBox, key, target)

				if (step.state === textBox) return false

				setTextBox(step.state)
				commitTextBox(step.commit)

				return true
			}
			case "shape": {
				const step = shapeKey(shape, key, target)

				if (step.state === shape) return false

				setShape(step.state)

				const commit = step.commit

				if (commit !== undefined && commit.kind !== "Line") {
					made(
						context,
						store,
						(session, author) =>
							session.dispatch("annotations.shape", { page: commit.page, author, kind: commit.kind, rect: commit.rect }),
						finishTool
					)
				}

				return true
			}
			case "stamp": {
				const step = rectToolKey(rect, key, target, stampRect)

				if (step.state === rect) return false

				setRect(step.state)

				if (step.commit !== undefined) placeStamp(step.commit)

				return true
			}
			case "note": {
				if (key.key !== "Enter") return false

				placeNote([(space.box[0] + space.box[2]) / 2, (space.box[1] + space.box[3]) / 2])

				return true
			}
			default:
				return false
		}
	})

	useEffect(() => store.listenKeys(page, key => onKey(key)), [store, page])

	// Leaving the draw tool ends its drawing: the next one starts anew.
	useEffect(() => {
		if (mode !== "draw") return

		return () => {
			store.setInk(null)
		}
	}, [store, mode])

	// --- Selection actions (the popover) ---

	const restyle = (info: PdfAnnotationInfo, change: PdfAnnotationStyleChange): void => {
		if (info.locked || !context.editable) return

		context.edit(session => session.dispatch("annotations.style", { page: info.page, id: info.id, style: change }))
	}

	const remove = (info: PdfAnnotationInfo): void => {
		if (info.locked || !context.editable) return

		store.select(null)
		context.edit(session => session.dispatch("annotations.delete", { page: info.page, id: info.id }))
	}

	const comment = (info: PdfAnnotationInfo): void => {
		store.openComments(true)

		// An annotation without a note yet: its first comment becomes its note.
		if (info.text === "" && info.type !== "Text" && context.editable && !info.locked)
			store.compose({ kind: "comment", ref: { page: info.page, id: info.id } })
	}

	// A double click on a text box edits its text in place (selection stays the tool).
	const editText = (info: PdfAnnotationInfo): void => {
		if (info.type !== "FreeText" || info.locked || !context.editable) return

		dropped.current = false
		store.select(null)
		setTextBox(textBoxEdit(info.page, info.id, info.rect, info.text))
	}

	// --- Drawing ---

	const draft: PdfToolDraft | null =
		mode === "draw" && ink.stroke?.page === page
			? { kind: "ink", stroke: ink.stroke }
			: mode === "markup" && markup.drag?.page === page
				? { kind: "quads", quads: markup.drag.quads }
				: mode === "shape" && shape.line?.page === page
					? { kind: "line", from: shape.line.from, to: shape.line.to }
					: null
	const placed =
		mode === "shape"
			? rectToolDraft(shape)
			: mode === "stamp"
				? rectToolDraft(rect)
				: mode === "textBox"
					? rectToolDraft(textBox)
					: null
	const placedDraft: PdfToolDraft | null =
		placed?.page !== page
			? null
			: mode === "shape" && shape.kind === "Circle"
				? { kind: "ellipse", rect: placed.rect }
				: { kind: "rect", rect: placed.rect }
	const placement = mode === "shape" ? shape.placement : mode === "stamp" ? rect.placement : mode === "textBox" ? textBox.placement : null
	const editing = textBox.editing?.page === page ? textBox.editing : null
	const frameRect = selected === null ? null : select.drag?.moved === true ? select.drag.rect : selected.rect
	const capturing = mode !== "select"
	const popoverBox = selected === null || select.drag !== null || mode !== "select" ? null : viewBox(space, selected.rect)
	const toolName = t(placementToolKey(mode, variant))

	return (
		<div
			ref={rootRef}
			className="absolute inset-0"
			data-pdf-annotation-layer={mode}
			style={{
				pointerEvents: capturing ? "auto" : "none",
				touchAction: capturing ? "none" : undefined,
				cursor: handing ? "grab" : capturing ? "crosshair" : undefined
			}}
			onPointerDown={event => {
				onPointer("down", event)
			}}
			onPointerMove={event => {
				onPointer("move", event)
			}}
			onPointerUp={event => {
				onPointer("up", event)
			}}
			onPointerCancel={event => {
				onPointer("cancel", event)
			}}
		>
			<div
				className="absolute origin-center"
				style={pageLayerStyle(space)}
			>
				{mode === "select"
					? annotations.map(info => (
							<div
								key={info.id}
								className="absolute"
								data-annotation={info.id}
								data-annotation-type={info.type}
								style={{
									...rectStyle(
										info.id === selected?.id
											? [
													info.rect[0] - tolerance,
													info.rect[1] - tolerance,
													info.rect[2] + tolerance,
													info.rect[3] + tolerance
												]
											: info.rect,
										space.box
									),
									pointerEvents: "auto",
									cursor: canMove(info) && context.editable ? "move" : "pointer"
								}}
								onDoubleClick={() => {
									editText(info)
								}}
							/>
						))
					: null}
				{draft === null ? null : (
					<PdfToolDraftOverlay
						draft={draft}
						box={space.box}
					/>
				)}
				{placedDraft === null || placement !== null ? null : (
					<PdfToolDraftOverlay
						draft={placedDraft}
						box={space.box}
					/>
				)}
				{placement?.page === page ? (
					<PdfPlacementIndicator
						rect={placement.rect}
						box={space.box}
						announcement={t("previewPdfAnnotPlacement", {
							tool: toolName,
							x: Math.round(placement.rect[0]),
							y: Math.round(placement.rect[1]),
							width: Math.round(placement.rect[2] - placement.rect[0]),
							height: Math.round(placement.rect[3] - placement.rect[1])
						})}
					/>
				) : null}
				{frameRect === null || selected === null ? null : (
					<PdfSelectionFrame
						rect={frameRect}
						box={space.box}
						handles={mode === "select" && canResize(selected) && context.editable}
					/>
				)}
				{editing === null ? null : (
					<span
						className="contents"
						onPointerDown={event => {
							// The editor's own presses never reach the tool.
							event.stopPropagation()
						}}
						onKeyDown={event => {
							if (event.key !== "Escape") return

							event.preventDefault()
							event.stopPropagation()
							dropped.current = true
							setTextBox(TEXT_BOX_IDLE)
						}}
					>
						<PdfTextBoxEditor
							rect={editing.rect}
							box={space.box}
							text={editing.text}
							size={ANNOTATION_TEXT_STYLE.size}
							scale={space.scale}
							color={ANNOTATION_TEXT_STYLE.color}
							align={ANNOTATION_TEXT_STYLE.align}
							label={t("previewPdfAnnotTextBoxEditor")}
							onInput={text => {
								setTextBox(textBoxInput(textBox, text))
							}}
							onDone={() => {
								if (dropped.current) return

								dropped.current = true

								const step = textBoxFinish(textBox)

								setTextBox(step.state)
								commitTextBox(step.commit)
							}}
						/>
					</span>
				)}
			</div>
			{popoverBox === null || selected === null ? null : (
				<div
					className="absolute z-10 w-max"
					data-pdf-annotation-popover=""
					style={{ left: popoverBox.left, top: popoverBox.top + popoverBox.height + POPOVER_GAP_PX, pointerEvents: "auto" }}
					onPointerDown={event => {
						event.stopPropagation()
					}}
				>
					<PdfAnnotationPopover
						key={`${String(selected.page)}:${String(selected.id)}`}
						info={selected}
						onStyle={change => {
							restyle(selected, change)
						}}
						onComment={() => {
							comment(selected)
						}}
						onDelete={() => {
							remove(selected)
						}}
						{...(selected.type === "FileAttachment"
							? {
									downloadLabel: t("previewPdfAnnotAttachmentDownloadAny"),
									onDownload: () => {
										context.edit(session =>
											downloadAttachment(session, {
												kind: "annotation",
												ref: { page: selected.page, id: selected.id }
											})
										)
									}
								}
							: {})}
					/>
				</div>
			)}
		</div>
	)
}
