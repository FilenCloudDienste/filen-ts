import { CfbError, CfbFile, cfbBytes, type CfbEntry, type CfbWriteEntry } from "../cfb/index"
import { decodeCodepage } from "../rtf/codepage"
import { bytesSource } from "../opc/io"
import { decodeUtf8, isUtf8 } from "../xml/utf8"
import { MsgError } from "./errors"
import { decompressRtf } from "./lzfu"
import { rtfBody } from "./rtfBody"

// [MS-OXMSG] Outlook message files: a compound file whose storages hold the message's properties (§2.4: fixed
// values in a property stream, the rest in a stream each), its recipients (§2.2.1) and attachments (§2.2.2), an
// embedded message (§2.2.2.1) being a message's storages one level down. Read for the viewer: display strings,
// bodies, and attachments as bytes; an embedded message becomes a .msg file of its own, which the viewer opens as
// a message, so no message is parsed inside another.
//
// Hostile-input bounds: the compound file reader checks every sector chain (FAT and DIFAT cycles, chains running
// into each other, the mini stream) and caps the directory at MAX_ENTRIES; the file is at most `maxSize`, so no
// stream is larger. A property stream is read up to MAX_PROPERTY_BYTES, a display string up to MAX_SHORT_BYTES;
// attachments past MAX_ATTACHMENTS and storages nested past MAX_STORAGE_DEPTH make the reading "tooLarge";
// recipients past MAX_RECIPIENTS are counted, not read. The RTF body decompresses to at most `maxSize` bytes.

export const MSG_DEFAULT_MAX_SIZE = 67_108_864
const MAX_ENTRIES = 65_536
const MAX_PROPERTY_BYTES = 1_048_576
const MAX_SHORT_BYTES = 4096
const MAX_ATTACHMENTS = 1000
const MAX_RECIPIENTS = 200
const MAX_STORAGE_DEPTH = 64

const PROPERTIES = "__properties_version1.0"
const RECIPIENT = "__recip_version1.0_#"
const ATTACHMENT = "__attach_version1.0_#"
// Property stream headers (§2.4.1): the message's, an embedded message's, a recipient's or attachment's.
const TOP_HEADER = 32
const EMBEDDED_HEADER = 24
const ITEM_HEADER = 8

const PT_INT32 = 0x0003
const PT_SYSTIME = 0x0040
const PT_STRING8 = 0x001e
const PT_UNICODE = 0x001f
const PT_BINARY = 0x0102
const PT_OBJECT = 0x000d

const SUBJECT = 0x0037
const CLIENT_SUBMIT_TIME = 0x0039
const DELIVERY_TIME = 0x0e06
const CREATION_TIME = 0x3007
const SENDER_NAME = 0x0c1a
const SENDER_ADDRESS = 0x0c1f
const SENDER_SMTP = 0x5d01
const SENT_REPRESENTING_NAME = 0x0042
const SENT_REPRESENTING_ADDRESS = 0x0065
const BODY = 0x1000
const RTF_COMPRESSED = 0x1009
const HTML = 0x1013
const INTERNET_CODEPAGE = 0x3fde
const MESSAGE_CODEPAGE = 0x3ffd
const RECIPIENT_TYPE = 0x0c15
const DISPLAY_NAME = 0x3001
const EMAIL_ADDRESS = 0x3003
const SMTP_ADDRESS = 0x39fe
const ATTACH_DATA = 0x3701
const ATTACH_FILENAME = 0x3704
const ATTACH_METHOD = 0x3705
const ATTACH_LONG_FILENAME = 0x3707
const ATTACH_MIME = 0x370e
const ATTACH_CONTENT_ID = 0x3712

const METHOD_BY_VALUE = 1
const METHOD_EMBEDDED = 5
const RECIPIENT_TO = 1
const RECIPIENT_CC = 2

export interface MsgAddress {
	readonly name: string | null
	readonly address: string | null
}

export interface MsgAttachment {
	// The long file name, the short one or the display name; null for none.
	readonly name: string | null
	readonly mimeType: string | null
	readonly contentId: string | null
	// An embedded message, as a .msg file of its own.
	readonly message: boolean
	// Null when the reading was asked for names only (`parts: false`).
	readonly bytes: Uint8Array | null
}

