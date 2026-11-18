// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MERMAID_FRAME_SCRIPT } from "virtual:mermaid-frame"
import {
	MERMAID_MAX_SVG_BYTES,
	MERMAID_TIMEOUT_MS,
	MermaidHost,
	mermaidFrameDocument,
	mermaidSvgBlob,
	type MermaidOutcome
} from "@/features/preview/lib/mermaidFrame"
import { runPreviewDisposers } from "@/lib/workers/previewDisposers"

// The page side of the diagram frame: the frame's sandbox and policy, its one-job-at-a-time protocol answered only by
// the frame itself, the picture checks, the time cap, and every way the frame is removed.

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'

function frames(): HTMLIFrameElement[] {
	return [...document.querySelectorAll("iframe")]
}

function onlyFrame(): HTMLIFrameElement {
	const [frame, ...rest] = frames()

	if (frame === undefined || rest.length > 0) {
		throw new Error(`expected one frame, found ${String(frames().length)}`)
	}

	return frame
}

// What the frame's script would post.
function fromFrame(frame: HTMLIFrameElement, data: unknown): void {
	window.dispatchEvent(new MessageEvent("message", { data, source: frame.contentWindow }))
}

function posted(frame: HTMLIFrameElement): ReturnType<typeof vi.fn> {
	const post = vi.fn()

	Object.defineProperty(frame.contentWindow, "postMessage", { value: post, configurable: true })

	return post
}

async function settle(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0)
}

// A started host with its frame ready: the post spy, and the frame.
async function readyHost(
	host: MermaidHost,
	source = "graph TD; A-->B"
): Promise<{ outcome: Promise<MermaidOutcome>; post: ReturnType<typeof vi.fn>; frame: HTMLIFrameElement }> {
	const outcome = host.render(source, "default")

	await settle()

	const frame = onlyFrame()
	const post = posted(frame)

	fromFrame(frame, { ready: true })
	await settle()

	return { outcome, post, frame }
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	runPreviewDisposers()
	document.body.replaceChildren()
	vi.useRealTimers()
})

describe("the diagram frame's document", () => {
	it("is its policy and its script, and nothing else", () => {
		expect(mermaidFrameDocument("https://app.example/assets/mermaid-frame-0123abcd.js")).toBe(
			'<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
				"script-src https://app.example/assets/mermaid-frame-0123abcd.js; style-src 'unsafe-inline'\">" +
				'<script src="https://app.example/assets/mermaid-frame-0123abcd.js"></script></head><body></body></html>'
		)
		expect(mermaidFrameDocument('https://a.example/x.js?"><b>')).not.toContain('"><b>')
	})
})

describe("mermaidSvgBlob", () => {
	it("takes an SVG document's root within the size cap, and nothing else", async () => {
		const blob = mermaidSvgBlob(SVG)

		expect(blob?.type).toBe("image/svg+xml")
		expect(await blob?.text()).toBe(SVG)
		expect(mermaidSvgBlob(`\n  ${SVG}`)).not.toBeNull()
		expect(mermaidSvgBlob('<html><svg xmlns="http://www.w3.org/2000/svg"></svg></html>')).toBeNull()
		expect(mermaidSvgBlob("<svgx></svgx>")).toBeNull()
		expect(mermaidSvgBlob(`<svg>${"x".repeat(MERMAID_MAX_SVG_BYTES)}</svg>`)).toBeNull()
		// Characters under the cap, bytes over it.
		expect(mermaidSvgBlob(`<svg>${"é".repeat(MERMAID_MAX_SVG_BYTES / 2)}</svg>`)).toBeNull()
	})
})

