import { strFromU8 } from "fflate"
import { TextSelection } from "prosemirror-state"
import { describe, expect, it, vi } from "vitest"
import * as picture from "../core/rtf/write/picture"
import { writeRtf } from "../core/rtf/write/writer"
import { PNG, editRtf, editsOf, latin1, paragraphs } from "./rtfWriteFixtures"

// Every call of writeNewPicture counted; what it writes is the module's own.
vi.mock("../core/rtf/write/picture", async original => {
	const actual = await original<typeof picture>()

	return { ...actual, writeNewPicture: vi.fn(actual.writeNewPicture) }
})

const DOC = latin1(
	"{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\froman Times New Roman;}}{\\colortbl;\\red255\\green0\\blue0;}" +
		"\\pard\\plain\\f0\\fs24 First paragraph here\\par\n" +
		"\\pard\\plain\\f0\\fs24 Second paragraph here\\par\n}"
)

// The bytes in hex as Word writes them: CR LF before each line of 64 bytes.
function wordHex(bytes: Uint8Array): string {
	let out = ""

	for (let from = 0; from < bytes.length; from += 64) {
		out += "\r\n"

		for (const byte of bytes.subarray(from, from + 64)) out += byte.toString(16).padStart(2, "0")
	}

	return out
}

describe("RTF writer, a picture the edit inserted", () => {
	it("writes it in hex lines once a save, though a colour the edit added writes the file twice", async () => {
		const editing = await editRtf(DOC)
		const session = editing.session
		const [first, second] = paragraphs(session.state.doc)

		if (first === undefined || second === undefined) throw new Error("no paragraphs")

		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, first.pos + 1, first.pos + 6)))
		expect(session.execute({ type: "color.text", color: { kind: "rgb", value: "00B050" } })).toBe(true)

		const media = session.context.media.add(PNG)

		if (media === undefined) throw new Error("no media")

		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, second.pos + 1)))
		expect(await editing.editor.execute({ type: "image.insert", media, altText: "Dots" })).toBe(true)

		const edits = await editsOf(editing)
		const image = [...edits.parts].find(([name]) => name.startsWith("word/media/"))?.[1]

		expect(image).toEqual(PNG)
		vi.mocked(picture.writeNewPicture).mockClear()

		const written = await writeRtf(editing.source, edits)
		const out = strFromU8(written.bytes, true)

		expect(picture.writeNewPicture).toHaveBeenCalledTimes(1)
		expect(written.path).toBe("whole")
		expect(out).toContain("{\\colortbl;\\red255\\green0\\blue0;\\red0\\green176\\blue80;}")
		expect(out).toContain("\\pngblip\\picw2\\pich2")
		expect(out).toContain(`${wordHex(PNG)}}}{\\nonshppict{\\pict\\wmetafile8`)

		const metafile = /\\wmetafile8\\picw\d+\\pich\d+\\picwgoal\d+\\pichgoal\d+((?:\r\n[0-9a-f]+)+)\}\}/u.exec(out)?.[1] ?? ""
		const lines = metafile.split("\r\n").slice(1)

		expect(lines.length).toBeGreaterThan(1)
		expect(lines.slice(0, -1).every(line => line.length === 128)).toBe(true)
		expect(lines.at(-1)?.length).toBeLessThanOrEqual(128)
	})
})
