import { describe, expect, it, vi } from "vitest"
import type * as reader from "../core/rtf/reader"
import type * as digest from "../core/rtf/write/digest"
import { RtfWriteRefusal } from "../core/rtf/write/out"
import { editRtf, latin1, paragraphs, saveRtf } from "./rtfWriteFixtures"

// While `corrupt` is set, a save reads back the edited text as other text: the span's proof finds no span (the whole
// file's reading decides), and every second call of blockDigestsExcept (the writer digests what the edit made, then
// what the written file reads back as) has the edited words replaced.
const state = { corrupt: false, calls: 0 }

vi.mock("../core/rtf/reader", async original => {
	const actual = await original<typeof reader>()

	return {
		...actual,
		readSpan: vi.fn((...args: Parameters<typeof actual.readSpan>) => (state.corrupt ? undefined : actual.readSpan(...args)))
	}
})

vi.mock("../core/rtf/write/digest", async original => {
	const actual = await original<typeof digest>()

	return {
		...actual,
		blockDigestsExcept: vi.fn((...args: Parameters<typeof actual.blockDigestsExcept>) => {
			const digests = actual.blockDigestsExcept(...args)

			if (!state.corrupt || state.calls++ % 2 === 0) return digests

			return digests.map(entry => entry?.replace("Secret First", "Leaked First"))
		})
	}
})

const DOC = latin1(
	"{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\froman Times New Roman;}}" +
		"\\pard\\plain\\f0\\fs24 First paragraph here\\par\n" +
		"\\pard\\plain\\f0\\fs24 Second paragraph here\\par\n}"
)

describe("RTF writer read-back refusal", () => {
	it("names where a block reads back differently, never its text, and keeps the difference on the detail", async () => {
		const editing = await editRtf(DOC)
		const session = editing.session
		const first = paragraphs(session.state.doc)[0]

		if (first === undefined) throw new Error("no paragraph")

		expect(session.dispatch(session.state.tr.insertText("Secret ", first.pos + 1))).toBe(true)

		state.corrupt = true
		state.calls = 0

		const refusal = await saveRtf(editing).then(
			() => undefined,
			(error: unknown) => error
		)

		state.corrupt = false

		expect(refusal).toBeInstanceOf(RtfWriteRefusal)

		if (!(refusal instanceof RtfWriteRefusal)) return

		expect(refusal.reason).toBe("proof")
		expect(refusal.message).toMatch(/block 0 reads back differently at offset \d+, \d+ characters written, \d+ expected$/u)
		expect(refusal.message).not.toMatch(/Secret|Leaked|First|paragraph here/u)
		// The detail carries both sides but is not enumerable: a spread or a structured log does not copy it.
		expect(refusal.detail).toContain("Leaked First paragraph here")
		expect(refusal.detail).toContain("Secret First paragraph here")
		expect(Object.keys(refusal)).not.toContain("detail")
		expect(JSON.stringify({ ...refusal })).not.toContain("First")
	})
})