describe("MermaidHost", () => {
	it("creates a frame sandboxed with scripts only, off screen, with the policy document", async () => {
		const host = new MermaidHost()

		void host.render("graph TD; A-->B", "default")
		await settle()

		const frame = onlyFrame()

		expect(frame.getAttribute("sandbox")).toBe("allow-scripts")
		expect(frame.getAttribute("aria-hidden")).toBe("true")
		expect(frame.style.visibility).toBe("hidden")
		expect(frame.srcdoc).toBe(mermaidFrameDocument(new URL(MERMAID_FRAME_SCRIPT, window.location.href).href))
	})

	it("posts the job once the frame's script started, and takes the frame's answer only", async () => {
		const host = new MermaidHost()
		const { outcome, post, frame } = await readyHost(host)

		expect(post).toHaveBeenCalledWith({ id: 1, source: "graph TD; A-->B", theme: "default" }, "*")

		// Another window, a wrong id and a malformed answer are all ignored.
		window.dispatchEvent(new MessageEvent("message", { data: { id: 1, svg: SVG }, source: window }))
		fromFrame(frame, { id: 2, svg: SVG })
		fromFrame(frame, { id: 1, svg: 5 })
		await settle()

		let settled = false

		void outcome.then(() => {
			settled = true
		})
		await settle()
		expect(settled).toBe(false)

		fromFrame(frame, { id: 1, svg: SVG })

		const result = await outcome

		expect(result.kind).toBe("svg")
		expect(result.kind === "svg" ? await result.svg.text() : null).toBe(SVG)
	})

	it("refuses an answer that is not an SVG picture", async () => {
		const host = new MermaidHost()
		const { outcome, frame } = await readyHost(host)

		fromFrame(frame, { id: 1, svg: "<html></html>" })

		expect(await outcome).toEqual({ kind: "failed" })
	})

	it("passes on the frame's own errors", async () => {
		const host = new MermaidHost()
		const { outcome, frame } = await readyHost(host)

		fromFrame(frame, { id: 1, error: "tooComplex" })

		expect(await outcome).toEqual({ kind: "tooComplex" })
	})

	it("runs one job at a time, and answers a repeated source from what it kept", async () => {
		const host = new MermaidHost()
		const { outcome, post, frame } = await readyHost(host, "graph TD; A-->B")
		const second = host.render("pie", "default")
		const again = host.render("graph TD; A-->B", "default")

		await settle()
		expect(post).toHaveBeenCalledTimes(1)
		expect(again).toBe(outcome)

		fromFrame(frame, { id: 1, svg: SVG })
		await outcome
		await settle()

		expect(post).toHaveBeenCalledTimes(2)
		expect(post).toHaveBeenLastCalledWith({ id: 2, source: "pie", theme: "default" }, "*")
		fromFrame(frame, { id: 2, svg: SVG })
		expect((await second).kind).toBe("svg")

		// Another theme is another drawing.
		void host.render("pie", "dark")
		await settle()
		expect(post).toHaveBeenLastCalledWith({ id: 3, source: "pie", theme: "dark" }, "*")
	})

	it("removes the frame of a job past its time, and gives the next job a fresh one", async () => {
		const host = new MermaidHost()
		const { outcome, frame } = await readyHost(host)

		await vi.advanceTimersByTimeAsync(MERMAID_TIMEOUT_MS)

		expect(await outcome).toEqual({ kind: "tooComplex" })
		expect(frame.isConnected).toBe(false)
		expect(frames()).toEqual([])

		void host.render("pie", "default")
		await settle()
		expect(onlyFrame()).not.toBe(frame)
	})

	it("fails when the frame's script never starts", async () => {
		const host = new MermaidHost()
		const outcome = host.render("pie", "default")

		await settle()
		await vi.advanceTimersByTimeAsync(MERMAID_TIMEOUT_MS)

		expect(await outcome).toEqual({ kind: "failed" })
		expect(frames()).toEqual([])
	})

	it("removes a frame that loads a second time (it navigated)", async () => {
		const host = new MermaidHost()
		const { outcome, frame } = await readyHost(host)

		frame.dispatchEvent(new Event("load"))
		frame.dispatchEvent(new Event("load"))

		expect(await outcome).toEqual({ kind: "failed" })
		expect(frame.isConnected).toBe(false)
	})

	it("removes the frame on release and at sign-out, and stays usable", async () => {
		const host = new MermaidHost()
		const { outcome } = await readyHost(host)
		const queued = host.render("pie", "default")

		host.release()

		expect(await outcome).toEqual({ kind: "failed" })
		expect(await queued).toEqual({ kind: "failed" })
		expect(frames()).toEqual([])

		await readyHost(host)
		runPreviewDisposers()
		expect(frames()).toEqual([])
	})
})
