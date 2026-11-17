import { describe, expect, it } from "vitest"
import { cfbBytes, type CfbWriteEntry } from "@filen/office/core/cfb"
import { decompressRtf, readMsg, rtfBody, MsgError, type MsgReading } from "@filen/office/core/msg"
import {
	PT_INT32,
	attachmentStorage,
	messageEntries,
	msgBytes,
	recipientEntries,
	storageEntries,
	uncompressedRtf,
	type MsgSpec
} from "@filen/office/testing/msg"

function ascii(text: string): Uint8Array {
	return Uint8Array.from(text, char => char.charCodeAt(0))
}

// [MS-OXRTFCP] §3.1.1.1, the simple example.
const SPEC_COMPRESSED = Uint8Array.from([
	0x2d, 0x00, 0x00, 0x00, 0x2b, 0x00, 0x00, 0x00, 0x4c, 0x5a, 0x46, 0x75, 0xf1, 0xc5, 0xc7, 0xa7, 0x03, 0x00, 0x0a, 0x00, 0x72, 0x63,
	0x70, 0x67, 0x31, 0x32, 0x35, 0x42, 0x32, 0x0a, 0xf3, 0x20, 0x68, 0x65, 0x6c, 0x09, 0x00, 0x20, 0x62, 0x77, 0x05, 0xb0, 0x6c, 0x64,
	0x7d, 0x0a, 0x80, 0x0f, 0xa0
])

function lzfuHeader(rawSize: number, payload: readonly number[]): Uint8Array {
	const out = new Uint8Array(16 + payload.length)
	const data = new DataView(out.buffer)

	data.setUint32(0, payload.length + 12, true)
	data.setUint32(4, rawSize, true)
	data.setUint32(8, 0x75465a4c, true)
	out.set(payload, 16)

	return out
}

function ok(reading: MsgReading) {
	if (reading.status !== "ok") throw new Error("expected a message")

	return reading.message
}

describe("decompressRtf", () => {
	it("decompresses the specification's example", () => {
		expect(new TextDecoder().decode(decompressRtf(SPEC_COMPRESSED, 1 << 20))).toBe("{\\rtf1\\ansi\\ansicpg1252\\pard hello world}\r\n")
	})

	it("copies an uncompressed body", () => {
		expect(new TextDecoder().decode(decompressRtf(uncompressedRtf("{\\rtf1 x}"), 1 << 20))).toBe("{\\rtf1 x}")
	})

	it("refuses a raw size past the limit", () => {
		expect(() => decompressRtf(SPEC_COMPRESSED, 16)).toThrow(MsgError)
	})

	it("sizes its output by what the input can expand to, not by the header", () => {
		// One control byte with every bit set and one reference (offset 0, 17 bytes): the header claims 60 MiB.
		const out = decompressRtf(lzfuHeader(60 * 1024 * 1024, [0x01, 0x00, 0x0f]), 64 * 1024 * 1024)

		expect(out.length).toBe(17)
		expect(new TextDecoder().decode(out)).toBe("{\\rtf1\\ansi\\mac\\d")
	})

	it("stops at a reference to the write position", () => {
		// "a", then a reference to offset 208 (the write position after one literal).
		expect(new TextDecoder().decode(decompressRtf(lzfuHeader(100, [0x02, 0x61, 0x0d, 0x00, 0x62]), 1 << 20))).toBe("a")
	})
})

describe("rtfBody", () => {
	it("de-encapsulates HTML, dropping \\htmlrtf parts and \\mhtmltag groups", () => {
		const rtf =
			"{\\rtf1\\ansi\\ansicpg1252\\fromhtml1 \\deff0{\\fonttbl{\\f0\\fswiss Arial;}}{\\*\\htmltag19 <html>}{\\*\\htmltag50 <body>}" +
			"\\htmlrtf {\\b RTF only}\\htmlrtf0 Hi \\'e9t\\'e9{\\*\\htmltag84 <br>}{\\*\\mhtmltag84 <x>}{\\*\\htmltag58 </body></html>}}"

		expect(rtfBody(ascii(rtf))).toEqual({ html: "<html><body>Hi été<br></body></html>", text: null })
	})

	it("reads the text of a plain RTF body", () => {
		const rtf =
			"{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}{\\colortbl;\\red0\\green0\\blue0;}{\\*\\generator x;}\\pard Hello\\par World\\tab a\\u8364?b}"

		expect(rtfBody(ascii(rtf))).toEqual({ html: null, text: "Hello\nWorld\ta€b" })
	})

	it("decodes in the font's code page", () => {
		expect(rtfBody(ascii("{\\rtf1\\ansi\\deff0{\\fonttbl{\\f1\\fcharset204 X;}}\\f1\\'cf\\'f0}")).text).toBe("Пр")
	})

	it("decodes a long run of escaped bytes and of one-character pieces whole", () => {
		const count = 100_000

		expect(rtfBody(ascii(`{\\rtf1 ${"\\'41".repeat(count)}}`)).text).toBe("A".repeat(count))
		expect(rtfBody(ascii(`{\\rtf1 ${"b\\tab ".repeat(count)}}`)).text).toBe("b\t".repeat(count))
	})

	it("skips groups nested past the depth limit in one pass", () => {
		const depth = 200_000
		const rtf = `{\\rtf1 a${"{".repeat(depth)}deep${"}".repeat(depth)} b}`

		expect(rtfBody(ascii(rtf)).text).toBe("a b")
	})
})