export interface MsgMessage {
	readonly subject: string | null
	readonly from: MsgAddress | null
	readonly to: readonly MsgAddress[]
	readonly cc: readonly MsgAddress[]
	// Recipients past MAX_RECIPIENTS, counted.
	readonly recipientsOmitted: number
	// ISO 8601; null for none.
	readonly date: string | null
	readonly html: string | null
	readonly text: string | null
	readonly attachments: readonly MsgAttachment[]
}

export type MsgReading = { readonly status: "ok"; readonly message: MsgMessage } | { readonly status: "tooLarge" }

function hex(value: number, digits: number): string {
	return value.toString(16).toUpperCase().padStart(digits, "0")
}

function streamName(id: number, type: number): string {
	return `__substg1.0_${hex(id, 4)}${hex(type, 4)}`
}

function utf16(bytes: Uint8Array): string {
	let out = ""
	const units = bytes.length >> 1

	for (let k = 0; k < units; k += 4096) {
		const end = Math.min(units, k + 4096)
		const chunk = new Uint16Array(end - k)

		for (let j = k; j < end; j++) chunk[j - k] = (bytes[j * 2] as number) | ((bytes[j * 2 + 1] as number) << 8)

		out += String.fromCharCode(...chunk)
	}

	return out
}

function withoutNul(text: string): string {
	const end = text.indexOf("\0")

	return end === -1 ? text : text.slice(0, end)
}

// A storage's fixed-size property values (§2.4.2.1), by property id.
class Properties {
	private readonly data: DataView
	private readonly values = new Map<number, { readonly type: number; readonly at: number }>()

	constructor(bytes: Uint8Array, header: number) {
		this.data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

		for (let at = header; at + 16 <= bytes.length; at += 16) {
			const tag = this.data.getUint32(at, true)

			this.values.set(tag >>> 16, { type: tag & 0xffff, at: at + 8 })
		}
	}

	int32(id: number): number | null {
		const value = this.values.get(id)

		return value?.type === PT_INT32 ? this.data.getInt32(value.at, true) : null
	}

	// A FILETIME as ISO 8601.
	time(id: number): string | null {
		const value = this.values.get(id)

		if (value?.type !== PT_SYSTIME) return null

		const ticks = this.data.getUint32(value.at + 4, true) * 0x1_0000_0000 + this.data.getUint32(value.at, true)
		const date = new Date(ticks / 10_000 - 11_644_473_600_000)

		return ticks === 0 || Number.isNaN(date.getTime()) ? null : date.toISOString()
	}
}

class Reader {
	private readonly cfb: CfbFile
	private readonly maxSize: number
	// Bytes the embedded messages' own files take, together.
	private produced = 0

	private readonly parts: boolean

	constructor(cfb: CfbFile, maxSize: number, parts: boolean) {
		this.cfb = cfb
		this.maxSize = maxSize
		this.parts = parts
	}

	private child(path: readonly string[], name: string): CfbEntry | undefined {
		return this.cfb.entry([...path, name])
	}

	private async bytes(entry: CfbEntry, limit = Infinity): Promise<Uint8Array> {
		return entry.size <= limit ? this.cfb.read(entry) : this.cfb.stream(entry).read(0, limit - (limit % 2))
	}

	private async properties(path: readonly string[], header: number): Promise<Properties> {
		const entry = this.child(path, PROPERTIES)

		return new Properties(entry?.kind === "stream" ? await this.bytes(entry, MAX_PROPERTY_BYTES) : new Uint8Array(0), header)
	}

	// A string property, Unicode or 8-bit (in `codepage`); at most `limit` bytes of it.
	private async string(path: readonly string[], id: number, codepage: number, limit = Infinity): Promise<string | null> {
		const unicode = this.child(path, streamName(id, PT_UNICODE))

		if (unicode?.kind === "stream") return withoutNul(utf16(await this.bytes(unicode, limit)))

		const narrow = this.child(path, streamName(id, PT_STRING8))

		if (narrow?.kind !== "stream") return null

		const bytes = await this.bytes(narrow, limit)

		return withoutNul(decodeCodepage(bytes, 0, bytes.length, codepage))
	}

	private short(path: readonly string[], id: number, codepage: number): Promise<string | null> {
		return this.string(path, id, codepage, MAX_SHORT_BYTES)
	}

	private binary(path: readonly string[], id: number): Promise<Uint8Array | null> {
		const entry = this.child(path, streamName(id, PT_BINARY))

		return entry?.kind === "stream" ? this.bytes(entry) : Promise.resolve(null)
	}

