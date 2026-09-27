import { PushEchoes } from "@filen/shared"

// What this browser recently pushed as each note's content (@filen/shared's PushEchoes): the only way to
// tell this browser's own push coming back over the socket from the same account editing on another
// device. The leader tab pushes for every tab and tells the others (the outbox channel's "pushed"
// message), so each tab holds the same list.
const pushes = new PushEchoes()

export function rememberNotePush(uuid: string, hash: string): void {
	pushes.remember(uuid, hash)
}

export function isOwnNotePush(uuid: string, hash: string): boolean {
	return pushes.isOwn(uuid, hash)
}

export function forgetNotePushes(): void {
	pushes.clear()
}