describe("readMsg", () => {
	const SPEC: MsgSpec = {
		subject: "Quarterly numbers",
		sender: ["Anna Berg", "anna@example.com"],
		to: [["Bob", "bob@example.com"]],
		cc: [["Cy", "cy@example.com"]],
		date: "2026-11-16T10:00:00.000Z",
		html: '<p>Hi <img src="cid:pic@x"></p>',
		text: "Hello",
		attachments: [
			{ name: "pic.png", mimeType: "image/png", contentId: "pic@x", hidden: true, bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) },
			{ name: "report.pdf", bytes: ascii("%PDF-1.7") },
			{ name: "Forwarded one", message: { subject: "Forwarded one", text: "Inner text" } }
		]
	}

	it("reads headers, bodies, recipients and attachments", async () => {
		const message = ok(await readMsg(await msgBytes(SPEC)))

		expect(message).toMatchObject({
			subject: "Quarterly numbers",
			from: { name: "Anna Berg", address: "anna@example.com" },
			to: [{ name: "Bob", address: "bob@example.com" }],
			cc: [{ name: "Cy", address: "cy@example.com" }],
			recipientsOmitted: 0,
			date: "2026-11-16T10:00:00.000Z",
			html: '<p>Hi <img src="cid:pic@x"></p>',
			text: "Hello"
		})
		expect(message.attachments.map(({ name, mimeType, contentId, message }) => [name, mimeType, contentId, message])).toEqual([
			["pic.png", "image/png", "pic@x", false],
			["report.pdf", null, null, false],
			["Forwarded one.msg", "application/vnd.ms-outlook", null, true]
		])
	})

	it("makes an embedded message a message file of its own", async () => {
		const forwarded = ok(await readMsg(await msgBytes(SPEC))).attachments[2]

		expect(forwarded?.message).toBe(true)

		const inner = ok(await readMsg(forwarded?.bytes ?? new Uint8Array(0)))

		expect(inner).toMatchObject({ subject: "Forwarded one", text: "Inner text", attachments: [] })
	})

	// A large named-property mapping beside many embedded messages: copied into each once, it multiplied by their count.
	it.each([300, 1000])("never copies the named-property mapping into %i embedded messages", async count => {
		const entries: CfbWriteEntry[] = [
			...storageEntries([], 32, []),
			{ path: ["__nameid_version1.0", "__substg1.0_00020102"], bytes: new Uint8Array(30 * 1024 * 1024) }
		]

		for (let k = 0; k < count; k++) {
			entries.push(...storageEntries([attachmentStorage(k)], 8, [[0x3705, PT_INT32, 5n]]), {
				path: [attachmentStorage(k), "__substg1.0_3701000D"],
				storage: true
			})
		}

		const file = await cfbBytes(entries)
		const started = performance.now()
		const message = ok(await readMsg(file))
		const total = message.attachments.reduce((sum, attachment) => sum + (attachment.bytes?.length ?? 0), 0)

		expect(message.attachments).toHaveLength(count)
		// A few KiB each, not the mapping's 30 MiB.
		expect(total).toBeLessThan(count * 8192)
		expect(performance.now() - started).toBeLessThan(10_000)
	})

	it("takes each address from its own property pair, and names the sending account when it is not the author", async () => {
		const spoof = ok(await readMsg(await msgBytes({ sender: [null, "evil@x.io"], representing: ["CEO", null] })))

		expect(spoof).toMatchObject({ from: { name: "CEO", address: null }, sender: { name: null, address: "evil@x.io" } })

		const assistant = ok(
			await readMsg(await msgBytes({ sender: ["Assistant", "pa@x.io"], representing: ["Boss", "boss@x.io"], replyToNames: "Desk" }))
		)

		expect(assistant).toMatchObject({
			from: { name: "Boss", address: "boss@x.io" },
			sender: { name: "Assistant", address: "pa@x.io" },
			replyToNames: "Desk"
		})
		expect(ok(await readMsg(await msgBytes({ sender: ["Anna", "a@x.io"], representing: ["Anna", "A@x.io"] }))).sender).toBeNull()
		expect(ok(await readMsg(await msgBytes({ transportHeaders: "Reply-To: r@x.io\r\n" }))).transportHeaders).toBe(
			"Reply-To: r@x.io\r\n"
		)
	})

	it("reads names alone when asked: no part read, no embedded message made a file", async () => {
		const message = ok(await readMsg(await msgBytes(SPEC), { parts: false }))

		expect(message.attachments.map(({ name, bytes }) => [name, bytes])).toEqual([
			["pic.png", null],
			["report.pdf", null],
			["Forwarded one.msg", null]
		])
	})

	it("counts every embedded message's file against the size limit", async () => {
		const entries: CfbWriteEntry[] = [...storageEntries([], 32, [])]

		for (let k = 0; k < 200; k++) {
			entries.push(...storageEntries([attachmentStorage(k)], 8, [[0x3705, PT_INT32, 5n]]), {
				path: [attachmentStorage(k), "__substg1.0_3701000D", "__properties_version1.0"],
				bytes: new Uint8Array(24)
			})
		}

		const file = await cfbBytes(entries)

		// The file fits; its 200 embedded messages, each a file of its own (a few KiB of structure), do not.
		expect(await readMsg(file, { maxSize: file.length + 1024 })).toEqual({ status: "tooLarge" })
	})

	it("reads an RTF-only body: its HTML when it encapsulates some, else its text", async () => {
		expect(ok(await readMsg(await msgBytes({ rtf: "{\\rtf1\\ansi\\pard Only RTF\\par}" })))).toMatchObject({
			html: null,
			text: "Only RTF\n"
		})
		expect(ok(await readMsg(await msgBytes({ rtf: "{\\rtf1\\ansi\\fromhtml1 {\\*\\htmltag <b>}x{\\*\\htmltag </b>}}" }))).html).toBe(
			"<b>x</b>"
		)
	})

	it("counts recipients past the limit without reading them", async () => {
		const many: CfbWriteEntry[] = [...storageEntries([], 32, [])]

		for (let k = 0; k < 250; k++) many.push(...recipientEntries([], k, 1, `R${String(k)}`, `r${String(k)}@x.io`))

		const message = ok(await readMsg(await cfbBytes(many)))

		expect(message.to).toHaveLength(200)
		expect(message.recipientsOmitted).toBe(50)
	})

	it("is too large past the attachment limit", async () => {
		const many: CfbWriteEntry[] = [...storageEntries([], 32, [])]

		for (let k = 0; k < 1001; k++) many.push({ path: [attachmentStorage(k)], storage: true })

		expect(await readMsg(await cfbBytes(many))).toEqual({ status: "tooLarge" })
	})

	it("leaves out an embedded message nested past the storage limit, and shows the rest", async () => {
		const deep = Array.from({ length: 70 }, (_, k) => `s${String(k)}`)
		const message = ok(
			await readMsg(
				await cfbBytes([
					...messageEntries({ subject: "Still here", text: "body", attachments: [{ name: "kept.txt", bytes: ascii("kept") }] }),
					...storageEntries([attachmentStorage(1)], 8, [[0x3705, PT_INT32, 5n]]),
					{ path: [attachmentStorage(1), "__substg1.0_3701000D", ...deep, "x"], bytes: new Uint8Array(1) }
				])
			)
		)

		expect(message).toMatchObject({ subject: "Still here", text: "body", partsSkipped: 1 })
		expect(message.attachments.map(attachment => attachment.name)).toEqual(["kept.txt"])
	})

	it("keeps a message's text when its RTF body is damaged", async () => {
		const broken = Uint8Array.from([0x10, 0, 0, 0, 0x10, 0, 0, 0, 1, 2, 3, 4, 0, 0, 0, 0])

		expect(
			ok(await readMsg(await cfbBytes(storageEntries([], 32, [], new Map([[0x1000, "plain body"]]), new Map([[0x1009, broken]])))))
		).toMatchObject({ html: null, text: "plain body", partsSkipped: 1 })
	})

	it("reads only the head of an oversized property stream", async () => {
		const message = ok(await readMsg(await cfbBytes([{ path: ["__properties_version1.0"], bytes: new Uint8Array(4 * 1024 * 1024) }])))

		expect(message.subject).toBeNull()
	})

	it("is too large past the file limit, and rejects what is not a compound file", async () => {
		expect(await readMsg(new Uint8Array(1024), { maxSize: 512 })).toEqual({ status: "tooLarge" })
		await expect(readMsg(ascii("not a message, just some text"))).rejects.toThrow()
	})
})
