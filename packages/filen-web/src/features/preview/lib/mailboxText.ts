import { readEmailNames, readHeaderSummary } from "@/features/preview/lib/emailReading"
import { emailText } from "@/features/preview/lib/emailText"
import { MboxIndex, headerBlock, messageBytes } from "@/features/preview/lib/textPager/mbox.logic"

// A mailbox as plain text for a reader that takes text (the assistant), from the start of the file only: the first
// messages' senders, dates and subjects, then the first message's extract (as an .eml's: headers, text body, attachment
// names; never a part's bytes). At most `limit` characters and one more.

// Messages listed, and the share of the text they may take before the first message's extract.
const LISTED = 50
const LIST_CHARS = 1500

export async function mailboxText(prefix: Uint8Array<ArrayBuffer>, complete: boolean, limit: number): Promise<string> {
	const index = new MboxIndex(prefix.length)

	index.feed(prefix, 0, true)

	const lines: string[] = []
	let listed = 0

	for (let at = 0; at < Math.min(index.count, LISTED); at++) {
		const span = index.span(at)
		const block = span === null ? null : headerBlock(prefix.subarray(span.start, span.end ?? prefix.length))

		if (block === null) continue

		const row = await readHeaderSummary(block)
		const line = `${String(at + 1)}. ${row.date ?? ""} | ${row.from ?? ""} | ${row.subject ?? ""}`

		if (lines.join("\n").length + line.length > LIST_CHARS) break

		lines.push(line)
		listed++
	}

	const found = complete
		? `${String(index.count)} messages`
		: `at least ${String(index.count)} messages (only the start of the file was read)`
	const head = `Mailbox: ${found}${listed < index.count ? `, the first ${String(listed)} listed` : ""}\n${lines.join("\n")}\n\n`
	const first = index.span(0)
	let body = ""

	// The first message whole within the prefix (its end found, or the prefix is the whole file).
	if (first !== null && (first.end !== null || complete)) {
		const reading = await readEmailNames(messageBytes(prefix.subarray(first.start, first.end ?? prefix.length)))

		body = reading.status === "ok" ? `First message:\n${emailText(reading, Math.max(0, limit - head.length))}` : ""
	}

	return `${head}${body}`.slice(0, limit + 1)
}
