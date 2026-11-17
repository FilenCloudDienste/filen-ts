import PostalMime, { type Address, type Email } from "postal-mime"
import { isCompoundFile } from "@filen/office/core/cfb"
import { readMsg, type MsgAddress, type MsgMessage } from "@filen/office/core/msg"
import { withoutFormatControls } from "@filen/shared/formatControls"
import { EMAIL_MAX_BYTES } from "@/features/preview/lib/emailLimits"

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
	// ISO 8601, or the header as written when it does not parse; null for none.
	readonly date: string | null
	readonly html: string | null
	readonly text: string | null
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

function display(text: string | undefined | null): string | null {
	const shown = withoutFormatControls(text ?? "").trim()

	return shown === "" ? null : shown.slice(0, MAX_SHORT)
}

function mailbox(name: string, address: string): string {
	const shownName = display(name)
	const shownAddress = display(address) ?? ""

	return shownName === null || shownName === shownAddress ? shownAddress : `${shownName} <${shownAddress}>`
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
		date: display(email.date),
		html: email.html ?? null,
		text: email.text ?? null,
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
		date: display(message.date),
		html: message.html,
		text: message.text,
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
		const email = await PostalMime.parse(bytes, {
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
