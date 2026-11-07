import type { Page, TestInfo } from "@playwright/test"

// The audio engine's <audio> element is created in JS and never mounted, so no locator reaches it. This
// init script keeps a reference to every media element play() is called on, with the events it fires
// from then on, for describeMediaElements to read back once a playback assertion has failed. Recording
// is a few listeners per played element; nothing is read until a failure asks for it.
export function recordPlayedMediaElements(): void {
	const play: unknown = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "play")?.value

	if (typeof play !== "function") {
		return
	}

	const EVENTS = [
		"loadstart",
		"loadedmetadata",
		"durationchange",
		"loadeddata",
		"canplay",
		"canplaythrough",
		"play",
		"playing",
		"waiting",
		"stalled",
		"suspend",
		"pause",
		"seeking",
		"seeked",
		"ended",
		"emptied",
		"abort",
		"error"
	]
	const MAX_EVENTS = 120
	const startedAt = performance.now()
	const played: { element: HTMLMediaElement; events: string[] }[] = []

	Object.assign(window, { __e2ePlayedMedia: played })

	HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
		if (!played.some(entry => entry.element === this)) {
			const events: string[] = []

			played.push({ element: this, events })

			for (const name of EVENTS) {
				this.addEventListener(name, () => {
					if (events.length < MAX_EVENTS) {
						events.push(
							`${String(Math.round(performance.now() - startedAt))}ms ${name} t=${this.currentTime.toFixed(2)} d=${String(this.duration)} rs=${String(this.readyState)} ns=${String(this.networkState)}${this.error === null ? "" : ` err=${String(this.error.code)}`}`
						)
					}
				})
			}
		}

		return Reflect.apply(play, this, []) as Promise<void>
	}
}

// Every element recordPlayedMediaElements saw played, as text: its source, transport and network state,
// error, buffered/seekable ranges and the events it fired.
export async function describeMediaElements(page: Page): Promise<string> {
	return page
		.evaluate(() => {
			const played = (window as unknown as { __e2ePlayedMedia?: { element: HTMLMediaElement; events: string[] }[] }).__e2ePlayedMedia
			const ranges = (list: TimeRanges) =>
				Array.from({ length: list.length }, (_, i) => `${list.start(i).toFixed(2)}-${list.end(i).toFixed(2)}`).join(",") || "none"

			if (played === undefined) {
				return "(the media recorder is not installed)"
			}

			return (
				played
					.map(({ element, events }, index) =>
						[
							`#${String(index)} <${element.localName}> ${element.isConnected ? "connected" : "detached"} src=${element.currentSrc.slice(0, 120)}`,
							`  paused=${String(element.paused)} ended=${String(element.ended)} t=${String(element.currentTime)} d=${String(element.duration)} rs=${String(element.readyState)} ns=${String(element.networkState)} preload=${element.preload} muted=${String(element.muted)}`,
							`  error=${element.error === null ? "none" : `${String(element.error.code)} ${element.error.message}`}`,
							`  buffered=${ranges(element.buffered)} seekable=${ranges(element.seekable)} played=${ranges(element.played)}`,
							...events.map(line => `  ${line}`)
						].join("\n")
					)
					.join("\n") || "(no media element was played)"
			)
		})
		.catch((error: unknown) => `(the media elements could not be read: ${String(error)})`)
}

// Runs a playback assertion; when it fails, attaches what the page's played media elements and the given
// extra lines say before the failure propagates. Costs nothing while the assertion holds.
export async function explainMediaFailure(
	page: Page,
	testInfo: TestInfo,
	extra: () => string[],
	assertion: () => Promise<void>
): Promise<void> {
	try {
		await assertion()
	} catch (error) {
		await testInfo.attach("media-diagnostics", {
			body: [await describeMediaElements(page), ...extra()].join("\n"),
			contentType: "text/plain"
		})

		throw error
	}
}
