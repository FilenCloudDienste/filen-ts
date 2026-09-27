import { PushEchoes, hashNoteContent } from "@filen/shared"

// What this browser recently pushed as each note's content (@filen/shared's PushEchoes): the only way to
// tell this browser's own push coming back over the socket from the same account editing on another
// device. The leader tab pushes for every tab and tells the others (the outbox channel's "pushed"
// message), so each tab holds the same list.
const pushes = new PushEchoes()

// The outbox channel's "pushed" post, wired by outboxCoordinator.ts (none in a single-tab install).
let broadcast: ((uuid: string, hash: string) => void) | null = null

export function setNotePushBroadcast(fn: ((uuid: string, hash: string) => void) | null): void {
	broadcast = fn
}

export function rememberNotePush(uuid: string, hash: string): void {
	pushes.remember(uuid, hash)
}

// A content write made outside the push loop (retype, history restore, a conflicted copy), recorded in
// every tab before it is sent, like the loop's own pushes.
export function recordNotePush(uuid: string, content: string): void {
	const hash = hashNoteContent(content)

	pushes.remember(uuid, hash)
	broadcast?.(uuid, hash)
}

export function isOwnNotePush(uuid: string, hash: string): boolean {
	return pushes.isOwn(uuid, hash)
}

export function forgetNotePushes(): void {
	pushes.clear()
	broadcast = null
}
