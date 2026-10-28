import { describe, expect, it } from "vitest"
import type { Transition } from "../core/anim/model"
import type { FileLike } from "../core/presentation/edit/ops"
import { mediaCapability } from "../dom/presentation/engine/media"
import { editHarness } from "./presentationEditFixtures"
import { body, buildPptx, para, sp } from "./pptxFixtures"

// A transition sound is a WAV by its bytes (PowerPoint plays only WAV transition sounds): a file that declares
// audio/wav but holds an MP3 is refused, a RIFF/WAVE file is taken.

function file(bytes: Uint8Array, name: string, type: string): FileLike {
	return {
		size: bytes.length,
		name,
		type,
		slice: (start = 0, end = bytes.length) => ({ arrayBuffer: () => Promise.resolve(bytes.slice(start, end).buffer) })
	}
}

function wav(): Uint8Array {
	const bytes = new Uint8Array(4044)
	const put = (at: number, value: string): void => {
		for (let k = 0; k < value.length; k++) bytes[at + k] = value.charCodeAt(k)
	}

	put(0, "RIFF")
	put(8, "WAVEfmt ")
	put(36, "data")

	return bytes
}

// An MPEG audio frame header after an ID3v2 tag.
function mp3(): Uint8Array {
	const bytes = new Uint8Array(4096)

	bytes.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 0)
	bytes.set([0xff, 0xfb, 0x90, 0x64], 10)

	return bytes
}

const FADE: Transition = { kind: "fade", namespace: "p", options: {}, durationMs: 700, advance: { onClick: true } }

describe("transition sounds by their bytes", () => {
	for (const sample of [
		{ name: "a WAV", bytes: wav(), ok: true },
		{ name: "an MP3 named .wav", bytes: mp3(), ok: false }
	])
		it(`${sample.ok ? "takes" : "refuses"} ${sample.name} declared audio/wav`, async () => {
			const h = await editHarness(buildPptx({ slides: [{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("Sound"))) }] }))
			const registered = await mediaCapability.registerMedia(
				{ ...h.context, lane: "background" as const },
				{ kind: "file", file: file(sample.bytes, "chime.wav", "audio/wav") }
			)

			if ("reason" in registered) throw new Error(registered.reason)

			const result = await h.command({
				family: "transition",
				kind: "set",
				slides: [h.session.deck.slides[0] as never],
				transition: {
					...FADE,
					sound: { kind: "embedded", part: `inserted:${String(registered.id)}`, name: "chime.wav", loop: false }
				},
				media: registered
			})

			expect(result.ok).toBe(sample.ok)
		})
})
