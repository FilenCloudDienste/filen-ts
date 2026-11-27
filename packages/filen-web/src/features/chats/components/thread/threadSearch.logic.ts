import type { ChatMessage } from "@filen/sdk-rs"
import type { BlockedUsers } from "@filen/shared"
import { isSenderBlocked } from "@/features/chats/lib/sender"

// In-thread search over the messages already loaded and decrypted: no request, no index. A page of older history is
// only loaded when the reader asks for it (the search bar's "Search older messages").

// The needle every comparison uses: case-insensitive, outer whitespace ignored. Empty means no search.
export function threadSearchNeedle(query: string): string {
	return query.trim().toLowerCase()
}

export function messageMatchesNeedle(text: string | undefined, needle: string): boolean {
	return needle.length > 0 && text?.toLowerCase().includes(needle) === true
}

// The uuids of the matching messages, newest first: the order Enter walks. A hidden blocked sender's message is not
// searched (its text is not on screen), nor an undecryptable one.
export function threadSearchMatches(
	messages: readonly ChatMessage[],
	needle: string,
	blocked: BlockedUsers,
	revealed: ReadonlySet<string>
): string[] {
	const matches: string[] = []

	if (needle.length === 0) {
		return matches
	}

	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]

		if (
			message !== undefined &&
			messageMatchesNeedle(message.message, needle) &&
			(!isSenderBlocked(message, blocked) || revealed.has(message.uuid))
		) {
			matches.push(message.uuid)
		}
	}

	return matches
}

// The match `step` places from `current` (+1 older, -1 newer), clamped at both ends; the newest one without a current.
export function stepThreadMatch(matches: readonly string[], current: string | null, step: 1 | -1): string | null {
	if (matches.length === 0) {
		return null
	}

	const index = current === null ? -1 : matches.indexOf(current)

	if (index === -1) {
		return matches[0] ?? null
	}

	return matches[Math.min(Math.max(index + step, 0), matches.length - 1)] ?? null
}

export interface HighlightRange {
	start: number
	end: number
}

// Where `needle` occurs in `text`, for its marks. None when lower-casing changes the text's length (a few scripts'
// letters do), as the offsets would no longer line up; the row still shows it matches.
export function highlightRanges(text: string, needle: string): HighlightRange[] {
	const ranges: HighlightRange[] = []

	if (needle.length === 0) {
		return ranges
	}

	const lower = text.toLowerCase()

	if (lower.length !== text.length) {
		return ranges
	}

	let from = lower.indexOf(needle)

	while (from !== -1) {
		ranges.push({ start: from, end: from + needle.length })
		from = lower.indexOf(needle, from + needle.length)
	}

	return ranges
}

// The cursor for the page before `page`: its oldest message's timestamp.
export function oldestTimestamp(page: readonly ChatMessage[]): bigint | undefined {
	let oldest: bigint | undefined

	for (const message of page) {
		if (oldest === undefined || message.sentTimestamp < oldest) {
			oldest = message.sentTimestamp
		}
	}

	return oldest
}

// The newest message of an older page that matches: where "Search older messages" moves to.
export function newestMatchInPage(page: readonly ChatMessage[], needle: string, blocked: BlockedUsers): ChatMessage | undefined {
	let newest: ChatMessage | undefined

	for (const message of page) {
		if (
			messageMatchesNeedle(message.message, needle) &&
			!isSenderBlocked(message, blocked) &&
			(newest === undefined || message.sentTimestamp > newest.sentTimestamp)
		) {
			newest = message
		}
	}

	return newest
}
