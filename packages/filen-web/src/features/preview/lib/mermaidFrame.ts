import { type } from "arktype"
import { MERMAID_FRAME_SCRIPT } from "virtual:mermaid-frame"
import { log } from "@/lib/log"
import { registerPreviewDisposer } from "@/lib/workers/previewDisposers"
import type { MermaidJob, MermaidTheme } from "@/mermaidFrame/config"

// Renders Mermaid diagrams in a frame of their own: sandboxed with scripts only (an opaque origin: no storage, no
// navigation of the page, no popups, no forms), under a policy of its own that loads nothing but the frame's script.
// That policy is intersected with the page's, so whatever a diagram names (an image, a stylesheet, a font) is refused
// before any request is made. The page gets back an SVG string and shows it as a picture, which runs nothing and loads
// nothing either.
//
// One host per viewer: the frame is created for the first diagram and removed when the viewer goes (release), at
// sign-out, when it navigates itself, and when a render runs past its time (the next job gets a fresh frame). Jobs run
// one at a time; outcomes are kept per theme and source until release.

export const MERMAID_TIMEOUT_MS = 5000
export const MERMAID_MAX_SVG_BYTES = 10 * 1024 * 1024

// `url`: the drawing as a data: URL (an opened "image in a new tab" is then an opaque-origin document, never one of the
// app's origin, as a blob: URL minted by the page would be).
export type MermaidOutcome = { readonly kind: "svg"; readonly url: string } | { readonly kind: "failed" } | { readonly kind: "tooComplex" }

const FrameMessage = type({ ready: "true" }).or({ id: "number", svg: "string" }).or({ id: "number", error: "'failed' | 'tooComplex'" })

const SVG_ROOT = /^\s*<svg[\s>]/

// Off screen but laid out (the renderer measures text), never painted, focused or hit.
const FRAME_STYLE = "position:fixed;left:-10000px;top:0;width:1280px;height:1024px;border:0;visibility:hidden;pointer-events:none"

function attribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
}

// The frame's whole document: its policy, then its script, by absolute URL (the frame's origin is opaque).
export function mermaidFrameDocument(scriptUrl: string): string {
	const url = attribute(scriptUrl)

	return (
		`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${url}; ` +
		`style-src 'unsafe-inline'"><script src="${url}"></script></head><body></body></html>`
	)
}

// The frame's answer as a picture: an SVG document's root, within the size cap, as a data: URL. Anything else is not
// shown.
export function mermaidSvgUrl(svg: string): string | null {
	if (svg.length > MERMAID_MAX_SVG_BYTES || !SVG_ROOT.test(svg) || new TextEncoder().encode(svg).length > MERMAID_MAX_SVG_BYTES) {
		return null
	}

	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

interface Frame {
	readonly element: HTMLIFrameElement
	readonly ready: Promise<boolean>
	readonly remove: () => void
}

interface Pending {
	readonly id: number
	readonly settle: (outcome: MermaidOutcome) => void
}

export class MermaidHost {
	private frame: Frame | null = null
	private pending: Pending | null = null
	private tail: Promise<unknown> = Promise.resolve()
	private nextId = 1
	private generation = 0
	private readonly outcomes = new Map<string, Promise<MermaidOutcome>>()

	public render(source: string, theme: MermaidTheme): Promise<MermaidOutcome> {
		const key = `${theme}\0${source}`
		const known = this.outcomes.get(key)

		if (known !== undefined) {
			return known
		}

		const generation = this.generation
		const outcome = this.tail.then(() =>
			generation === this.generation ? this.run({ id: this.nextId++, source, theme }) : { kind: "failed" as const }
		)

		this.tail = outcome
		this.outcomes.set(key, outcome)

		return outcome
	}

	// Removes the frame and forgets every outcome; jobs still queued settle as failed. The host stays usable.
	public release(): void {
		this.generation++
		this.outcomes.clear()
		this.removeFrame()
	}

	private async run(job: MermaidJob): Promise<MermaidOutcome> {
		const frame = this.ensureFrame()

		if (!(await frame.ready) || frame !== this.frame) {
			return { kind: "failed" }
		}

		return new Promise<MermaidOutcome>(resolve => {
			const timer = setTimeout(() => {
				log.warn("mermaidFrame", "a diagram ran past its time; its frame is removed")
				this.pending = null
				this.removeFrame()
				resolve({ kind: "tooComplex" })
			}, MERMAID_TIMEOUT_MS)

			this.pending = {
				id: job.id,
				settle: outcome => {
					clearTimeout(timer)
					this.pending = null
					resolve(outcome)
				}
			}
			frame.element.contentWindow?.postMessage(job, "*")
		})
	}

	private ensureFrame(): Frame {
		if (this.frame !== null) {
			return this.frame
		}

		const element = document.createElement("iframe")
		let loads = 0
		let markReady: (ready: boolean) => void = () => undefined
		const ready = new Promise<boolean>(resolve => {
			markReady = resolve
		})
		const readyTimer = setTimeout(() => {
			log.warn("mermaidFrame", "the diagram frame's script did not start")
			markReady(false)
			this.removeFrame()
		}, MERMAID_TIMEOUT_MS)

		const onMessage = (event: MessageEvent): void => {
			if (event.source === null || event.source !== element.contentWindow) {
				return
			}

			const message = FrameMessage(event.data)

			if (message instanceof type.errors) {
				return
			}

			if ("ready" in message) {
				clearTimeout(readyTimer)
				markReady(true)

				return
			}

			if (this.pending?.id !== message.id) {
				return
			}

			if ("error" in message) {
				this.pending.settle({ kind: message.error })

				return
			}

			const url = mermaidSvgUrl(message.svg)

			this.pending.settle(url === null ? { kind: "failed" } : { kind: "svg", url })
		}
		// The frame's document loads once; a second load is the frame navigating itself.
		const onLoad = (): void => {
			loads++

			if (loads > 1) {
				log.warn("mermaidFrame", "the diagram frame navigated; it is removed")
				this.removeFrame()
			}
		}
		const unregister = registerPreviewDisposer("mermaidFrame", () => {
			this.release()
		})
		const frame: Frame = {
			element,
			ready,
			remove: () => {
				clearTimeout(readyTimer)
				markReady(false)
				window.removeEventListener("message", onMessage)
				element.removeEventListener("load", onLoad)
				element.remove()
				unregister()
			}
		}

		element.setAttribute("sandbox", "allow-scripts")
		element.setAttribute("aria-hidden", "true")
		element.tabIndex = -1
		element.style.cssText = FRAME_STYLE
		element.srcdoc = mermaidFrameDocument(new URL(MERMAID_FRAME_SCRIPT, window.location.href).href)
		element.addEventListener("load", onLoad)
		window.addEventListener("message", onMessage)
		document.body.append(element)
		this.frame = frame

		return frame
	}

	private removeFrame(): void {
		const frame = this.frame

		this.frame = null
		frame?.remove()
		this.pending?.settle({ kind: "failed" })
	}
}
