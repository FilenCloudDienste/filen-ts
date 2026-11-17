import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { crc32, createDeflate } from "node:zlib"
import type { Browser, Page } from "@playwright/test"
import { test, expect } from "../fixtures"

// What the browser's own decode of a huge image costs (on request: FILEN_WEB_E2E_IMAGE_BENCH=1; every engine): the
// measurement the preview's huge-image policy waits on. An image is shown as the preview shows it, an <img> fitted to
// the view; then zoomed ×4 by a transform, as the viewer zooms; then ten images are stepped through, as the pager does.
// Per case: the time to the first decoded paint, the peak resident memory of the engine's processes over the case
// (sampled every 100 ms, less what they held before the image), and whether the page crashed. An engine's crash
// threshold is the fewest pixels that crashed it; none means it showed every fixture.
//
// Fixtures are solid images written here (a decoded frame costs the same whatever its content): PNG at 100 and
// 400 MP, baseline JPEG at 24, 48 and 100 MP, and WebP at 64 MP encoded by the Chromium run's own canvas when it runs
// first. HEIC has no encoder here and is not measured. FILEN_WEB_E2E_IMAGE_BENCH_RECORD=<path> writes the results.
// nativeImageDecode.baseline.<engine>.json are the records of the run the policy was decided on (Apple Silicon desktop,
// 128 GB; Playwright's Chromium 158, Firefox 159 and WebKit 27.2): no engine crashed on any fixture, so no engine has a
// threshold and the native view stays as it is. A phone's run is made by hand on the device.

test.skip(process.env["FILEN_WEB_E2E_IMAGE_BENCH"] !== "1", "The image decode bench runs on request (FILEN_WEB_E2E_IMAGE_BENCH=1)")
test.use({ injectSession: false })

const BENCH_ORIGIN = "http://image-bench.invalid"
const FIXTURES = join(tmpdir(), "filen-image-bench")
const MB = 1024 * 1024
const SAMPLE_MS = 100
const STEPS = 10

interface Fixture {
	readonly name: string
	readonly type: string
	readonly width: number
	readonly height: number
	// Writes the file; null where this run cannot make it (WebP before a Chromium run made it).
	readonly write: ((path: string) => void | Promise<void>) | null
}

// ── Writers ──────────────────────────────────────────────────────────────────

function pngChunk(type: string, data: Buffer): Buffer {
	const body = Buffer.concat([Buffer.from(type, "latin1"), data])
	const length = Buffer.alloc(4)
	const crc = Buffer.alloc(4)

	length.writeUInt32BE(data.length)
	crc.writeUInt32BE(crc32(body))

	return Buffer.concat([length, body, crc])
}

// A solid black 8-bit RGB PNG, its rows deflated as they are made.
async function writePng(path: string, width: number, height: number): Promise<void> {
	const deflate = createDeflate({ level: 9 })
	const parts: Buffer[] = []
	const done = new Promise<void>((resolve, reject) => {
		deflate.on("data", (part: Buffer) => parts.push(part))
		deflate.on("end", resolve)
		deflate.on("error", reject)
	})
	// Filter byte 0, then the row's samples.
	const row = Buffer.alloc(1 + width * 3)

	for (let y = 0; y < height; y++) {
		if (!deflate.write(row)) {
			await new Promise(resolve => deflate.once("drain", resolve))
		}
	}

	deflate.end()
	await done

	const header = Buffer.alloc(13)

	header.writeUInt32BE(width, 0)
	header.writeUInt32BE(height, 4)
	header.set([8, 2, 0, 0, 0], 8)
	writeFileSync(
		path,
		Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			pngChunk("IHDR", header),
			pngChunk("IDAT", Buffer.concat(parts)),
			pngChunk("IEND", Buffer.alloc(0))
		])
	)
}

// The DHT segment of ITU-T T.81 Annex K.3's typical Huffman table: class/id, the 16 code-length counts, the values.
function dht(classId: number, counts: readonly number[], values: readonly number[]): Buffer {
	const body = Buffer.from([classId, ...counts, ...values])
	const head = Buffer.from([0xff, 0xc4, 0, 0])

	head.writeUInt16BE(body.length + 2, 2)

	return Buffer.concat([head, body])
}

