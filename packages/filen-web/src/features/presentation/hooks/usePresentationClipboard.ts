import { useEffect, type RefObject } from "react"
import type { TFunction } from "i18next"
import { toast } from "sonner"
import { deleteSlidesOp, insertTextBoxOp, type ShapeRef } from "@filen/office/core/presentation"
import type { ClipRequest, PresentationSessionApi } from "@filen/office/dom/presentation"
import { selectedShapes, shapeOf, slideShapes, type ShapeSelection } from "@filen/office/react/presentation"
import { isTextField } from "@/features/presentation/components/deckChrome.logic"
import { insertObject } from "@/features/presentation/components/ribbon/insertObjects"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import type { PresentationEditor } from "@/features/presentation/hooks/usePresentationSession"
import { blobSink, runPresentationJob } from "@/features/presentation/lib/presentationJobs"
import {
	clipboardPayload,
	clipboardRefusalKey,
	clipOfPaste,
	heldClip,
	holdClip,
	planPaste,
	pastedTextOp,
	releaseClipsOf,
	type ClipboardScope,
	type HeldClip,
	type PastedData
} from "@/features/presentation/lib/presentationClipboard"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { log } from "@/lib/log"
import { useLatestRef } from "@/lib/useLatestRef"

// Cut, Copy and Paste in the presentation editor, PowerPoint's way: on the slide they take the selected objects, in the
// slide list the selected slides. Ctrl/Cmd+X, C and V are the browser's clipboard events (listened for on the document:
// Firefox sends them to the body when the focused element holds no text selection, as the slide and the list never
// do); the ribbon and the menus run the same commands through the clipboard API inside their press. A body being typed
// in keeps its own clipboard (text). The clip is made by the worker, so its text, HTML and picture reach the system
// clipboard as promised items.

export interface PresentationClipboardCommands {
	// The selected objects (on the slide) or slides (in the slide list, or with no object selected); `at`: the menu's own.
	readonly copy: (cut: boolean, at?: ClipboardScope) => void
	readonly paste: (at?: ClipboardScope) => void
	// What the ribbon's Cut and Copy act on now: objects, slides, or nothing.
	readonly scope: () => ClipboardScope | undefined
}

// Where focus is in the editor: the slide list, the slide (its selection layer or its frame); undefined elsewhere (a
// body or a field, a pane, the ribbon).
function scopeOf(element: Element | null, root: HTMLElement | null): ClipboardScope | undefined {
	if (element === null || root === null || !root.contains(element) || isTextField(element)) return undefined
	if (element.closest(".fo-slide-rail") !== null) return "slides"
	if (element.closest("[data-fo-text-editor]") !== null) return undefined
	if (element.closest("[data-fo-shape-edit]") !== null || element.closest("[data-fo-slide-canvas]") !== null) return "shapes"

	return undefined
}

// The slide's width in px, at most this, for the picture a copy of slides gives other apps.
const SLIDE_PNG_PX = 1280
const PNG = "image/png"

async function pngOf(blob: Blob): Promise<Blob> {
	if (blob.type === PNG) return blob

	const bitmap = await createImageBitmap(blob)

	try {
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)

		canvas.getContext("2d")?.drawImage(bitmap, 0, 0)

		return await canvas.convertToBlob({ type: PNG })
	} finally {
		bitmap.close()
	}
}

// A lone picture's image, or the first slide's picture, as PNG.
function clipPicture(clip: HeldClip, session: PresentationSessionApi, slideWidth: number): Promise<Blob> {
	const made = clip.clip

	if (made.kind === "shapes") {
		const part = made.picture

		if (part === undefined) return Promise.reject(new Error("no picture"))

		return session.image(part).then(image => {
			if (image === null) throw new Error("no picture")

			return pngOf(new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.type }))
		})
	}

	const first = made.slides[0]

	if (first === undefined) return Promise.reject(new Error("no slide"))

	const output = blobSink(PNG)

	return runPresentationJob(
		"raster",
		{ format: "png", widthPx: Math.min(SLIDE_PNG_PX, Math.max(1, Math.round(slideWidth))), slides: [first], zip: false },
		session,
		output.sink,
		{ signal: new AbortController().signal }
	).then(() => output.blob())
}

class ClipRefused extends Error {
	readonly refusal: Parameters<typeof clipboardRefusalKey>[0]

	constructor(refusal: Parameters<typeof clipboardRefusalKey>[0]) {
		super(`clip refused: ${refusal}`)
		this.refusal = refusal
	}
}

