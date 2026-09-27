import { PushEchoes } from "@filen/shared"

// What this device recently pushed as each note's content (@filen/shared's PushEchoes): the only way to
// tell this device's own push coming back over the socket from the same account editing on another
// device. Every content push goes through notesContent.setContent, which records it. Sign-out reloads the
// JS runtime, which empties it.
const pushes = new PushEchoes()

export function rememberNotePush(uuid: string, hash: string): void {
	pushes.remember(uuid, hash)
}

export function isOwnNotePush(uuid: string, hash: string): boolean {
	return pushes.isOwn(uuid, hash)
}
