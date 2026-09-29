import { isBlocked, type BlockedUsers } from "@filen/shared"

// Message sender identity. senderId is `number` on the wasm surface (a codegen quirk; every other user id
// is bigint), so it MUST be coerced with BigInt before any comparison: `===` between a number and a bigint
// is always false.

export function isOwnMessage(message: { senderId: number }, userId: bigint | undefined): boolean {
	return BigInt(message.senderId) === userId
}

export function isSenderBlocked(message: { senderId: number; senderEmail: string }, blocked: BlockedUsers): boolean {
	return isBlocked({ userId: BigInt(message.senderId), email: message.senderEmail }, blocked)
}

export function toSenderRef(message: { sentTimestamp: bigint; senderId: number; senderEmail: string }): {
	sentTimestamp: bigint
	senderId: bigint
	senderEmail: string
} {
	return { sentTimestamp: message.sentTimestamp, senderId: BigInt(message.senderId), senderEmail: message.senderEmail }
}
