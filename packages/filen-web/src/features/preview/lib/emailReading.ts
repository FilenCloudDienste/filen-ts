import PostalMime, { type Address, type Email } from "postal-mime"
import { isCompoundFile } from "@filen/office/core/cfb"
import { readMsg, type MsgAddress, type MsgMessage } from "@filen/office/core/msg"
import { withoutFormatControls } from "@filen/shared/formatControls"
import { EMAIL_MAX_HTML_CHARS } from "@filen/shared/dom/emailSanitizer"
import { EMAIL_MAX_BYTES, TEXT_CAP } from "@/features/preview/lib/previewCaps"

// A message (.eml, or Outlook's .msg) read for its viewer, in the text-family worker: headers as display text, its HTML and text bodies,
// and its attachments as Blobs (outside the JS heap, shared with the page without a copy). Nothing it names is fetched.
//
// Hostile-input bounds: the file is at most EMAIL_MAX_BYTES (the category's cap), so no decoded part can be larger
// (base64 and quoted-printable only shrink); MIME nesting stops at MAX_NESTING, parts at MAX_PARTS, headers at
// postal-mime's 2 MiB; a forwarded message (message/rfc822) is never parsed inline, it is an attachment the viewer opens
// as a message of its own. A .msg is read by @filen/office/core/msg, under its own bounds (sector chains, the
// directory, property streams, attachments, the RTF body); an embedded message is a .msg attachment the same way.
// Past a bound the reading is "tooLarge".

const MAX_NESTING = 32
const MAX_PARTS = 1000
const MAX_ADDRESSES = 200
const MAX_SHORT = 512

export interface EmailAttachment {
	readonly name: string
	readonly mimeType: string
	readonly size: number
	readonly blob: Blob
	// Content-ID without its angle brackets: what a cid: URL in the HTML names; null for none.
	readonly contentId: string | null
	// The raster type its first bytes say it is (never its declared type), or null: only such a part is shown in place
	// by the HTML, as a blob of this type. SVG never is: a blob URL of it could be opened as a document.
	readonly imageType: string | null
}

export interface EmailMessage {
	readonly subject: string | null
	readonly from: string | null
	readonly to: readonly string[]
	readonly cc: readonly string[]
	// Addresses past MAX_ADDRESSES, counted.
	readonly addressesOmitted: number
	// Reply-To, when it names someone other than the sender; else empty.
	readonly replyTo: readonly string[]
	// The sender's domain as written when it is international (shown in its ASCII form in `from`); else null.
	readonly fromIdnDomain: string | null
	// ISO 8601, or the header as written when it does not parse; null for none.
	readonly date: string | null
	// Null past the sanitizer's cap (EMAIL_MAX_HTML_CHARS) too (htmlTooLarge): cut HTML is not a document.
	readonly html: string | null
	readonly htmlTooLarge: boolean
	// Cut at TEXT_CAP characters (textTruncated): the page never holds more of a body than a text file's.
	readonly text: string | null
	readonly textTruncated: boolean
	readonly attachments: readonly EmailAttachment[]
	// Whether the file is text a Source view can show (a .msg is not).
	readonly hasSource: boolean
}

export type EmailReading = ({ readonly status: "ok" } & EmailMessage) | { readonly status: "tooLarge" }

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
	return signature.every((byte, k) => bytes[at + k] === byte)
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
	return String.fromCharCode(...bytes.subarray(start, end))
}

// The raster formats every browser decodes in an <img>, by their signatures.
export function rasterImageType(bytes: Uint8Array): string | null {
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
	if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif"
	if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp"
	if (ascii(bytes, 4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(bytes, 8, 12))) return "image/avif"
	if (ascii(bytes, 0, 2) === "BM") return "image/bmp"
	if (startsWith(bytes, [0, 0, 1, 0])) return "image/x-icon"

	return null
}

const LIMIT_CODES: ReadonlySet<string> = new Set(["EMAXNESTINGDEPTH", "EMAXHEADERSIZE", "EMAXPARTCOUNT", "EMAXFORWARDEDADDRESSES"])

// Header text as shown: format controls (bidi overrides among them) gone, whitespace runs one space (padding cannot push
// a name's real end out of view), cut short.
function display(text: string | undefined | null): string | null {
	const shown = withoutFormatControls(text ?? "")
		.replace(/\s+/g, " ")
		.trim()

	return shown === "" ? null : shown.slice(0, MAX_SHORT)
}