	// Children of the storage at `path` named `prefix` + a hex index, in index order.
	private items(path: readonly string[], prefix: string): CfbEntry[] {
		const storage = this.cfb.entry(path)

		return (storage?.children ?? [])
			.filter(entry => entry.kind === "storage" && entry.name.toLowerCase().startsWith(prefix.toLowerCase()))
			.sort((a, b) => Number.parseInt(a.name.slice(prefix.length), 16) - Number.parseInt(b.name.slice(prefix.length), 16))
	}

	async message(path: readonly string[], header: number): Promise<MsgMessage> {
		const properties = await this.properties(path, header)
		const codepage = properties.int32(MESSAGE_CODEPAGE) ?? properties.int32(INTERNET_CODEPAGE) ?? 1252
		const recipients = this.items(path, RECIPIENT)
		const attachments = this.items(path, ATTACHMENT)

		if (attachments.length > MAX_ATTACHMENTS) throw new MsgError("tooLarge", "The message has more attachments than the limit")

		const to: MsgAddress[] = []
		const cc: MsgAddress[] = []

		for (const recipient of recipients.slice(0, MAX_RECIPIENTS)) {
			const at = [...path, recipient.name]
			const own = await this.properties(at, ITEM_HEADER)
			const type = own.int32(RECIPIENT_TYPE) ?? RECIPIENT_TO
			const address = {
				name: await this.short(at, DISPLAY_NAME, codepage),
				address: (await this.short(at, SMTP_ADDRESS, codepage)) ?? (await this.short(at, EMAIL_ADDRESS, codepage))
			}

			if (type === RECIPIENT_TO) to.push(address)
			else if (type === RECIPIENT_CC) cc.push(address)
		}

		const fromName = (await this.short(path, SENDER_NAME, codepage)) ?? (await this.short(path, SENT_REPRESENTING_NAME, codepage))
		const fromAddress =
			(await this.short(path, SENDER_SMTP, codepage)) ??
			(await this.short(path, SENDER_ADDRESS, codepage)) ??
			(await this.short(path, SENT_REPRESENTING_ADDRESS, codepage))

		return {
			subject: await this.short(path, SUBJECT, codepage),
			from: fromName === null && fromAddress === null ? null : { name: fromName, address: fromAddress },
			to,
			cc,
			recipientsOmitted: Math.max(0, recipients.length - MAX_RECIPIENTS),
			date: properties.time(CLIENT_SUBMIT_TIME) ?? properties.time(DELIVERY_TIME) ?? properties.time(CREATION_TIME),
			...(await this.bodies(path, properties, codepage)),
			attachments: await this.attachments(path, attachments, codepage)
		}
	}

	private async bodies(
		path: readonly string[],
		properties: Properties,
		codepage: number
	): Promise<{ readonly html: string | null; readonly text: string | null }> {
		const htmlBytes = await this.binary(path, HTML)
		let html =
			htmlBytes === null
				? await this.string(path, HTML, codepage)
				: decodeHtml(htmlBytes, properties.int32(INTERNET_CODEPAGE) ?? properties.int32(MESSAGE_CODEPAGE))
		let text = await this.string(path, BODY, codepage)

		// The RTF body only where it can give HTML: a text body alone does not need it.
		if (html === null) {
			const compressed = await this.binary(path, RTF_COMPRESSED)

			if (compressed !== null) {
				const body = rtfBody(decompressRtf(compressed, this.maxSize))

				html ??= body.html
				text ??= body.text
			}
		}

		return { html, text }
	}

	private async attachments(path: readonly string[], storages: readonly CfbEntry[], codepage: number): Promise<MsgAttachment[]> {
		const out: MsgAttachment[] = []

		for (const storage of storages) {
			const at = [...path, storage.name]
			const properties = await this.properties(at, ITEM_HEADER)
			const method = properties.int32(ATTACH_METHOD) ?? METHOD_BY_VALUE
			const data = this.child(at, streamName(ATTACH_DATA, method === METHOD_EMBEDDED ? PT_OBJECT : PT_BINARY))

			// By reference, OLE and other methods carry nothing this can show.
			if (data?.kind !== (method === METHOD_EMBEDDED ? "storage" : "stream")) continue

			// Names only: no part is read, no embedded message made a file.
			const bytes = !this.parts
				? null
				: method === METHOD_EMBEDDED
					? await this.standalone([...at, data.name])
					: await this.cfb.read(data)

			if (this.parts && bytes === null) continue

			const name =
				(await this.short(at, ATTACH_LONG_FILENAME, codepage)) ??
				(await this.short(at, ATTACH_FILENAME, codepage)) ??
				(await this.short(at, DISPLAY_NAME, codepage))
			const contentId = await this.short(at, ATTACH_CONTENT_ID, codepage)

			out.push({
				name: method === METHOD_EMBEDDED ? withExtension(name, ".msg") : name,
				mimeType: method === METHOD_EMBEDDED ? "application/vnd.ms-outlook" : await this.short(at, ATTACH_MIME, codepage),
				contentId,
				message: method === METHOD_EMBEDDED,
				bytes
			})
		}

		return out
	}

