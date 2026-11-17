import { decodedValue, displayText, eachContentLine, textComponents, types, type ContentLine } from "./pimLines"

// A vCard file (RFC 6350, and the 2.1 and 3.0 forms still exported) read for display: each card's name, organization
// and the ways to reach them. Text only: a PHOTO, LOGO, SOUND or URL is never fetched (photos are not read at all).

export interface ContactValue {
	readonly value: string
	// TYPE values, lower-cased (home, work, cell…).
	readonly types: readonly string[]
}

export interface Contact {
	// FN, else the N parts, else the organization, else the first email; "" when the card names nothing.
	readonly name: string
	readonly nickname: string | null
	readonly organization: string | null
	readonly title: string | null
	readonly phones: readonly ContactValue[]
	readonly emails: readonly ContactValue[]
	// Each address on lines: street, locality with region and postal code, country.
	readonly addresses: readonly ContactValue[]
	readonly urls: readonly ContactValue[]
	// As written (a date, or text).
	readonly birthday: string | null
	readonly note: string | null
}

export interface ContactFile {
	readonly contacts: readonly Contact[]
	// Cards past the cap, counted.
	readonly contactsOmitted: number
	// The file was not read to its end (past the line cap): `contactsOmitted` is then a lower bound.
	readonly truncated: boolean
}

const MAX_CONTACTS = 10_000
const MAX_LINES = 1_000_000
// A card's PHOTO can be a long base64 value: only its head is kept, and photos are skipped anyway.
const MAX_LINE_CHARS = 64 * 1024
const MAX_SHORT = 512
const MAX_NOTE = 8192
const MAX_VALUES = 50

// Whether text is a vCard: its first non-empty line opens one (\s takes a byte order mark too).
export function startsVcard(text: string): boolean {
	return /^\s*BEGIN:VCARD\s*(?:\r?\n|\r|$)/i.test(text)
}

interface Draft {
	formatted: string | null
	structured: string | null
	nickname: string | null
	organization: string | null
	title: string | null
	phones: ContactValue[]
	emails: ContactValue[]
	addresses: ContactValue[]
	urls: ContactValue[]
	birthday: string | null
	note: string | null
}

function draft(): Draft {
	return {
		formatted: null,
		structured: null,
		nickname: null,
		organization: null,
		title: null,
		phones: [],
		emails: [],
		addresses: [],
		urls: [],
		birthday: null,
		note: null
	}
}

function nonEmpty(text: string): string | null {
	return text.trim() === "" ? null : text.trim()
}

// N: family; given; additional; prefixes; suffixes.
function structuredName(line: ContentLine): string | null {
	const [family = "", given = "", additional = "", prefix = "", suffix = ""] = textComponents(decodedValue(line, false))

	return nonEmpty([prefix, given, additional, family, suffix].filter(part => part.trim() !== "").join(" "))
}

// ADR: post office box; extended; street; locality; region; postal code; country.
function address(line: ContentLine): string | null {
	const [box = "", extended = "", street = "", locality = "", region = "", postal = "", country = ""] = textComponents(
		decodedValue(line, false)
	)
	const lines = [
		[box, extended, street].filter(part => part.trim() !== "").join(", "),
		[locality, region, postal].filter(part => part.trim() !== "").join(" "),
		country
	]

	return nonEmpty(lines.filter(part => part.trim() !== "").join("\n"))
}

function push(list: ContactValue[], value: string | null, line: ContentLine): void {
	if (value !== null && list.length < MAX_VALUES) {
		list.push({
			value: displayText(value, MAX_SHORT),
			types: types(line).filter(type => type !== "quoted-printable" && type !== "pref")
		})
	}
}

function apply(card: Draft, line: ContentLine): void {
	switch (line.name) {
		case "FN":
			card.formatted ??= nonEmpty(displayText(decodedValue(line), MAX_SHORT))
			break
		case "N":
			card.structured ??= structuredName(line)
			break
		case "NICKNAME":
			card.nickname ??= nonEmpty(displayText(decodedValue(line), MAX_SHORT))
			break
		case "ORG":
			card.organization ??= nonEmpty(
				displayText(
					textComponents(decodedValue(line, false))
						.filter(part => part.trim() !== "")
						.join(", "),
					MAX_SHORT
				)
			)
			break
		case "TITLE":
			card.title ??= nonEmpty(displayText(decodedValue(line), MAX_SHORT))
			break
		case "TEL":
			push(card.phones, nonEmpty(decodedValue(line).replace(/^tel:/i, "")), line)
			break
		case "EMAIL":
			push(card.emails, nonEmpty(decodedValue(line).replace(/^mailto:/i, "")), line)
			break
		case "ADR":
			push(card.addresses, address(line), line)
			break
		case "URL":
			push(card.urls, nonEmpty(decodedValue(line, false)), line)
			break
		case "BDAY":
			card.birthday ??= nonEmpty(displayText(decodedValue(line), 64))
			break
		case "NOTE":
			card.note ??= nonEmpty(displayText(decodedValue(line), MAX_NOTE))
			break
		default:
			break
	}
}

function finish(card: Draft): Contact {
	return {
		name: card.formatted ?? card.structured ?? card.organization ?? card.emails[0]?.value ?? "",
		nickname: card.nickname,
		organization: card.organization,
		title: card.title,
		phones: card.phones,
		emails: card.emails,
		addresses: card.addresses,
		urls: card.urls,
		birthday: card.birthday,
		note: card.note
	}
}

// The cards of a vCard text, in the file's order. A card nested in another (an AGENT) is read as part of its own.
export function readContacts(text: string): ContactFile {
	const contacts: Contact[] = []
	const open: { card: Draft | null } = { card: null }
	let depth = 0
	let omitted = 0

	const complete = eachContentLine(text, { lines: MAX_LINES, lineChars: MAX_LINE_CHARS }, line => {
		if (line.name === "BEGIN" && line.value.trim().toUpperCase() === "VCARD") {
			depth++

			if (depth === 1) {
				if (contacts.length < MAX_CONTACTS) open.card = draft()
				else omitted++
			}

			return
		}

		if (line.name === "END" && line.value.trim().toUpperCase() === "VCARD") {
			if (depth === 1 && open.card !== null) {
				contacts.push(finish(open.card))
				open.card = null
			}

			depth = Math.max(0, depth - 1)

			return
		}

		if (depth === 1 && open.card !== null) apply(open.card, line)
	})

	// A card the file ends inside.
	if (open.card !== null) contacts.push(finish(open.card))

	return { contacts, contactsOmitted: omitted, truncated: !complete }
}
