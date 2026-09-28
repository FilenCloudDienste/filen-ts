// An own message's socket echo is not applied to the thread cache immediately — socketHandlers.ts parks
// the patch for the send outbox's reconcile delay. While parked the message is in NO cache, so it is
// invisible to every reader, including the ones that would otherwise undo it. This registry is how those
// paths reach it: cancel the parked patch and the echo is dropped instead of re-appearing later as a
// client-only ghost that no further event can remove.
//
// The same holds for an edit or embed-disable of a parked message: it matches nothing in any cache, so it
// is folded into the parked copy (amendOwnMessageEcho) and the patch later applies the amended message.
//
// Dependency-free on purpose (the delete action imports it too), and bounded by the delay itself: an
// entry lives at most one reconcile window.

import type { ChatMessage } from "@filen/sdk-rs"

interface ParkedEcho {
	message: ChatMessage
	timeoutId: ReturnType<typeof setTimeout>
}

const parked = new Map<string, ParkedEcho>()

export function parkOwnMessageEcho(message: ChatMessage, timeoutId: ReturnType<typeof setTimeout>): void {
	parked.set(message.uuid, { message, timeoutId })
}

// The parked patch fired on its own — drop the bookkeeping, never the timer. Returns the message as
// amended while parked, or undefined when it is not parked.
export function releaseOwnMessageEcho(messageUuid: string): ChatMessage | undefined {
	const echo = parked.get(messageUuid)

	parked.delete(messageUuid)

	return echo?.message
}

// Folds a change into a parked echo. Returns whether one was parked.
export function amendOwnMessageEcho(messageUuid: string, patch: Partial<ChatMessage>): boolean {
	const echo = parked.get(messageUuid)

	if (echo === undefined) {
		return false
	}

	echo.message = { ...echo.message, ...patch }

	return true
}

// Returns whether an echo was actually parked, so a caller can tell "this uuid is unknown to us" from
// "we were holding it and just dropped it".
export function cancelOwnMessageEcho(messageUuid: string): boolean {
	const echo = parked.get(messageUuid)

	if (echo === undefined) {
		return false
	}

	clearTimeout(echo.timeoutId)
	parked.delete(messageUuid)

	return true
}

export function cancelOwnMessageEchoesForChat(chatUuid: string): void {
	for (const [messageUuid, echo] of parked) {
		if (echo.message.chat === chatUuid) {
			clearTimeout(echo.timeoutId)
			parked.delete(messageUuid)
		}
	}
}