// What the clipboard holds, read inside a control's press; null where the browser refused the read.
async function readClipboard(): Promise<PastedData | null> {
	try {
		const out = { text: "", html: "", files: [] as File[] }

		for (const item of await navigator.clipboard.read()) {
			for (const type of item.types) {
				if (type === "text/html" && out.html === "") out.html = await (await item.getType(type)).text()
				else if (type === "text/plain" && out.text === "") out.text = await (await item.getType(type)).text()
				else if (type.startsWith("image/")) out.files.push(new File([await item.getType(type)], "image", { type }))
			}
		}

		return out
	} catch {
		try {
			return { text: await navigator.clipboard.readText(), html: "", files: [] }
		} catch {
			return null
		}
	}
}

export function usePresentationClipboard({
	editor,
	selection,
	slideEditor,
	rootRef,
	takePictures,
	t
}: {
	editor: PresentationEditor
	selection: ShapeSelection
	// The slide's editor (undefined until the deck has a session).
	slideEditor: PresentationRibbonEditor | undefined
	rootRef: RefObject<HTMLElement | null>
	// Another app's pictures pasted on the slide.
	takePictures: (files: readonly File[]) => void
	t: TFunction<"preview">
}): PresentationClipboardCommands {
	const latest = useLatestRef({ editor, selection, slideEditor, takePictures, t })
	const session = editor.document.session

	// A clip that needs its deck's session (its parts, its slides) goes when the deck closes.
	useEffect(
		() => () => {
			if (session !== undefined) releaseClipsOf(session)
		},
		[session]
	)

	const selectedIds = (): { readonly slide: ShapeRef["slide"]; readonly ids: number[] } | undefined => {
		const { editor: current, selection: shapes } = latest.current
		const state = shapes.getSnapshot()
		const render = state.slide === undefined ? undefined : current.document.renders.get(state.slide)

		if (state.slide === undefined || render === undefined || state.ids.length === 0) return undefined

		return { slide: state.slide, ids: selectedShapes(render, state).map(shape => shape.id) }
	}

	const scope = (): ClipboardScope | undefined => {
		const focused = scopeOf(document.activeElement, rootRef.current)

		if (focused === "slides") return latest.current.editor.selection.length > 0 ? "slides" : undefined
		if (selectedIds() !== undefined) return "shapes"

		return latest.current.editor.selection.length > 0 ? "slides" : undefined
	}

	const tell = (refusal: Parameters<typeof clipboardRefusalKey>[0], pasting: boolean): void => {
		if (refusal === "closed") return

		toast.error(latest.current.t(clipboardRefusalKey(refusal, pasting)))
	}

	const blocked = (key: string): void => {
		toast.error(latest.current.t("previewPptxClipboardBlocked", { shortcut: isMacPlatform() ? `⌘${key}` : `Ctrl+${key}` }))
	}

	const copyIn = (cut: boolean, at: ClipboardScope): void => {
		const { editor: current, selection: shapes } = latest.current
		const live = current.document.session

		if (live === undefined || (cut && !current.editable)) return

		const chosen = at === "shapes" ? selectedIds() : undefined

		if (at === "shapes" && chosen === undefined) return

		const request: ClipRequest =
			chosen === undefined
				? { kind: "slides", slides: current.selection, cut }
				: { kind: "shapes", slide: chosen.slide, shapes: chosen.ids }

		if (request.kind === "slides" && request.slides.length === 0) return

		const made = live.clip(request).then(answer => {
			if (!answer.ok) throw new ClipRefused(answer.refusal)

			return holdClip(answer.clip, live)
		})
		// Decided now, inside the gesture: an item the clipboard is promised must arrive. A lone picture and slides give
		// other apps a picture too.
		const render = chosen === undefined ? undefined : current.document.renders.get(chosen.slide)
		const lone = chosen?.ids.length === 1 ? shapeOf(render, chosen.ids[0] ?? -1) : undefined
		const picture = request.kind === "slides" || (lone?.role === "picture" && lone.media === undefined)
		// Slide px (9,525 EMU each).
		const slideWidth = (current.document.info?.size.cx ?? 0) / 9525
		const text = made.then(clip => new Blob([clipboardPayload(clip).text], { type: "text/plain" }))
		const html = made.then(clip => new Blob([clipboardPayload(clip).html], { type: "text/html" }))
		const written =
			typeof ClipboardItem === "function"
				? navigator.clipboard
						.write([
							new ClipboardItem({
								"text/plain": text,
								"text/html": html,
								...(picture ? { [PNG]: made.then(clip => clipPicture(clip, live, slideWidth)) } : {})
							})
						])
						// No picture (or one the clipboard refused): the text and HTML alone, else the text.
						.catch(() =>
							picture
								? navigator.clipboard.write([new ClipboardItem({ "text/plain": text, "text/html": html })])
								: Promise.reject(new Error("the clipboard refused the copy"))
						)
						.catch(() => made.then(clip => navigator.clipboard.writeText(clipboardPayload(clip).text)))
				: made.then(clip => navigator.clipboard.writeText(clipboardPayload(clip).text))

		void made.then(
			() => {
				// A cut is the delete of what it copied, its own step.
				if (!cut) return

				if (chosen !== undefined) {
					shapes.clear()
					void current.command({ family: "shape", kind: "delete", slide: chosen.slide, shapes: chosen.ids })

					return
				}

				const order = current.document.slides.map(slide => slide.ref)
				const op = deleteSlidesOp(order, current.selection)

				if (op !== undefined) void current.run(op, Math.max(0, Math.min(current.current, order.length - op.slides.length - 1)))
			},
			(error: unknown) => {
				if (error instanceof ClipRefused) tell(error.refusal, false)
				else log.warn("presentation", "a copy failed", { error })
			}
		)
		// The clip is the app's even where the system clipboard was not written: a paste here still pastes it.
		void written.catch((error: unknown) => {
			log.info("presentation", "the system clipboard was not written", { error })
		})
	}

	const pasteClip = async (clip: HeldClip): Promise<void> => {
		const { editor: current, selection: shapes } = latest.current
		const live = current.document.session
		const info = current.document.info

		if (live === undefined || info === undefined || !current.editable) return

		const slide = current.currentRef
		const render = slide === undefined ? undefined : current.document.renders.get(slide)
		const plan = await planPaste(clip, {
			session: live,
			format: info.format,
			order: current.document.slides.map(entry => entry.ref),
			current: current.current,
			slide,
			boxes: slideShapes(render).map(shape => shape.xfrm)
		})

		if (plan.kind === "refused") {
			tell(plan.reason, true)

			return
		}

		if (plan.kind === "slides") {
			void current.run(plan.ops, plan.select)

			return
		}

		// The pasted objects become the selection once the slide shows them.
		const withdraw = shapes.selectNew(
			plan.slide,
			slideShapes(render).map(shape => shape.id)
		)

		if (!(await current.command(plan.op)).ok) withdraw()
	}

	const pasteData = (data: PastedData | null, at: ClipboardScope): boolean => {
		const own = clipOfPaste(data, heldClip())

		if (own !== undefined) {
			void pasteClip(own)

			return true
		}

		if (data === null) return false

		const { slideEditor: ribbon, takePictures: pictures } = latest.current
		const images = data.files.filter(file => file.type.startsWith("image/"))

		if (ribbon?.info.editable !== true) return false

		// Another app's text: a text box on the slide; its pictures (with no text) go in as pictures.
		if (data.text.trim() !== "") {
			const deck = { size: ribbon.info.size, format: ribbon.info.format }

			void insertObject(ribbon, (slide, id) => pastedTextOp(insertTextBoxOp(deck, slide, id), data.text))

			return true
		}

		if (images.length > 0 && at === "slides") {
			pictures(images)

			return true
		}

		return false
	}

	const commands = useLatestRef({ copyIn, pasteData, selectedIds })

	useEffect(() => {
		const listener = (event: ClipboardEvent): void => {
			if (event.defaultPrevented) return

			const { copyIn: copy, pasteData: paste, selectedIds: selected } = commands.current
			const at = scopeOf(document.activeElement, rootRef.current)

			if (at === undefined) return

			if (event.type === "paste") {
				const data = event.clipboardData
				const pasted: PastedData = {
					text: data?.getData("text/plain") ?? "",
					html: data?.getData("text/html") ?? "",
					files: data === null ? [] : [...data.files]
				}

				// Pictures alone are the slide's picture drop's (insertObjects.tsx), which takes them after this.
				if (paste(pasted, at)) {
					event.preventDefault()
					event.stopPropagation()
				}

				return
			}

			const target = at === "slides" ? "slides" : selected() === undefined ? undefined : "shapes"

			if (target === undefined) return

			event.preventDefault()
			copy(event.type === "cut", target)
		}

		// Capture: before the slide's own paste handling (React's, on the editor's root).
		document.addEventListener("copy", listener, true)
		document.addEventListener("cut", listener, true)
		document.addEventListener("paste", listener, true)

		return () => {
			document.removeEventListener("copy", listener, true)
			document.removeEventListener("cut", listener, true)
			document.removeEventListener("paste", listener, true)
		}
	}, [commands, rootRef])

	return {
		scope,
		copy: (cut, asked) => {
			const at = asked ?? scope()

			if (at !== undefined) copyIn(cut, at)
		},
		paste: asked => {
			const at = asked ?? scope() ?? "shapes"

			void readClipboard().then(data => {
				if (pasteData(data, at)) return
				if (data === null) blocked("V")
				else if (data.files.some(file => file.type.startsWith("image/"))) latest.current.takePictures(data.files)
			})
		}
	}
}