// A solid mid-grey baseline JPEG, 4:4:4: every block's DC difference is 0 and its AC run ends at once, so each MCU is
// the same 14 bits under the Annex K tables (luminance DC "00", AC end of block "1010"; chrominance "00" and "00").
function writeJpeg(path: string, width: number, height: number): void {
	const quant = Buffer.from([0xff, 0xdb, 0, 67, 0, ...new Array<number>(64).fill(1)])
	const sof = Buffer.from([
		0xff,
		0xc0,
		0,
		17,
		8,
		height >> 8,
		height & 0xff,
		width >> 8,
		width & 0xff,
		3,
		1,
		0x11,
		0,
		2,
		0x11,
		0,
		3,
		0x11,
		0
	])
	const tables = Buffer.concat([
		// Luminance DC and AC (only the codes used need be right: DC category 0 and AC 0x00).
		dht(0x00, [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
		dht(0x10, [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d], ANNEX_K_LUMINANCE_AC),
		dht(0x01, [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
		dht(0x11, [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77], ANNEX_K_CHROMINANCE_AC)
	])
	const sos = Buffer.from([0xff, 0xda, 0, 12, 3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0])
	const mcus = Math.ceil(width / 8) * Math.ceil(height / 8)
	const bits = mcus * 14
	const scan = Buffer.alloc(Math.ceil(bits / 8))
	// 00 1010 / 00 00 / 00 00, repeated: no byte of it is 0xFF, so nothing is stuffed.
	const pattern = [0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]

	for (let bit = 0; bit < bits; bit++) {
		if (pattern[bit % 14] === 1) {
			scan[bit >> 3] = (scan[bit >> 3] ?? 0) | (0x80 >> (bit & 7))
		}
	}

	// The last byte padded with 1 bits.
	if (bits % 8 !== 0) {
		scan[scan.length - 1] = (scan[scan.length - 1] ?? 0) | (0xff >> (bits % 8))
	}

	writeFileSync(path, Buffer.concat([Buffer.from([0xff, 0xd8]), quant, sof, tables, sos, scan, Buffer.from([0xff, 0xd9])]))
}

// T.81 Table K.5 and K.6 values (the AC tables' 162 symbols each).
const ANNEX_K_LUMINANCE_AC = [
	0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91,
	0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a,
	0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53,
	0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79,
	0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
	0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
	0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2,
	0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa
]
const ANNEX_K_CHROMINANCE_AC = [
	0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14,
	0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17,
	0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a,
	0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78,
	0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3,
	0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
	0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2,
	0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa
]

const FIXTURE_LIST: readonly Fixture[] = [
	{
		name: "jpeg-24mp.jpg",
		type: "image/jpeg",
		width: 6000,
		height: 4000,
		write: path => {
			writeJpeg(path, 6000, 4000)
		}
	},
	{
		name: "jpeg-48mp.jpg",
		type: "image/jpeg",
		width: 8000,
		height: 6000,
		write: path => {
			writeJpeg(path, 8000, 6000)
		}
	},
	{
		name: "jpeg-100mp.jpg",
		type: "image/jpeg",
		width: 12_000,
		height: 8400,
		write: path => {
			writeJpeg(path, 12_000, 8400)
		}
	},
	{ name: "png-100mp.png", type: "image/png", width: 12_000, height: 8400, write: path => writePng(path, 12_000, 8400) },
	{ name: "png-400mp.png", type: "image/png", width: 20_000, height: 20_000, write: path => writePng(path, 20_000, 20_000) },
	{ name: "webp-64mp.webp", type: "image/webp", width: 8000, height: 8000, write: null }
]

// ── Measuring ────────────────────────────────────────────────────────────────

// The resident memory of every process running from the engine's install, in MB (the browser, its renderers, GPU and
// network processes): what a phone's memory pressure would see.
function engineRssMb(engine: string): number {
	// Any build of the engine in the Playwright install (…/ms-playwright/<engine>[_headless_shell]-<build>/).
	const install = new RegExp(`/ms-playwright/${engine}(?:_headless_shell)?-\\d+/`, "u")
	const listing = execFileSync("ps", ["-A", "-o", "rss=,command="], { encoding: "utf8", maxBuffer: 64 * MB })
	let kb = 0

	for (const line of listing.split("\n")) {
		const match = /^\s*(\d+)\s+(.*)$/u.exec(line)

		if (match !== null && install.test(match[2] ?? "")) {
			kb += Number(match[1])
		}
	}

	return kb / 1024
}

// The peak over `run`, sampled.
async function peakDuring<T>(engine: string, run: () => Promise<T>): Promise<{ value: T; peakMb: number }> {
	let peak = engineRssMb(engine)
	const timer = setInterval(() => {
		peak = Math.max(peak, engineRssMb(engine))
	}, SAMPLE_MS)

	try {
		const value = await run()

		peak = Math.max(peak, engineRssMb(engine))

		return { value, peakMb: peak }
	} finally {
		clearInterval(timer)
	}
}

interface CaseResult {
	readonly firstPaintMs: number | null
	readonly fitPeakMb: number | null
	readonly zoomPeakMb: number | null
	readonly stepMs: number | null
	readonly stepPeakMb: number | null
	readonly crashed: boolean
}

async function openBench(browser: Browser): Promise<{ page: Page; crashed: () => boolean; close: () => Promise<void> }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
	const page = await context.newPage()
	let crashed = false

	page.on("crash", () => {
		crashed = true
	})

	await page.route(`${BENCH_ORIGIN}/**`, async route => {
		const name = new URL(route.request().url()).pathname.slice(1)
		const fixture = FIXTURE_LIST.find(entry => entry.name === name)

		if (fixture === undefined) {
			await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>bench</title><body style=margin:0>" })

			return
		}

		await route.fulfill({ path: join(FIXTURES, fixture.name), contentType: fixture.type })
	})
	await page.goto(`${BENCH_ORIGIN}/`)

	return { page, crashed: () => crashed, close: () => context.close() }
}

// Shows `name` fitted to the view, as the preview does, and resolves with the time to its decoded paint.
function show(page: Page, name: string, query: string): Promise<number> {
	return page.evaluate(
		async ({ src }) => {
			document.body.replaceChildren()

			const image = new Image()

			image.style.cssText = "max-width:100vw;max-height:100vh;display:block;margin:auto"

			const start = performance.now()

			image.src = src
			document.body.append(image)
			await image.decode()
			await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

			if (image.naturalWidth === 0) {
				throw new Error("the image did not decode")
			}

			return performance.now() - start
		},
		{ src: `${BENCH_ORIGIN}/${name}?${query}` }
	)
}

async function measure(browser: Browser, engine: string, fixture: Fixture): Promise<CaseResult> {
	const bench = await openBench(browser)
	const failed: CaseResult = { firstPaintMs: null, fitPeakMb: null, zoomPeakMb: null, stepMs: null, stepPeakMb: null, crashed: true }

	try {
		const base = engineRssMb(engine)
		const fit = await peakDuring(engine, () => show(bench.page, fixture.name, "fit"))
		const zoom = await peakDuring(engine, () =>
			bench.page.evaluate(async () => {
				const image = document.querySelector("img")

				if (image !== null) image.style.transform = "scale(4)"

				await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
				await new Promise(resolve => setTimeout(resolve, 500))
			})
		)
		const step = await peakDuring(engine, async () => {
			const start = Date.now()

			for (let index = 0; index < STEPS; index++) {
				await show(bench.page, fixture.name, `step${String(index)}`)
			}

			return Date.now() - start
		})

		return {
			firstPaintMs: Math.round(fit.value),
			fitPeakMb: Math.round(fit.peakMb - base),
			zoomPeakMb: Math.round(zoom.peakMb - base),
			stepMs: step.value,
			stepPeakMb: Math.round(step.peakMb - base),
			crashed: bench.crashed()
		}
	} catch (error) {
		test.info().annotations.push({ type: "bench-error", description: `${fixture.name}: ${String(error)}` })

		return { ...failed, crashed: bench.crashed() }
	} finally {
		await bench.close().catch(() => undefined)
	}
}

async function writeFixtures(browser: Browser, browserName: string): Promise<void> {
	mkdirSync(FIXTURES, { recursive: true })

	for (const fixture of FIXTURE_LIST) {
		const path = join(FIXTURES, fixture.name)

		if (!existsSync(path) && fixture.write !== null) {
			await fixture.write(path)
		}
	}

	const webp = FIXTURE_LIST.find(entry => entry.type === "image/webp")

	// WebP from the Chromium run's own encoder: a canvas of the size, its encode written out.
	if (webp !== undefined && !existsSync(join(FIXTURES, webp.name)) && browserName === "chromium") {
		const bench = await openBench(browser)

		try {
			const base64 = await bench.page.evaluate(
				async ({ width, height }) => {
					const canvas = new OffscreenCanvas(width, height)

					canvas.getContext("2d")?.fillRect(0, 0, width, height)

					const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.8 })
					const bytes = new Uint8Array(await blob.arrayBuffer())
					let binary = ""

					for (const byte of bytes) binary += String.fromCharCode(byte)

					return btoa(binary)
				},
				{ width: webp.width, height: webp.height }
			)

			writeFileSync(join(FIXTURES, webp.name), Buffer.from(base64, "base64"))
		} finally {
			await bench.close()
		}
	}
}

test("native image decode cost", async ({ browser, browserName }, testInfo) => {
	test.setTimeout(FIXTURE_LIST.length * 600_000)

	await writeFixtures(browser, browserName)

	const results: Record<string, unknown> = {}
	let crashThreshold: number | null = null

	for (const fixture of FIXTURE_LIST) {
		if (!existsSync(join(FIXTURES, fixture.name))) {
			results[fixture.name] = { measured: false }

			continue
		}

		const pixels = fixture.width * fixture.height
		const result = await measure(browser, browserName, fixture)

		results[fixture.name] = { megapixels: Math.round(pixels / 1e6), ...result }

		if (result.crashed) {
			crashThreshold = crashThreshold === null ? pixels : Math.min(crashThreshold, pixels)
		}
	}

	const report = JSON.stringify({ engine: browserName, version: browser.version(), crashThreshold, results }, null, "\t")

	await testInfo.attach(`native-image-decode-${browserName}`, { body: report, contentType: "application/json" })

	const recordPath = process.env["FILEN_WEB_E2E_IMAGE_BENCH_RECORD"]

	// One record per engine beside the path; a final newline, as the format check wants of a recorded baseline.
	if (recordPath !== undefined && recordPath !== "") writeFileSync(recordPath.replace(/\.json$/u, `.${browserName}.json`), `${report}\n`)

	expect(Object.keys(results)).toHaveLength(FIXTURE_LIST.length)
})
