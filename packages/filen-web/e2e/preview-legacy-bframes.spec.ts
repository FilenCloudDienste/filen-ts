import { test, expect } from "./fixtures"
import { bootTo, LAZY_VIEWER_TIMEOUT_MS } from "./helpers/listing"
import { FIXTURE_FILES, openFixtureRows } from "./helpers/fixtures"
import { readMse, recordMse, resetMse } from "./helpers/mseRecorder"
import { fmp4Samples } from "@/tests/support/fmp4"

// The demuxer tests' H.264 streams with B-frames (AVI, whose reorder the demuxer infers with no presentation times to
// go by, ASF and MPEG-PS) played in the preview: each must play past PLAYED_SECONDS with no error event (the element's
// or a SourceBuffer's), and every sample the remux worker appends must be decoded no later than it is presented
// (version-0 trun, no negative composition offset). What the browser reports and what it was handed is recorded per
// file either way.

const FILES = FIXTURE_FILES["preview-legacy-bframes"]
// How long each file is watched, and how often.
const WATCH_MS = 15_000
const SAMPLE_MS = 500
// Played this far, a file is through: the streams run two seconds. Read from the element's played ranges, not its
// currentTime: the preview loops, so a sampled currentTime can wrap past the mark between two samples every time
// (WebKit holds each loop's first picture a while, which locked the samples to the loop's period).
const PLAYED_SECONDS = 1.5
// Samples read back per SourceBuffer.
const SAMPLES = 40

interface Moment {
	at: number
	currentTime: number
	paused: boolean
	readyState: number
	networkState: number
	buffered: [number, number][]
	// The furthest point any played range reached.
	playedTo: number
	error: { code: number; message: string } | null
	quality: { total: number; dropped: number; corrupted: number } | null
}

test("B-frame AVI, ASF and MPEG-PS play, every picture decoded before it is presented", async ({ page, browserName }, testInfo) => {
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
			failures.push(`${name}: no listing row`)

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

					let playedTo = 0

					for (let range = 0; range < element.played.length; range++) {
						playedTo = Math.max(playedTo, element.played.end(range))
					}

					return {
						at,
						currentTime: element.currentTime,
						paused: element.paused,
						readyState: element.readyState,
						networkState: element.networkState,
						buffered,
						playedTo,
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

				if (moment.playedTo >= PLAYED_SECONDS || moment.error !== null) {
					break
				}
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
			`[bframes] ${browserName} ${name}: played to ${String(last?.playedTo)}, currentTime ${String(last?.currentTime)} of buffered ${JSON.stringify(last?.buffered)}, ` +
				`readyState ${String(last?.readyState)}, quality ${JSON.stringify(last?.quality)}, error ${JSON.stringify(last?.error)}, ` +
				`SourceBuffer events ${JSON.stringify(mse.events)}`
		)

		for (const buffer of buffers) {
			console.log(
				`[bframes] ${browserName} ${name} ${buffer.mime}: timescale ${String(buffer.timescale)}, ` +
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

		if (!moments.some(moment => moment.playedTo >= PLAYED_SECONDS)) {
			failures.push(`${name}: played to ${String(last?.playedTo)} s, not ${String(PLAYED_SECONDS)}, in ${String(WATCH_MS)} ms`)
		}

		// The first trak only is read, so an audio buffer or one whose kept bytes hold no fragment has none: one with
		// samples is what makes the check below live.
		if (!buffers.some(buffer => buffer.samples.length > 0)) {
			failures.push(`${name}: no SourceBuffer with samples was recorded`)
		}

		for (const buffer of buffers) {
			const early = buffer.samples.filter(sample => sample.pts < sample.dts || sample.trunVersion !== 0)

			if (early.length > 0) {
				failures.push(`${name} ${buffer.mime}: ${String(early.length)} samples presented before decoded or in a version-1 trun`)
			}
		}

		if (mse.events.some(event => event.type === "error")) {
			failures.push(`${name}: a SourceBuffer fired error ${JSON.stringify(mse.events)}`)
		}

		await page.keyboard.press("Escape")
		await expect(page.getByRole("dialog")).toHaveCount(0)
	}

	expect(failures).toEqual([])
})
