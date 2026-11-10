// Pure targeting for the chats keyboard commands (keymap.ts), testable without rendering the list.

// The conversation `step` rows from the open one (1: below, -1: above), or null at either end. With no conversation
// open (or the open one filtered out), the first row going down and the last going up.
export function adjacentChatUuid(rows: readonly { uuid: string }[], currentUuid: string, step: 1 | -1): string | null {
	const index = rows.findIndex(row => row.uuid === currentUuid)

	if (index === -1) {
		return (step === 1 ? rows[0] : rows.at(-1))?.uuid ?? null
	}

	return rows[index + step]?.uuid ?? null
}

// The nearest conversation with unread messages in the `step` direction from the open one, never the open one itself
// and without wrapping. With no conversation open, the search starts past the matching end.
export function adjacentUnreadChatUuid<T extends { uuid: string }>(
	rows: readonly T[],
	currentUuid: string,
	step: 1 | -1,
	hasUnread: (row: T) => boolean
): string | null {
	const index = rows.findIndex(row => row.uuid === currentUuid)
	const start = index === -1 ? (step === 1 ? 0 : rows.length - 1) : index + step

	for (let i = start; i >= 0 && i < rows.length; i += step) {
		const row = rows[i]

		if (row !== undefined && hasUnread(row)) {
			return row.uuid
		}
	}

	return null
}

// Matches a message's keyboard focus target in the thread (messageRow.tsx: the bubble column, or a blocked sender's
// reveal button).
export const MESSAGE_FOCUS_SELECTOR = "[data-message-focus]"

// The thread's message rows are bottom-up (index 0 is the newest), with time headers and the unread divider between
// them. The index of the next message row from `from` in `step` direction (1: older, -1: newer), or -1 past the end.
export function adjacentMessageIndex(rows: readonly { kind: string }[], from: number, step: 1 | -1): number {
	for (let i = from + step; i >= 0 && i < rows.length; i += step) {
		if (rows[i]?.kind === "message") {
			return i
		}
	}

	return -1
}

// The newest (or oldest loaded) message row's index, or -1 when the thread has none.
export function edgeMessageIndex(rows: readonly { kind: string }[], newest: boolean): number {
	return newest ? adjacentMessageIndex(rows, -1, 1) : adjacentMessageIndex(rows, rows.length, -1)
}

// What a conversation command acts on: the selection when there is one, else the open conversation.
export function chatCommandTargets<T>(selected: readonly T[], open: T | undefined): readonly T[] {
	if (selected.length > 0) {
		return selected
	}

	return open === undefined ? [] : [open]
}

// The text and caret after wrapping [start, end) in backticks: around a selection, or an empty pair with the caret
// between when nothing is selected.
export function wrapInlineCode(value: string, start: number, end: number): { value: string; selectionStart: number; selectionEnd: number } {
	return {
		value: `${value.slice(0, start)}\`${value.slice(start, end)}\`${value.slice(end)}`,
		selectionStart: start + 1,
		selectionEnd: end + 1
	}
}

// The text and caret after inserting a line break over [start, end).
export function insertLineBreak(value: string, start: number, end: number): { value: string; caret: number } {
	return { value: `${value.slice(0, start)}\n${value.slice(end)}`, caret: start + 1 }
}
