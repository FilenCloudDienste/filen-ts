import { readEmailNames, readHeaderSummary } from "@/features/preview/lib/emailReading"
import { emailText } from "@/features/preview/lib/emailText"
import { MboxScanner, messageBytes, rowFields } from "@/features/preview/lib/textPager/mbox.logic"

// A mailbox as plain text for a reader that takes text (the assistant), from the start of the file only: the first
// messages' senders, dates and subjects, then the first message's extract (as an .eml's: headers, text body, attachment
// names; never a part's bytes). At most `limit` characters and one more.

// Messages listed, and the share of the text they may take before the first message's extract.
const LISTED = 50
const LIST_CHARS = 1500

export async function mailboxText(prefix: Uint8Array<ArrayBuffer>, complete: boolean, limit: number): Promise<string> {
	const scanner = new MboxScanner(prefix.length)

	scanner.feed(prefix, 0)

	const blocks = new Map(scanner.takeCaptured().map(({ index, block }) => [index, block]))
	const lines: string[] = []
	let listed = 0

	for (let at = 0; at < Math.min(scanner.count, LISTED); at++) {
		const block = blocks.get(at)

		if (block === undefined) continue

		const row = await readHeaderSummary(rowFields(block))
		const line = `${String(at + 1)}. ${row.date ?? ""} | ${row.from ?? ""} | ${row.subject ?? ""}`

		if (lines.join("\n").length + line.length > LIST_CHARS) break

		lines.push(line)
		listed++
	}

	const found = complete
		? `${String(scanner.count)} messages`
		: `at least ${String(scanner.count)} messages (only the start of the file was read)`
	const head = `Mailbox: ${found}${listed < scanner.count ? `, the first ${String(listed)} listed` : ""}\n${lines.join("\n")}\n\n`
	const first = scanner.span(0)
	let body = ""

	if (first !== null) {
		const end = first.end ?? prefix.length
		// Running to the end of what was read, of a file read only in part: cut there.
		const cut = !complete && end >= prefix.length
		const reading = await readEmailNames(messageBytes(prefix.slice(first.start, end)))
		const label = cut ? "First message (cut short: only its start was read):" : "First message:"

		body = reading.status === "ok" ? `${label}\n${emailText(reading, Math.max(0, limit - head.length))}` : ""
	}

	return `${head}${body}`.slice(0, limit + 1)
}
