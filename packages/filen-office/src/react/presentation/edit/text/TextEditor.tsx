import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Slice } from "prosemirror-model"
import { TextSelection, type Transaction } from "prosemirror-state"
import { ReplaceStep } from "prosemirror-transform"
import { EditorView } from "prosemirror-view"
import {
	backspaceAtStart,
	caretRunProps,
	deleteAtEnd,
	horizontalMove,
	insertLineBreak,
	pastedSlice,
	plainTextSlice,
	selectAllText,
	setParaProps,
	splitParagraph,
	stepFontSize,
	tabKey,
	toggleRunFlag,
	toggleUnderline,
	type PastedElement,
	type TextCommand
} from "../../../../core/presentation/edit/commands/text"
import { PresentationError, type PresentationRefusal, type RunProps, type ShapeRef } from "../../../../core/presentation/model"
import type { SlideRender, TextPage } from "../../../../core/presentation/output"
import type { TextMeasurer } from "../../../../core/text/index"
import { canMeasureOffscreen, canvasMeasurer, offscreenMeasurer, type CanvasContextLike } from "../../../../dom/canvasMeasurer"
import type { PresentationSessionApi } from "../../../../dom/presentation/protocol"
import { paintPage, patchPage } from "../../../docx/paint/page"
import { deleteBeforeComposition, deleteSelectionKey, inputTransaction } from "../../../docx/edit/input"
import { safeClipboardHtml } from "../../../docx/edit/clipboard"
import { TextEditController } from "./controller"
import type { TextEditing } from "./editing"
import { pendingInsertion, TextEcho } from "./echo"
import { DEFAULT_TEXT_BINDINGS, textKeyCommand, type TextKeyBindings, type TextKeyCommand } from "./keys"
import { measureCacheFor } from "./layoutMap"

// The body being edited on the slide: the worker's TextPage painted under the shape's text matrix, the caret and the
// selection drawn over it from the transferred layout, and an invisible ProseMirror view that holds focus and takes
// all input (keys, beforeinput, IME composition, clipboard). The view's own DOM is never shown; it is moved so its
// native caret sits on the painted one, where input methods anchor their candidate windows (the docx sink's way).
// Mounted in SlideView's overlay (screen px of the slide frame); `scale` is the slide's. Hit testing measures on an
// OffscreenCanvas where there is one, the realm kind the worker lays out in (Firefox's <canvas> measures differently).

export interface TextEditorLabels {
	// The editing area's accessible name.
	readonly editor: string
}

export interface PresentationTextEditorProps {
	readonly session: PresentationSessionApi
	readonly shape: ShapeRef
	readonly scale: number
	readonly editing: TextEditing
	readonly labels: TextEditorLabels
	// The slide in view (its painted text of this shape is hidden while editing).
	readonly render?: SlideRender
	readonly readOnly?: boolean
	// Where a click lands first, in slide px (the click that opened the body).
	readonly at?: { readonly x: number; readonly y: number }
	readonly onExit: () => void
	readonly onRefused: (reason: PresentationRefusal) => void
	// Cmd (Apple platforms) or Ctrl as the shortcut modifier.
	readonly apple?: boolean
	// What carets are measured with: this realm's OffscreenCanvas (or <canvas>) by default.
	readonly measurer?: TextMeasurer
	// The rebindable keys as the app's keymap resolves them (PowerPoint's by default).
	readonly bindings?: TextKeyBindings
}

let mainMeasurer: TextMeasurer | undefined

function measurer(): TextMeasurer {
	if (mainMeasurer !== undefined) return mainMeasurer

	if (canMeasureOffscreen(globalThis)) {
		try {
			mainMeasurer = offscreenMeasurer(globalThis)

			return mainMeasurer
		} catch {
			// No 2D context on an OffscreenCanvas here: a <canvas> one.
		}
	}

	const context = document.createElement("canvas").getContext("2d") as CanvasContextLike | null

	if (context === null) throw new PresentationError("unsupported", "no canvas to measure with")

	mainMeasurer = canvasMeasurer(context)

	return mainMeasurer
}

