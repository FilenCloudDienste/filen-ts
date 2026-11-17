import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { FIXTURE_FILES, openFixtureRows } from "./helpers/fixtures"
import { readMse, recordMse, resetMse } from "./helpers/mseRecorder"
import { fmp4Samples } from "./helpers/fmp4"

// Observability, not a playback check: the demuxer tests' H.264 streams with B-frames (AVI, whose reorder the demuxer
// infers with no presentation times to go by, ASF and MPEG-PS) played in the preview, recording per file what the
// browser reports and what the remux worker handed it. It fails only on an error event (the element's, or a
// SourceBuffer's), never on a playhead that stalls: that is what the record is for.

const FILES = FIXTURE_FILES["preview-legacy-bframes"]
// How long each file is watched, and how often.
const WATCH_MS = 15_000
const SAMPLE_MS = 500
// Samples read back per SourceBuffer.
const SAMPLES = 40

interface Moment {
	at: number
	currentTime: number
	paused: boolean
	readyState: number
	networkState: number
	buffered: [number, number][]
	error: { code: number; message: string } | null
	quality: { total: number; dropped: number; corrupted: number } | null
}

test("B-frame AVI, ASF and MPEG-PS: what each browser reports while it plays them", async ({ page, browserName }, testInfo) => {
	test.slow()

	const appLog: string[] = []

	page.on("console", message => {
		if (message.type() === "warning" || message.type() === "error") {
			appLog.push(`${message.type()}: ${message.text()}`)
		}
	})
	await recordMse(page)
	await bootTo(page)

	const { rows } = await openFixtureRows(page, "preview-legacy-bframes")
	const failures: string[] = []

	for (const [index, name] of FILES.entries()) {
		const row = rows[index]

		if (row === undefined) {
			continue
		}

		appLog.length = 0
		await resetMse(page)
		await row.dblclick()

		const video = page.getByRole("dialog").locator("video")

		await expect(video).toHaveCount(1, { timeout: LAZY_VIEWER_TIMEOUT_MS })
		await video.evaluate(el => {
			const element = el as HTMLVideoElement

			element.muted = true
			void element.play().catch(() => undefined)
		})

		const moments: Moment[] = []

		for (let elapsed = 0; elapsed <= WATCH_MS; elapsed += SAMPLE_MS) {
			const moment = await video
				.evaluate((el, at): Moment => {
					const element = el as HTMLVideoElement
					const quality = typeof element.getVideoPlaybackQuality === "function" ? element.getVideoPlaybackQuality() : null
					const buffered: [number, number][] = []

					for (let range = 0; range < element.buffered.length; range++) {
						buffered.push([element.buffered.start(range), element.buffered.end(range)])
					}

					return {
						at,
						currentTime: element.currentTime,
						paused: element.paused,
						readyState: element.readyState,
						networkState: element.networkState,
						buffered,
						error: element.error === null ? null : { code: element.error.code, message: element.error.message },
						quality:
							quality === null
								? null
								: {
										total: quality.totalVideoFrames,
										dropped: quality.droppedVideoFrames,
										corrupted: (quality as { corruptedVideoFrames?: number }).corruptedVideoFrames ?? 0
									}
					}
				}, elapsed)
				.catch(() => null)

			if (moment !== null) {
				moments.push(moment)
			}

			await page.waitForTimeout(SAMPLE_MS)
		}

		const mse = await readMse(page)
		const buffers = mse.buffers.map(buffer => ({
			mime: buffer.mime,
			appends: buffer.appends,
			appendedBytes: buffer.appendedBytes,
			...fmp4Samples(new Uint8Array(Buffer.from(buffer.bytes, "base64")), SAMPLES)
		}))
		const last = moments.at(-1)
		const record = { browser: browserName, file: name, moments, buffers, sourceBufferEvents: mse.events, appLog: [...appLog] }

		await testInfo.attach(`bframes-${browserName}-${name}.json`, {
			body: JSON.stringify(record, null, "\t"),
			contentType: "application/json"
		})

		console.log(
			`[bframes] ${browserName} ${name}: currentTime ${String(last?.currentTime)} of buffered ${JSON.stringify(last?.buffered)}, ` +
				`readyState ${String(last?.readyState)}, quality ${JSON.stringify(last?.quality)}, error ${JSON.stringify(last?.error)}, ` +
				`SourceBuffer events ${JSON.stringify(mse.events)}`
		)

		for (const buffer of buffers) {
			console.log(
				`[bframes] ${browserName} ${name} ${buffer.mime}: timescale ${String(buffer.timescale)}, ` +
					// A sample presented before it is decoded: a negative composition offset, which some decoders mishandle.
					`presented before decoded ${String(buffer.samples.filter(sample => sample.pts < sample.dts).length)} of ${String(buffer.samples.length)}, ` +
					`dts/pts ${buffer.samples
						.slice(0, 16)
						.map(sample => `${sample.dts.toFixed(3)}/${sample.pts.toFixed(3)}${sample.key ? "k" : ""}`)
						.join(" ")}`
			)
		}

		for (const line of appLog) {
			console.log(`[bframes] ${browserName} ${name} app ${line}`)
		}

		const errored = moments.find(moment => moment.error !== null)

		if (errored !== undefined) {
			failures.push(`${name}: the element reported error ${JSON.stringify(errored.error)} at ${String(errored.at)} ms`)
		}

		if (mse.events.some(event => event.type === "error")) {
			failures.push(`${name}: a SourceBuffer fired error ${JSON.stringify(mse.events)}`)
		}

		await page.keyboard.press("Escape")
		await expect(page.getByRole("dialog")).toHaveCount(0)
	}

	expect(failures).toEqual([])
})
