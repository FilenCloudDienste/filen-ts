// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"

vi.mock("@/features/preview/lib/previewStream", () => ({ isMediaStreamAvailable: () => false, previewStreamUrl: vi.fn() }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { downloadFileBytes: vi.fn(), cancelPreviewDownload: vi.fn() } }))

import { createDomAudioAdapter } from "@/features/audio/lib/bytes"
import type { AudioElementEvents } from "@/features/audio/lib/engine"
import { BlockSource, type ReadRange } from "@/lib/media/blockSource"
import { MEDIA_FORMAT_UNSUPPORTED, MEDIA_PLAYBACK_FAILED } from "@/lib/media/mediaFailure"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"

const MEDIA_ERR_SRC_NOT_SUPPORTED = 4

// The adapter's own <audio>, with the media behaviour jsdom lacks stubbed: `load` is inert, `play`
// rejects as a browser does for a source it cannot play, and `error` is settable.
function makeAdapter(): {
	element: HTMLAudioElement
	failures: (() => Promise<ErrorDTO | null>)[]
	adapter: ReturnType<typeof createDomAudioAdapter>
	setError: (code: number | null) => void
} {
	let error: MediaError | null = null
	const failures: (() => Promise<ErrorDTO | null>)[] = []

	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined)
	vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
		Promise.reject(new DOMException("no supported source", "NotSupportedError"))
	)

	const listen = vi.spyOn(HTMLMediaElement.prototype, "addEventListener")

	const events: AudioElementEvents = {
		onTimeUpdate: () => undefined,
		onDurationChange: () => undefined,
		onEnded: () => undefined,
		onError: failure => {
			failures.push(failure)
		}
	}
	const adapter = createDomAudioAdapter(events)
	const element = listen.mock.contexts[0]

	if (!(element instanceof HTMLAudioElement)) {
		throw new Error("adapter created no element")
	}

	// jsdom has no `error` on its media elements.
	Object.defineProperty(element, "error", { configurable: true, get: () => error })

	return {
		element,
		failures,
		adapter,
		setError: code => {
			error = code === null ? null : ({ code } as MediaError)
		}
	}
}

function readableBytes(): { source: BlockSource; read: ReturnType<typeof vi.fn<ReadRange>> } {
	const read = vi.fn<ReadRange>((start, end) => Promise.resolve(new Uint8Array(end - start)))

	return { source: new BlockSource(64, read), read }
}

describe("DOM audio adapter — failures", () => {
	it("classifies one failure once, shared by the error event and the play() it rejects", async () => {
		const { element, failures, adapter, setError } = makeAdapter()
		const { source, read } = readableBytes()

		adapter.load("/sw/download/a", source)
		setError(MEDIA_ERR_SRC_NOT_SUPPORTED)
		element.dispatchEvent(new Event("error"))

		const fromPlay = await adapter.play().then(
			() => null,
			(error: unknown) => asErrorDTO(error)
		)
		const fromEvent = await failures[0]?.()

		expect(fromEvent?.kind).toBe(MEDIA_FORMAT_UNSUPPORTED)
		expect(fromPlay).toBe(fromEvent)
		expect(read).toHaveBeenCalledOnce()
	})

	it("reports nothing for a failure of a source the element has since replaced", async () => {
		const { element, failures, adapter, setError } = makeAdapter()

		adapter.load("/sw/download/a", readableBytes().source)
		setError(MEDIA_ERR_SRC_NOT_SUPPORTED)
		element.dispatchEvent(new Event("error"))
		setError(null)

		expect(await failures[0]?.()).toBeNull()
	})

	it("rejects a play() refused for any other reason as a playback failure", async () => {
		const { adapter } = makeAdapter()

		adapter.load("/sw/download/a", readableBytes().source)

		const error = await adapter.play().then(
			() => null,
			(rejection: unknown) => asErrorDTO(rejection)
		)

		expect(error?.kind).toBe(MEDIA_PLAYBACK_FAILED)
	})
})