function invert(m: readonly number[]): number[] | undefined {
	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m
	const det = a * d - b * c

	if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return undefined

	return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]
}

function apply(m: readonly number[], x: number, y: number): { x: number; y: number } {
	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m

	return { x: a * x + c * y + e, y: b * x + d * y + f }
}

// Typing: plain replacements with no paste or drop behind them (they coalesce into one undo step).
function isTyping(tr: Transaction): boolean {
	return (
		tr.docChanged &&
		tr.getMeta("uiEvent") === undefined &&
		tr.steps.every(step => step instanceof ReplaceStep && step.slice.content.childCount <= 1)
	)
}

const ALIGN_OF = { alignLeft: "l", alignCenter: "ctr", alignRight: "r", justify: "just" } as const

const insertTab: TextCommand = (state, dispatch) => {
	dispatch?.(state.tr.insertText("\t").scrollIntoView())

	return true
}

// What a painted page's line looks name by index: equal keys keep every index's meaning.
function tablesKey(page: TextPage): string {
	return JSON.stringify([page.styles, page.paints, page.strokes, page.textEffects, page.decorations, page.links])
}

function modifier(event: KeyboardEvent, apple: boolean): boolean {
	return apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

export function PresentationTextEditor({
	session,
	shape,
	scale,
	editing,
	labels,
	render,
	readOnly,
	at,
	onExit,
	onRefused,
	apple: appleProp,
	measurer: measurerProp,
	bindings = DEFAULT_TEXT_BINDINGS
}: PresentationTextEditorProps) {
	const rootRef = useRef<HTMLDivElement | null>(null)
	const boxRef = useRef<HTMLDivElement | null>(null)
	const pageRef = useRef<HTMLDivElement | null>(null)
	const marksRef = useRef<HTMLDivElement | null>(null)
	const sinkRef = useRef<HTMLDivElement | null>(null)
	const [controller, setController] = useState<TextEditController | undefined>(undefined)
	// Draws the body again (a new scale moves the box, the caret and the sink with it).
	const redraw = useRef<(() => void) | undefined>(undefined)
	const latest = useRef({ onExit, onRefused, scale, readOnly: readOnly === true, bindings })
	// The first caret's place: read once, when the body opens.
	const firstAt = useRef(at)

	latest.current = { onExit, onRefused, scale, readOnly: readOnly === true, bindings }

	const apple = appleProp ?? /Mac|iPhone|iPad/u.test(String(Reflect.get(Reflect.get(globalThis, "navigator") ?? {}, "platform") ?? ""))

	// The seed: once per mounted body.
	useEffect(() => {
		let cancelled = false
		let made: TextEditController | undefined

		session.textSeed(shape).then(
			seed => {
				if (cancelled) return

				try {
					made = new TextEditController(session, seed, measureCacheFor(measurerProp ?? measurer()), reason =>
						latest.current.onRefused(reason)
					)
				} catch (error) {
					latest.current.onRefused(error instanceof PresentationError ? error.reason : "unsupported")
					latest.current.onExit()

					return
				}

				editing.set(made)
				setController(made)
			},
			(error: unknown) => {
				if (cancelled) return

				latest.current.onRefused(error instanceof PresentationError ? error.reason : "failed")
				latest.current.onExit()
			}
		)

		return () => {
			cancelled = true

			if (made !== undefined) {
				const closing = made

				if (editing.active === closing) editing.set(undefined)

				void closing.close()
			}
		}
	}, [session, shape, editing, measurerProp])

	// The shape's painted text on the slide is hidden while its body is edited here (every new render paints it again).
	// Its layers are the slide's own: a layout's or master's layer names its own node.
	useLayoutEffect(() => {
		const frame = rootRef.current?.closest(".fo-slide-frame")

		if (frame === null || frame === undefined || render === undefined) return

		const hidden: HTMLElement[] = []

		render.layers.forEach((layer, index) => {
			if (layer.shape.slide !== shape.slide || layer.shape.id !== shape.id || layer.text === undefined) return
			// A table cell's body hides that cell's text only.
			if (shape.cell !== undefined && (layer.cell?.[0] !== shape.cell.row || layer.cell[1] !== shape.cell.col)) return

			const painted = frame.querySelector<HTMLElement>(`.fo-slide-content [data-fo-layer="${String(index)}"] > .fo-slide-text`)

			if (painted === null) return

			painted.style.visibility = "hidden"
			hidden.push(painted)
		})

		return () => {
			for (const painted of hidden) painted.style.visibility = ""
		}
	}, [render, shape])

	// The input sink and the painting, driven by the controller.
	useEffect(() => {
		const sink = sinkRef.current
		const box = boxRef.current
		const pageHost = pageRef.current
		const marks = marksRef.current
		const root = rootRef.current

		if (controller === undefined || sink === null || box === null || pageHost === null || marks === null || root === null) return

		const document = sink.ownerDocument
		const caret = document.createElement("div")
		let paintedPage = controller.page
		let painted = paintPage(controller.page.page, { document, tables: controller.page, paints: controller.page })
		let paintedTables = tablesKey(controller.page)
		const echo = new TextEcho()
		let offsetX = 0
		let offsetY = 0
		let blink: Animation | undefined
		// The sink is aligned once per frame, where the browser lays out anyway (it reads layout).
		let aligning = 0
		const frames = document.defaultView

		caret.className = "fo-text-caret"
		caret.style.cssText = "position:absolute;width:1px;background:#000;pointer-events:none"
		pageHost.replaceChildren(painted.root)

		const run = (command: TextCommand, typing = false): boolean => !latest.current.readOnly && controller.run(command, typing)
		const defaults = (): typeof controller.defaults => controller.defaults
		const bound = (command: TextKeyCommand): boolean => {
			switch (command) {
				case "bold":
				case "italic":
					return run(toggleRunFlag(command === "bold" ? "b" : "i", defaults())) || true
				case "underline":
					return run(toggleUnderline(defaults())) || true
				case "growFont":
				case "shrinkFont":
					return run(stepFontSize(command === "growFont" ? 1 : -1, defaults())) || true
				case "alignLeft":
				case "alignCenter":
				case "alignRight":
				case "justify":
					return run(setParaProps({ algn: ALIGN_OF[command] }, defaults())) || true
				case "lineBreak":
					return run(insertLineBreak) || true
				case "levelDown":
				case "levelUp":
					return run(tabKey(command === "levelDown" ? 1 : -1, defaults())) || true
				case "link":
					return (!latest.current.readOnly && editing.requestLink()) || true
			}
		}

		const keymap = (event: KeyboardEvent): boolean => {
			const mod = modifier(event, apple)
			const key = event.key

			if (key === "Escape") {
				// The slide's canvas takes focus back (its shape stays selected; a second Escape is the canvas's).
				root.closest(".fo-slide-frame")?.querySelector<HTMLElement>("[data-fo-shape-edit]")?.focus({ preventScroll: true })
				void controller.close().then(() => latest.current.onExit())

				return true
			}

			if (key === "ArrowLeft" || key === "ArrowRight") {
				const direction = key === "ArrowRight" ? 1 : -1
				const rtl = controller.rtl

				// Cmd+Arrow on Apple platforms: the line's edge.
				if (apple && event.metaKey) {
					const state = controller.state
					const next = controller.map.lineEdge(state.selection.head, (direction === 1) !== rtl ? "end" : "start")

					controller.setSelection(event.shiftKey ? state.selection.anchor : next, next)

					return true
				}

				const word = apple ? event.altKey : event.ctrlKey

				return controller.run(horizontalMove(rtl ? (-direction as 1 | -1) : direction, word ? "word" : "char", event.shiftKey))
			}

			if (mod && !event.altKey) {
				const lower = key.toLowerCase()

				if (lower === "z") {
					void controller.step(event.shiftKey ? "redo" : "undo")

					return true
				}

				if (lower === "y" && !apple) {
					void controller.step("redo")

					return true
				}

				if (lower === "a" && !event.shiftKey) return run(selectAllText) || true
			}

			const command = event.isComposing ? undefined : textKeyCommand(event, latest.current.bindings, apple)

			if (command !== undefined) return bound(command)
			if (mod) return false

			if (key === "Enter" && !event.isComposing) return run(splitParagraph)
			// Tab with its level keys bound elsewhere: a tab character.
			if (key === "Tab") return (!event.shiftKey && run(insertTab)) || true

			if (key === "Backspace" && !event.altKey && !event.ctrlKey && !event.metaKey) {
				const state = controller.state
				const tr = deleteSelectionKey(state)

				if (tr !== null) {
					if (!latest.current.readOnly) controller.dispatch(tr, true)

					return true
				}

				return run(backspaceAtStart(defaults()), true)
			}

			if (key === "Delete" && !event.altKey && !event.ctrlKey && !event.metaKey) {
				const tr = deleteSelectionKey(controller.state)

				if (tr !== null) {
					if (!latest.current.readOnly) controller.dispatch(tr, true)

					return true
				}

				return run(deleteAtEnd, true)
			}

			if ((key === "ArrowUp" || key === "ArrowDown") && !mod) {
				const state = controller.state
				const head = state.selection.head
				const box = controller.map.caret(head)
				const goal = controller.goalX ?? box?.x ?? 0
				const target = controller.map.lineMove(head, key === "ArrowUp" ? -1 : 1, goal)
				const next = target ?? (key === "ArrowUp" ? 1 : state.doc.content.size - 1)

				controller.setSelection(event.shiftKey ? state.selection.anchor : next, next)
				controller.goalX = goal

				return true
			}

			if ((key === "Home" || key === "End") && !mod) {
				const state = controller.state
				const next = controller.map.lineEdge(state.selection.head, key === "Home" ? "start" : "end")

				controller.setSelection(event.shiftKey ? state.selection.anchor : next, next)

				return true
			}

			return false
		}

		const view = new EditorView(
			{ mount: sink },
			{
				state: controller.state,
				attributes: { "aria-label": labels.editor, "aria-multiline": "true", role: "textbox", spellcheck: "false" },
				editable: () => !latest.current.readOnly,
				dispatchTransaction: tr => {
					if (tr.docChanged && latest.current.readOnly) return

					// The view's state is the controller's: positions match step for step.
					controller.dispatch(tr, isTyping(tr))
				},
				handleKeyDown: (_view, event) => {
					if (event.isComposing || event.keyCode === 229) return false
					if (event.key !== "ArrowUp" && event.key !== "ArrowDown") controller.goalX = undefined

					return keymap(event)
				},
				handleDOMEvents: {
					beforeinput: (_view, event) => {
						const tr = inputTransaction(view, controller.state, event)

						if (tr === undefined) return false

						event.preventDefault()

						if (!latest.current.readOnly) controller.dispatch(tr, true)

						return true
					},
					compositionstart: () => {
						const tr = deleteBeforeComposition(controller.state)

						if (tr !== null && !latest.current.readOnly) controller.dispatch(tr, true)

						return false
					},
					blur: () => {
						void controller.flush()

						return false
					}
				},
				handlePaste: (_view, event) => {
					if (latest.current.readOnly) return true

					const data = event.clipboardData
					const html = data?.getData("text/html") ?? ""
					const text = data?.getData("text/plain") ?? ""
					const state = controller.state
					const base: RunProps = caretRunProps(state)
					const endRPr = state.selection.$from.parent.attrs["endRPr"] as RunProps | null
					let slice: Slice = Slice.empty

					if (html !== "") {
						const safe = safeClipboardHtml(html)
						const Parser: unknown = Reflect.get(globalThis, "DOMParser")

						if (safe !== "" && typeof Parser === "function") {
							const parsed = new (Parser as new () => DOMParser)().parseFromString(`<body>${safe}</body>`, "text/html")

							slice = pastedSlice(parsed.body as unknown as PastedElement, base, endRPr)
						}
					}

					if (slice.size === 0 && text !== "") slice = plainTextSlice(text, base, endRPr)
					if (slice.size === 0) return true

					controller.dispatch(state.tr.replaceSelection(slice).scrollIntoView().setMeta("uiEvent", "paste"))

					return true
				},
				// Drops are not taken (pictures and files belong to the slide).
				handleDrop: () => true
			}
		)

		// Moves the sink so its native caret is on the painted one (input method windows anchor there).
		const align = (): void => {
			const caretRect = caret.getBoundingClientRect()

			if (caretRect.height === 0) return

			let coords: { left: number; top: number }

			try {
				coords = view.coordsAtPos(view.state.selection.head)
			} catch {
				return
			}

			const lineHeight = Math.max(8, Math.round(caretRect.height))

			sink.style.fontSize = `${String(Math.round((lineHeight / 1.2) * 10) / 10)}px`
			sink.style.lineHeight = `${String(lineHeight)}px`

			const dx = caretRect.left - coords.left
			const dy = caretRect.top - coords.top

			if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return

			offsetX += dx
			offsetY += dy
			sink.style.transform = `translate(${String(Math.round(offsetX * 10) / 10)}px,${String(Math.round(offsetY * 10) / 10)}px)`
		}

		const scheduleAlign = (): void => {
			if (aligning !== 0) return
			if (frames === null || typeof frames.requestAnimationFrame !== "function") {
				align()

				return
			}

			aligning = frames.requestAnimationFrame(() => {
				aligning = 0
				align()
			})
		}

		const draw = (): void => {
			// The echo of typing the worker has not laid out yet is drawn again from scratch on every draw.
			echo.restore()

			if (controller.page !== paintedPage) {
				const page = controller.page
				const tables = tablesKey(page)
				const context = { document, tables: page, paints: page }

				// Only the lines that look different are painted again while the style tables are the same (line looks
				// name styles by index).
				if (tables === paintedTables) {
					painted = patchPage(painted, page.page, context).painted
				} else {
					painted = paintPage(page.page, context)
					pageHost.replaceChildren(painted.root)
					paintedTables = tables
				}

				paintedPage = page
			}

			const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = controller.matrix
			const s = latest.current.scale

			box.style.transform = `matrix(${String(a * s)},${String(b * s)},${String(c * s)},${String(d * s)},${String(e * s)},${String(f * s)})`
			box.style.width = `${String(controller.page.page.width)}px`
			box.style.height = `${String(controller.page.page.height)}px`

			const state = controller.state
			const selection = state.selection
			// Positions of the state map onto the layout of the document it was built from; while a newer layout is in
			// flight the caret is placed on the older one, clamped.
			const size = controller.mapDoc.content.size
			const head = Math.min(selection.head, size)
			const boxes = selection.empty ? [] : controller.map.selection(Math.min(selection.from, size), Math.min(selection.to, size))
			const children: HTMLElement[] = []

			for (const item of boxes) {
				const mark = document.createElement("div")

				mark.style.cssText = `position:absolute;left:${String(item.x)}px;top:${String(item.top)}px;width:${String(item.width)}px;height:${String(item.height)}px;background:rgba(56,132,255,0.32);pointer-events:none`
				children.push(mark)
			}

			const typed = selection.empty ? pendingInsertion(controller.mapDoc, state.doc) : undefined
			const echoed = typed === undefined || typed.end !== selection.head ? undefined : controller.map.echo(typed.pos, typed.text)
			const place =
				echoed !== undefined &&
				echo.apply(painted, echoed.paragraph, echoed.offset, typed?.text ?? "", controller.map.texts[echoed.paragraph] ?? "")
					? echoed.caret
					: controller.map.caret(head)

			if (place !== undefined && selection.empty) {
				caret.style.left = `${String(place.x)}px`
				caret.style.top = `${String(place.top)}px`
				caret.style.height = `${String(place.height)}px`
				caret.style.width = `${String(Math.max(1, 1 / Math.max(0.01, s)))}px`
				children.push(caret)
			}

			marks.replaceChildren(...children)

			if (view.state !== controller.state) view.updateState(controller.state)

			// The caret shows at once after any change, then blinks.
			if (selection.empty) {
				if (blink === undefined && typeof caret.animate === "function") {
					blink = caret.animate([{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }], {
						duration: 1060,
						iterations: Infinity,
						delay: 500
					})
					blink.finished.catch(() => undefined)
				} else if (blink !== undefined) {
					blink.currentTime = 0
				}
			}

			scheduleAlign()
		}

		// Pointer: positions come from the painted layout, never from the sink's own text.
		const pagePoint = (event: MouseEvent): { x: number; y: number } | undefined => {
			const frame = root.getBoundingClientRect()
			const inverse = invert(controller.matrix)
			const s = latest.current.scale

			if (inverse === undefined || s <= 0) return undefined

			return apply(inverse, (event.clientX - frame.left) / s, (event.clientY - frame.top) / s)
		}
		let dragging = false
		let anchor = 0

		const onPointerDown = (event: MouseEvent): void => {
			if (event.button !== 0) return

			const point = pagePoint(event)

			if (point === undefined) return

			event.preventDefault()
			event.stopPropagation()

			const pos = controller.map.posAt(point.x, point.y)
			const clicks = event.detail

			if (clicks === 2 || clicks === 3) {
				const $pos = controller.state.doc.resolve(Math.min(pos, controller.state.doc.content.size))

				if (clicks === 3) {
					controller.setSelection($pos.start(1), $pos.end(1))
				} else {
					const text = $pos.parent.textBetween(0, $pos.parent.content.size, undefined, "￼")
					const word = /[\p{L}\p{N}_'’]/u
					let start = $pos.parentOffset
					let end = start

					while (start > 0 && word.test(text[start - 1] ?? "")) start--
					while (end < text.length && word.test(text[end] ?? "")) end++

					controller.setSelection($pos.start() + start, $pos.start() + end)
				}

				view.focus()

				return
			}

			anchor = event.shiftKey ? controller.state.selection.anchor : pos
			dragging = true
			controller.goalX = undefined
			controller.setSelection(anchor, pos)
			view.focus()
		}

		const onPointerMove = (event: MouseEvent): void => {
			if (!dragging) return

			const point = pagePoint(event)

			if (point !== undefined) controller.setSelection(anchor, controller.map.posAt(point.x, point.y))
		}

		const onPointerUp = (): void => {
			dragging = false
		}

		box.addEventListener("mousedown", onPointerDown)
		document.addEventListener("mousemove", onPointerMove)
		document.addEventListener("mouseup", onPointerUp)

		const unsubscribe = controller.subscribe(draw)

		redraw.current = draw
		draw()

		const at = firstAt.current

		firstAt.current = undefined

		if (at !== undefined) {
			const inverse = invert(controller.matrix)
			const point = inverse === undefined ? undefined : apply(inverse, at.x, at.y)

			if (point !== undefined)
				controller.dispatch(
					controller.state.tr.setSelection(
						TextSelection.near(
							controller.state.doc.resolve(
								Math.min(controller.map.posAt(point.x, point.y), controller.state.doc.content.size)
							)
						)
					)
				)
		}

		view.focus()

		return () => {
			redraw.current = undefined
			unsubscribe()

			if (aligning !== 0) frames?.cancelAnimationFrame(aligning)

			blink?.cancel()
			box.removeEventListener("mousedown", onPointerDown)
			document.removeEventListener("mousemove", onPointerMove)
			document.removeEventListener("mouseup", onPointerUp)
			view.destroy()
			sink.replaceChildren()
		}
	}, [controller, apple, labels.editor])

	useLayoutEffect(() => {
		redraw.current?.()
	}, [scale])

	return (
		<div
			ref={rootRef}
			className="fo-text-editor"
			style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
			data-fo-text-editor=""
		>
			<div
				ref={boxRef}
				className="fo-text-edit-box"
				style={{ position: "absolute", left: 0, top: 0, transformOrigin: "0 0", pointerEvents: "auto", cursor: "text" }}
			>
				<div
					ref={pageRef}
					style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
				/>
				<div
					ref={marksRef}
					style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
				/>
			</div>
			<div
				ref={sinkRef}
				className="fo-text-sink"
				style={{
					position: "absolute",
					left: 0,
					top: 0,
					width: 640,
					height: 24,
					overflow: "hidden",
					opacity: 0,
					zIndex: -1,
					pointerEvents: "none",
					caretColor: "transparent",
					color: "transparent",
					whiteSpace: "pre-wrap"
				}}
			/>
		</div>
	)
}
