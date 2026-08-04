// An own message's socket echo is not applied to the thread cache immediately — socketHandlers.ts parks
// the patch for the send outbox's reconcile delay. While parked the message is in NO cache, so it is
// invisible to every reader, including the ones that would otherwise undo it. This registry is how those
// paths reach it: cancel the parked patch and the echo is dropped instead of re-appearing later as a
// client-only ghost that no further event can remove.
//
// Dependency-free on purpose (the delete action imports it too), and bounded by the delay itself: an
// entry lives at most one reconcile window.

interface ParkedEcho {
	chatUuid: string
	timeoutId: ReturnType<typeof setTimeout>
}

const parked = new Map<string, ParkedEcho>()

export function parkOwnMessageEcho(messageUuid: string, chatUuid: string, timeoutId: ReturnType<typeof setTimeout>): void {
	parked.set(messageUuid, { chatUuid, timeoutId })
}

// The parked patch fired on its own — drop the bookkeeping, never the timer.
export function releaseOwnMessageEcho(messageUuid: string): void {
	parked.delete(messageUuid)
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
		if (echo.chatUuid === chatUuid) {
			clearTimeout(echo.timeoutId)
			parked.delete(messageUuid)
		}
	}
}