// An address with an international (non-ASCII) domain in its ASCII form, which no lookalike script can imitate.
function asciiAddress(address: string): { readonly shown: string; readonly idn: string | null } {
	const at = address.lastIndexOf("@")
	const domain = address.slice(at + 1)

	if (at < 0 || /^[\x20-\x7e]*$/.test(domain)) return { shown: address, idn: null }

	try {
		return { shown: `${address.slice(0, at + 1)}${new URL(`http://${domain}`).hostname}`, idn: domain }
	} catch {
		return { shown: address, idn: domain }
	}
}

// "Name <address>"; the address first when the name could pass for one ("support@bank.com" <x@evil.io>).
function mailbox(name: string, address: string): string {
	const shownName = display(name)
	const shownAddress = asciiAddress(display(address) ?? "").shown

	if (shownAddress === "") return shownName ?? ""
	if (shownName === null || shownName === shownAddress) return shownAddress

	return shownName.includes("@") ? `${shownAddress} (${shownName})` : `${shownName} <${shownAddress}>`
}

// The sender's international domain as written, for the viewer to point out; null for an ASCII one.
function idnDomain(address: string | null | undefined): string | null {
	return asciiAddress(display(address) ?? "").idn
}

// Reply-To where it names someone other than the sender.
function differingReplyTo(replyTo: readonly Address[] | undefined, from: Address | undefined): string[] {
	const sender = (from?.address ?? "").toLowerCase()
	const list = addresses(replyTo, { left: MAX_ADDRESSES, omitted: 0 })
	const members = (replyTo ?? []).flatMap(entry => entry.group ?? [entry])

	return members.every(member => member.address.toLowerCase() === sender) ? [] : list
}

// Each address once, as "Name <address>"; a group as its members.
function addresses(list: readonly Address[] | undefined, budget: { left: number; omitted: number }): string[] {
	const out: string[] = []

	for (const entry of list ?? []) {
		for (const member of entry.group ?? [entry]) {
			if (budget.left <= 0) {
				budget.omitted++
				continue
			}

			budget.left--
			out.push(mailbox(member.name, member.address))
		}
	}

	return out
}

function contentId(value: string | undefined): string | null {
	const id = value?.trim().replace(/^<|>$/g, "")

	return id === undefined || id === "" ? null : id
}

function bodies(html: string | null, text: string | null): Pick<EmailMessage, "html" | "htmlTooLarge" | "text" | "textTruncated"> {
	// Past the sanitizer's own cap HTML is refused on the page anyway: not sent.
	const htmlTooLarge = html !== null && html.length > EMAIL_MAX_HTML_CHARS
	const textTruncated = text !== null && text.length > TEXT_CAP

	return {
		html: htmlTooLarge ? null : html,
		htmlTooLarge,
		text: textTruncated ? text.slice(0, TEXT_CAP) : text,
		textTruncated
	}
}

function readMessage(email: Email): EmailMessage {
	const budget = { left: MAX_ADDRESSES, omitted: 0 }
	const from = email.from === undefined ? null : (addresses([email.from], budget)[0] ?? null)
	const to = addresses(email.to, budget)
	const cc = addresses(email.cc, budget)

	return {
		subject: display(email.subject),
		from,
		to,
		cc,
		addressesOmitted: budget.omitted,
		replyTo: differingReplyTo(email.replyTo, email.from),
		fromIdnDomain: idnDomain(email.from?.address),
		date: display(email.date),
		...bodies(email.html ?? null, email.text ?? null),
		attachments: email.attachments.map((attachment, index) => {
			const content = attachment.content
			// arraybuffer encoding: an ArrayBuffer; a string only for an encoding this never asks for.
			const bytes = typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content)
			const blob = new Blob([bytes], { type: attachment.mimeType })
			const id = contentId(attachment.contentId)

			return {
				name:
					display(attachment.filename) ??
					`attachment-${String(index + 1)}${attachment.mimeType === "message/rfc822" ? ".eml" : ""}`,
				mimeType: attachment.mimeType,
				size: blob.size,
				blob,
				contentId: id,
				imageType: id === null ? null : rasterImageType(bytes)
			}
		}),
		hasSource: true
	}
}

function msgMailbox(entry: MsgAddress): string {
	return mailbox(entry.name ?? "", entry.address ?? "")
}

function readMsgMessage(message: MsgMessage): EmailMessage {
	const shown = (list: readonly MsgAddress[]): string[] => list.map(msgMailbox).filter(entry => entry !== "")
	const from = message.from === null ? "" : msgMailbox(message.from)

	return {
		subject: display(message.subject),
		from: from === "" ? null : from,
		to: shown(message.to),
		cc: shown(message.cc),
		addressesOmitted: message.recipientsOmitted,
		// Reply-To is not read from a .msg (its recipients are entry IDs, not addresses).
		replyTo: [],
		fromIdnDomain: idnDomain(message.from?.address),
		date: display(message.date),
		...bodies(message.html, message.text),
		attachments: message.attachments.map((attachment, index) => {
			const mimeType = attachment.mimeType ?? "application/octet-stream"
			const blob = new Blob([attachment.bytes as Uint8Array<ArrayBuffer>], { type: mimeType })
			const id = contentId(attachment.contentId ?? undefined)

			return {
				name: display(attachment.name) ?? `attachment-${String(index + 1)}${attachment.message ? ".msg" : ""}`,
				mimeType,
				size: blob.size,
				blob,
				contentId: id,
				imageType: id === null ? null : rasterImageType(attachment.bytes)
			}
		}),
		hasSource: false
	}
}

export async function readEmail(bytes: Uint8Array<ArrayBuffer>): Promise<EmailReading> {
	if (bytes.length > EMAIL_MAX_BYTES) {
		return { status: "tooLarge" }
	}

	if (isCompoundFile(bytes)) {
		const reading = await readMsg(bytes, { maxSize: EMAIL_MAX_BYTES })

		return reading.status === "ok" ? { status: "ok", ...readMsgMessage(reading.message) } : reading
	}

	try {
		// The whole buffer when the bytes are all of it (a transferred copy is): a view would be copied again.
		const input = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes
		const email = await PostalMime.parse(input, {
			attachmentEncoding: "arraybuffer",
			forceRfc822Attachments: true,
			maxRfc822NestingDepth: 0,
			maxNestingDepth: MAX_NESTING,
			maxPartCount: MAX_PARTS
		})

		return { status: "ok", ...readMessage(email) }
	} catch (e) {
		if (e instanceof Error && "code" in e && typeof e.code === "string" && LIMIT_CODES.has(e.code)) {
			return { status: "tooLarge" }
		}

		throw e
	}
}
