import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { fileURLToPath } from "node:url"
import { test, expect } from "./fixtures"
import { bootToSignIn } from "./helpers/listing"
import { WORKER_WEBGL } from "./helpers/workerWebgl"

// Re-checks, under the app's own CSP and COOP/COEP on this engine's runner, the platform facts the rich viewers are
// built on: binary FontFace, blob:/data: fetches refused by connect-src, worker createImageBitmap, worker WebGL2 on
// a transferred OffscreenCanvas with context loss and restore, worker requestAnimationFrame, no eval, and the
// DecompressionStream formats. The worker-WebGL row must match WORKER_WEBGL, which the 3D and DXF legs read.

const FONTS = fileURLToPath(new URL("../../filen-office/assets/fonts/tinos/", import.meta.url))

interface ProbeResult {
	crossOriginIsolated: boolean
	fontPageTtf: string
	fontPageWoff2: string
	fontWorkerTtf: string
	fontWorkerWoff2: string
	fontBlobUrl: string
	fetchBlobPage: string
	fetchDataPage: string
	fetchBlobWorker: string
	imageBitmapWorker: string
	webgl2Worker: boolean
	contextLost: boolean
	contextRestored: boolean
	animationFrameWorker: boolean
	newFunctionWorker: string
	decompression: Record<string, boolean>
}

const WORKER_SOURCE = `
const settle = (target, type, ms) => new Promise(resolve => {
	const timer = setTimeout(() => resolve(false), ms)
	target.addEventListener(type, event => { event.preventDefault(); clearTimeout(timer); resolve(true) }, { once: true })
})
const fontLoads = async bytes => {
	try { await new FontFace("probe", bytes).load(); return "loaded" } catch (error) { return error.name }
}
const refused = async url => {
	try { await fetch(url); return "allowed" } catch { return "blocked" }
}
self.onmessage = async ({ data }) => {
	const result = {
		fontWorkerTtf: await fontLoads(data.ttf),
		fontWorkerWoff2: await fontLoads(data.woff2),
		fetchBlobWorker: await refused(URL.createObjectURL(new Blob(["x"])))
	}
	try {
		const bitmap = await createImageBitmap(data.png)
		result.imageBitmapWorker = bitmap.width === 2 ? "ok" : "wrong size"
		bitmap.close()
	} catch (error) {
		result.imageBitmapWorker = error.name
	}
	const gl = data.canvas.getContext("webgl2")
	result.webgl2Worker = gl !== null
	result.contextLost = false
	result.contextRestored = false
	const lose = gl === null ? null : gl.getExtension("WEBGL_lose_context")
	if (lose !== null) {
		const lost = settle(data.canvas, "webglcontextlost", 5000)
		lose.loseContext()
		result.contextLost = await lost
		// Restored only once the loss has been handled, as an app would: a later task, not the lost event's own.
		await new Promise(resolve => setTimeout(resolve, 100))
		const restored = settle(data.canvas, "webglcontextrestored", 5000)
		lose.restoreContext()
		result.contextRestored = await restored
	}
	result.animationFrameWorker = await new Promise(resolve => {
		if (typeof requestAnimationFrame !== "function") { resolve(false); return }
		const timer = setTimeout(() => resolve(false), 5000)
		requestAnimationFrame(() => { clearTimeout(timer); resolve(true) })
	})
	try { new Function("return 1")(); result.newFunctionWorker = "allowed" } catch (error) { result.newFunctionWorker = error.name }
	result.decompression = {}
	for (const format of ["gzip", "deflate", "deflate-raw", "brotli"]) {
		try { new DecompressionStream(format); result.decompression[format] = true } catch { result.decompression[format] = false }
	}
	postMessage(result)
}
`

test.describe("rich viewer platform probe", () => {
	test.use({ injectSession: false })

	test("worker WebGL, fonts, CSP refusals and decompression on this engine", async ({ page, browserName }) => {
		await bootToSignIn(page)

		const ttf = [...gunzipSync(readFileSync(`${FONTS}Tinos-Regular.ttf.gz`))]
		const woff2 = [...readFileSync(`${FONTS}Tinos-Regular.woff2`)]
		const result = await page.evaluate(
			async ({ source, ttfBytes, woff2Bytes }) => {
				const fontLoads = async (bytes: ArrayBuffer) => {
					try {
						await new FontFace("probe", bytes).load()

						return "loaded"
					} catch (error) {
						return (error as Error).name
					}
				}
				const refused = async (url: string) => {
					try {
						await fetch(url)

						return "allowed"
					} catch {
						return "blocked"
					}
				}
				const ttfBuffer = new Uint8Array(ttfBytes).buffer
				const woff2Buffer = new Uint8Array(woff2Bytes).buffer
				const fontBlobUrl = await new FontFace(
					"probe-url",
					`url(${URL.createObjectURL(new Blob([woff2Buffer], { type: "font/woff2" }))})`
				)
					.load()
					.then(
						() => "loaded",
						() => "blocked"
					)
				const pixels = new OffscreenCanvas(2, 2)

				pixels.getContext("2d")?.fillRect(0, 0, 2, 2)

				const png = await pixels.convertToBlob({ type: "image/png" })
				const element = document.createElement("canvas")

				document.body.append(element)

				const canvas = element.transferControlToOffscreen()
				const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })))
				const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
					worker.onmessage = ({ data }: MessageEvent<Record<string, unknown>>) => {
						resolve(data)
					}
					worker.onerror = event => {
						reject(new Error(event.message))
					}
				})

				worker.postMessage({ ttf: ttfBuffer.slice(0), woff2: woff2Buffer.slice(0), png, canvas }, [canvas])

				const fromWorker = await answer

				worker.terminate()
				element.remove()

				return {
					crossOriginIsolated: self.crossOriginIsolated,
					fontPageTtf: await fontLoads(ttfBuffer),
					fontPageWoff2: await fontLoads(woff2Buffer),
					fontBlobUrl,
					fetchBlobPage: await refused(URL.createObjectURL(new Blob(["x"]))),
					fetchDataPage: await refused("data:text/plain,x"),
					...fromWorker
				} as unknown as ProbeResult
			},
			{ source: WORKER_SOURCE, ttfBytes: ttf, woff2Bytes: woff2 }
		)

		await test.info().attach(`probe-${browserName}.json`, { body: JSON.stringify(result, null, 2), contentType: "application/json" })

		expect(result.crossOriginIsolated).toBe(true)
		expect([result.fontPageTtf, result.fontPageWoff2, result.fontWorkerTtf, result.fontWorkerWoff2]).toEqual([
			"loaded",
			"loaded",
			"loaded",
			"loaded"
		])
		expect(result.fontBlobUrl).toBe("blocked")
		expect([result.fetchBlobPage, result.fetchDataPage, result.fetchBlobWorker]).toEqual(["blocked", "blocked", "blocked"])
		expect(result.imageBitmapWorker).toBe("ok")
		expect(result.newFunctionWorker).toBe("EvalError")
		expect(result.animationFrameWorker).toBe(true)
		expect(result.decompression).toMatchObject({ gzip: true, deflate: true, "deflate-raw": true })
		// Brotli is recorded, not asserted: an engine without it decodes in JS.
		expect(result.webgl2Worker).toBe(WORKER_WEBGL[browserName])

		if (result.webgl2Worker) {
			expect([result.contextLost, result.contextRestored]).toEqual([true, true])
		}
	})
})
