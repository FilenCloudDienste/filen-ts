import { cfbBytes, type CfbWriteEntry } from "../../core/cfb/index"
import { encodeUtf8 } from "../../core/xml/utf8"

// Outlook message files built byte for byte ([MS-OXMSG]), for the reader's tests and the apps' fixtures.

export const PT_INT32 = 0x0003
export const PT_BOOLEAN = 0x000b
export const PT_SYSTIME = 0x0040

export type FixedProperty = readonly [id: number, type: number, value: bigint]

export interface MsgAttachmentSpec {
	readonly name: string
	readonly mimeType?: string
	readonly contentId?: string
	// Hidden from the attachment list (an inline picture).
	readonly hidden?: boolean
	readonly bytes: Uint8Array
}

export interface MsgEmbeddedSpec {
	readonly name: string
	readonly message: MsgSpec
}

export interface MsgSpec {
	readonly subject?: string
	// The sending account (PidTagSender*), and the author it sent on behalf of (PidTagSentRepresenting*); a null name
	// or address leaves that property out.
	readonly sender?: readonly [name: string | null, address: string | null]
	readonly representing?: readonly [name: string | null, address: string | null]
	readonly replyToNames?: string
	readonly transportHeaders?: string
	readonly to?: readonly (readonly [name: string, address: string])[]
	readonly cc?: readonly (readonly [name: string, address: string])[]
	readonly date?: string
	readonly html?: string
	readonly text?: string
	// An RTF body, stored uncompressed (compressed RTF type "MELA").
	readonly rtf?: string
	readonly attachments?: readonly (MsgAttachmentSpec | MsgEmbeddedSpec)[]
}

export function utf16z(text: string): Uint8Array {
	const out = new Uint8Array((text.length + 1) * 2)

	for (let k = 0; k < text.length; k++) {
		out[k * 2] = text.charCodeAt(k) & 0xff
		out[k * 2 + 1] = text.charCodeAt(k) >> 8
	}

	return out
}

function hex(value: number, digits: number): string {
	return value.toString(16).toUpperCase().padStart(digits, "0")
}

export function propertyStream(header: number, fixed: readonly FixedProperty[]): Uint8Array {
	const out = new Uint8Array(header + fixed.length * 16)
	const data = new DataView(out.buffer)

	fixed.forEach(([id, type, value], k) => {
		data.setUint32(header + k * 16, ((id << 16) | type) >>> 0, true)
		data.setBigUint64(header + k * 16 + 8, value, true)
	})

	return out
}

export function filetime(iso: string): bigint {
	return (BigInt(Date.parse(iso)) + 11_644_473_600_000n) * 10_000n
}

// A storage's streams: fixed properties, Unicode strings and binary values, under `path`.
export function storageEntries(
	path: readonly string[],
	header: number,
	fixed: readonly FixedProperty[],
	strings: ReadonlyMap<number, string> = new Map(),
	binaries: ReadonlyMap<number, Uint8Array> = new Map()
): CfbWriteEntry[] {
	return [
		{ path: [...path, "__properties_version1.0"], bytes: propertyStream(header, fixed) },
		...[...strings].map(([id, text]) => ({ path: [...path, `__substg1.0_${hex(id, 4)}001F`], bytes: utf16z(text) })),
		...[...binaries].map(([id, bytes]) => ({ path: [...path, `__substg1.0_${hex(id, 4)}0102`], bytes }))
	]
}

export function recipientStorage(index: number): string {
	return `__recip_version1.0_#${hex(index, 8)}`
}

export function attachmentStorage(index: number): string {
	return `__attach_version1.0_#${hex(index, 8)}`
}

export function recipientEntries(path: readonly string[], index: number, type: number, name: string, address: string): CfbWriteEntry[] {
	return storageEntries(
		[...path, recipientStorage(index)],
		8,
		[[0x0c15, PT_INT32, BigInt(type)]],
		new Map([
			[0x3001, name],
			[0x39fe, address]
		])
	)
}

// A compressed RTF value of type "MELA" (stored as is).
export function uncompressedRtf(rtf: string): Uint8Array {
	const body = Uint8Array.from(rtf, char => char.charCodeAt(0))
	const out = new Uint8Array(16 + body.length)
	const data = new DataView(out.buffer)

	data.setUint32(0, body.length + 12, true)
	data.setUint32(4, body.length, true)
	data.setUint32(8, 0x414c454d, true)
	out.set(body, 16)

	return out
}

// A message's entries under `path`: its property stream has the top-level header (32 bytes) or an embedded one's (24).
export function messageEntries(spec: MsgSpec, path: readonly string[] = [], embedded = false): CfbWriteEntry[] {
	const strings = new Map<number, string>()
	const binaries = new Map<number, Uint8Array>()
	const fixed: FixedProperty[] = []

	if (spec.subject !== undefined) strings.set(0x0037, spec.subject)
	for (const [pair, name, address] of [
		[spec.sender, 0x0c1a, 0x5d01],
		[spec.representing, 0x0042, 0x5d02]
	] as const) {
		const [shownName, shownAddress] = pair ?? [null, null]

		if (shownName !== null) strings.set(name, shownName)
		if (shownAddress !== null) strings.set(address, shownAddress)
	}
	if (spec.replyToNames !== undefined) strings.set(0x0050, spec.replyToNames)
	if (spec.transportHeaders !== undefined) strings.set(0x007d, spec.transportHeaders)
	if (spec.text !== undefined) strings.set(0x1000, spec.text)
	if (spec.html !== undefined) {
		// Copied into this realm's Uint8Array: under jsdom, TextEncoder's arrays are another realm's.
		binaries.set(0x1013, Uint8Array.from(encodeUtf8(spec.html)))
		fixed.push([0x3fde, PT_INT32, 65001n])
	}
	if (spec.rtf !== undefined) binaries.set(0x1009, uncompressedRtf(spec.rtf))
	if (spec.date !== undefined) fixed.push([0x0039, PT_SYSTIME, filetime(spec.date)])

	const entries = storageEntries(path, embedded ? 24 : 32, fixed, strings, binaries)
	let recipient = 0

	for (const [type, list] of [
		[1, spec.to ?? []],
		[2, spec.cc ?? []]
	] as const) {
		for (const [name, address] of list) entries.push(...recipientEntries(path, recipient++, type, name, address))
	}

	;(spec.attachments ?? []).forEach((attachment, index) => {
		const at = [...path, attachmentStorage(index)]

		if ("message" in attachment) {
			entries.push(
				...storageEntries(at, 8, [[0x3705, PT_INT32, 5n]], new Map([[0x3001, attachment.name]])),
				...messageEntries(attachment.message, [...at, "__substg1.0_3701000D"], true)
			)

			return
		}

		const strings = new Map<number, string>([[0x3707, attachment.name]])

		if (attachment.mimeType !== undefined) strings.set(0x370e, attachment.mimeType)
		if (attachment.contentId !== undefined) strings.set(0x3712, attachment.contentId)

		entries.push(
			...storageEntries(
				at,
				8,
				[[0x3705, PT_INT32, 1n], ...(attachment.hidden === true ? [[0x7ffe, PT_BOOLEAN, 1n] as const] : [])],
				strings,
				new Map([[0x3701, attachment.bytes]])
			)
		)
	})

	return entries
}

export function msgBytes(spec: MsgSpec): Promise<Uint8Array> {
	return cfbBytes(messageEntries(spec))
}