	// The embedded message at `path` as a message file: its storages and streams at the root, its property stream given
	// the top-level header (§2.4.1.1). The file's named-property mapping is not copied: nothing here reads named
	// properties, and a copy per embedded message would multiply one large mapping by their count. Every byte these
	// files take counts against `maxSize`.
	// Null when its names cannot be written (a name a compound file reader accepts and its writer refuses).
	private async standalone(path: readonly string[]): Promise<Uint8Array | null> {
		const entries: CfbWriteEntry[] = []
		const add = async (entry: CfbEntry, under: readonly string[]): Promise<void> => {
			const stack: { readonly entry: CfbEntry; readonly path: readonly string[] }[] = entry.children.map(child => ({
				entry: child,
				path: [...under, child.name]
			}))

			for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
				if (next.path.length > MAX_STORAGE_DEPTH) throw new MsgError("tooLarge", "Storages nest deeper than the limit")

				if (next.entry.kind === "stream") {
					const bytes = await this.cfb.read(next.entry)

					entries.push({
						path: next.path,
						bytes: next.path.length === 1 && next.entry.name === PROPERTIES ? topHeader(bytes) : bytes
					})
				} else {
					entries.push({ path: next.path, storage: true })

					for (const child of next.entry.children) stack.push({ entry: child, path: [...next.path, child.name] })
				}
			}
		}
		const embedded = this.cfb.entry(path)

		if (embedded === undefined) throw new MsgError("corrupt", "The embedded message is missing")

		await add(embedded, [])

		let bytes: Uint8Array

		try {
			bytes = await cfbBytes(entries)
		} catch (e) {
			if (e instanceof CfbError) return null

			throw e
		}

		this.produced += bytes.length

		if (this.produced > this.maxSize) throw new MsgError("tooLarge", "The embedded messages are larger than the limit")

		return bytes
	}
}

function topHeader(bytes: Uint8Array): Uint8Array {
	if (bytes.length < EMBEDDED_HEADER) return bytes

	const out = new Uint8Array(bytes.length + TOP_HEADER - EMBEDDED_HEADER)

	out.set(bytes.subarray(0, EMBEDDED_HEADER))
	out.set(bytes.subarray(EMBEDDED_HEADER), TOP_HEADER)

	return out
}

function withExtension(name: string | null, extension: string): string | null {
	if (name === null) return null

	return name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`
}

// PidTagHtml bytes in the message's Internet code page; without one, UTF-8 when they are, else Windows-1252.
function decodeHtml(bytes: Uint8Array, codepage: number | null): string {
	if (codepage !== null) return decodeCodepage(bytes, 0, bytes.length, codepage)

	return isUtf8(bytes) ? decodeUtf8(bytes) : decodeCodepage(bytes, 0, bytes.length, 1252)
}

// `parts: false` reads attachments' names and types only (their bytes null), for a reader that needs no more.
export async function readMsg(
	bytes: Uint8Array,
	options: { readonly maxSize?: number; readonly parts?: boolean } = {}
): Promise<MsgReading> {
	const maxSize = options.maxSize ?? MSG_DEFAULT_MAX_SIZE

	if (bytes.length > maxSize) return { status: "tooLarge" }

	try {
		const cfb = await CfbFile.open(bytesSource(bytes), { limits: { maxSize, maxEntries: MAX_ENTRIES } })

		return { status: "ok", message: await new Reader(cfb, maxSize, options.parts ?? true).message([], TOP_HEADER) }
	} catch (e) {
		if (
			(e instanceof MsgError && e.code === "tooLarge") ||
			(e instanceof CfbError && (e.code === "tooLarge" || e.code === "tooManyEntries"))
		) {
			return { status: "tooLarge" }
		}

		throw e
	}
}
