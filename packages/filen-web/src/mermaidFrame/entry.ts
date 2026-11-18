import mermaid from "mermaid"
import { mermaidFrameConfig, type MermaidJob, type MermaidReply, type MermaidTheme } from "@/mermaidFrame/config"

// The diagram frame's script (a classic script of its own, built by vite/mermaidFrame.ts): it renders the page's jobs
// to SVG strings, one at a time, and answers only its parent. It runs in a sandboxed, opaque-origin frame whose policy
// loads nothing but this script, so whatever a diagram names is never fetched.

const TOO_COMPLEX = /edge limit exceeded|maximum text size/i

let configured: MermaidTheme | null = null
let queue: Promise<void> = Promise.resolve()

function isJob(data: unknown): data is MermaidJob {
	if (typeof data !== "object" || data === null) {
		return false
	}

	const job = data as Record<string, unknown>

	return typeof job["id"] === "number" && typeof job["source"] === "string" && (job["theme"] === "default" || job["theme"] === "dark")
}

// Mermaid sizes the drawing to its container (width 100%, a max-width style); a picture needs its own size, the view
// box's. Only the root's start tag is rewritten.
const ROOT_TAG = /^<svg\b[^>]*>/
const VIEW_BOX = /\sviewBox="[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)"/

function sized(svg: string): string {
	const tag = ROOT_TAG.exec(svg)?.[0]
	const box = tag === undefined ? null : VIEW_BOX.exec(tag)
	const width = Math.ceil(Number(box?.[1]))
	const height = Math.ceil(Number(box?.[2]))

	if (tag === undefined || !(width > 0) || !(height > 0)) {
		return svg
	}

	const resized = tag
		.replace(/\s(?:width|height)="[^"]*"/g, "")
		.replace(/max-width:\s*[\d.]+px;?/, "")
		.replace(/^<svg\b/, `<svg width="${String(width)}" height="${String(height)}"`)

	return resized + svg.slice(tag.length)
}

async function render(job: MermaidJob): Promise<MermaidReply> {
	if (configured !== job.theme) {
		mermaid.initialize(mermaidFrameConfig(job.theme))
		configured = job.theme
	}

	try {
		const { svg } = await mermaid.render(`mermaid-${String(job.id)}`, job.source)

		return { id: job.id, svg: sized(svg) }
	} catch (e) {
		return { id: job.id, error: TOO_COMPLEX.test(e instanceof Error ? e.message : String(e)) ? "tooComplex" : "failed" }
	}
}

window.addEventListener("message", event => {
	if (event.source !== window.parent || !isJob(event.data)) {
		return
	}

	const job = event.data

	queue = queue.then(async () => {
		const reply = await render(job)

		// Whatever the render left behind (its measuring elements).
		document.body.replaceChildren()
		window.parent.postMessage(reply, "*")
	})
})

// Loaded: the page posts jobs from here on.
window.parent.postMessage({ ready: true }, "*")
