import { Semaphore } from "@filen/utils"
import type { Chat, ChatTypingType } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { log } from "@/lib/log"
import { useChatTypingStore, type ChatTypingUser } from "@/features/chats/store/useChatTyping"

// Realtime typing — both directions. A faithful port of filen-mobile's chats typing handling
// (socketHandlers.ts receive watchdog + components/chat/input/index.tsx send cadence), re-expressed on
// the flat wasm surface. RECEIVE keeps a per-chat list of typing users with an expiry watchdog so a
// dropped "up" signal can't strand a "typing…" indicator forever; SEND throttles "down" and fires a
// single "up" when the user goes idle / sends / blurs.

// ── RECEIVE ──────────────────────────────────────────────────────────────────

// Auto-clear a typing entry this long after its last "down" if no "up" (or follow-up "down") arrives —
// mobile's exact 10s watchdog (socketHandlers.ts). The signal cadence re-arms it well within this window.
export const TYPING_EXPIRY_MS = 10_000

// Keyed by `${chatUuid}:${senderId}` — NOT by senderId alone: the same user can type in several chats at
// once (group chats), so a global-per-sender key would let a signal in one chat cancel the watchdog armed
// for that sender in another, stranding an indicator when the first chat's "up" is dropped (mobile's own
// keying rationale).
const typingWatchdogs = new Map<string, ReturnType<typeof setTimeout>>()

function watchdogKey(chatUuid: string, senderId: bigint): string {
	return `${chatUuid}:${senderId.toString()}`
}

function clearWatchdog(key: string): void {
	const existing = typingWatchdogs.get(key)

	if (existing !== undefined) {
		clearTimeout(existing)
		typingWatchdogs.delete(key)
	}
}

function removeTypingUser(chatUuid: string, senderId: bigint): void {
	useChatTypingStore.getState().setTyping(prev => {
		const current = prev[chatUuid]

		if (current === undefined) {
			return prev
		}

		const remaining = current.filter(u => u.senderId !== senderId)

		if (remaining.length === current.length) {
			return prev
		}

		const updated = { ...prev }

		if (remaining.length === 0) {
			Reflect.deleteProperty(updated, chatUuid)
		} else {
			updated[chatUuid] = remaining
		}

		return updated
	})
}

// Apply one received typing signal (senderId ALREADY BigInt-coerced at the seam). "down" upserts the
// user (replacing any prior entry for the same senderId) and arms the expiry watchdog; "up" removes the
// user and clears the watchdog.
export function applyTypingSignal(chatUuid: string, user: ChatTypingUser, typingType: ChatTypingType): void {
	const key = watchdogKey(chatUuid, user.senderId)

	clearWatchdog(key)

	if (typingType === "up") {
		removeTypingUser(chatUuid, user.senderId)

		return
	}

	typingWatchdogs.set(
		key,
		setTimeout(() => {
			typingWatchdogs.delete(key)
			removeTypingUser(chatUuid, user.senderId)
		}, TYPING_EXPIRY_MS)
	)

	useChatTypingStore.getState().setTyping(prev => ({
		...prev,
		[chatUuid]: [...(prev[chatUuid] ?? []).filter(u => u.senderId !== user.senderId), user]
	}))
}

// A message from `senderId` in `chatUuid` supersedes their typing state (they just sent) — clear it and
// the watchdog. Called from the messageNew handler (mobile does the same).
export function clearTypingForSender(chatUuid: string, senderId: bigint): void {
	clearWatchdog(watchdogKey(chatUuid, senderId))
	removeTypingUser(chatUuid, senderId)
}

// Logout teardown: drop every watchdog + wipe the store so no timer fires into a cleared session.
export function clearAllTyping(): void {
	for (const timer of typingWatchdogs.values()) {
		clearTimeout(timer)
	}

	typingWatchdogs.clear()
	useChatTypingStore.getState().setTyping({})
}

// ── DISPLAY ──────────────────────────────────────────────────────────────────

export function typingUserName(user: ChatTypingUser): string {
	return user.senderNickName.length > 0 ? user.senderNickName : user.senderEmail
}

// The i18n key + interpolation params for a set of typing users — the SINGLE source both the thread
// footer indicator and the sidebar-row preview override render through, so the copy never diverges.
// Pure; null when nobody is typing.
export type TypingText =
	{ key: "chatTypingSingle"; name: string } | { key: "chatTypingDouble"; name: string; other: string } | { key: "chatTypingSeveral" }

export function typingText(users: readonly ChatTypingUser[]): TypingText | null {
	const first = users[0]

	if (first === undefined) {
		return null
	}

	if (users.length === 1) {
		return { key: "chatTypingSingle", name: typingUserName(first) }
	}

	const second = users[1]

	if (users.length === 2 && second !== undefined) {
		return { key: "chatTypingDouble", name: typingUserName(first), other: typingUserName(second) }
	}

	return { key: "chatTypingSeveral" }
}

// The typing users to render for a chat, self excluded (our own echoed signal must never show). Pure.
export function visibleTypingUsers(users: readonly ChatTypingUser[] | undefined, currentUserId: bigint | undefined): ChatTypingUser[] {
	if (users === undefined || users.length === 0) {
		return []
	}

	if (currentUserId === undefined) {
		return [...users]
	}

	return users.filter(u => u.senderId !== currentUserId)
}

// ── SEND ─────────────────────────────────────────────────────────────────────

// Don't emit another "down" within this window of the last one (mobile fires per-keystroke; a fixed
// throttle keeps the wire quiet without losing the "still typing" signal the receiver's watchdog needs).
const DOWN_THROTTLE_MS = 2_500
// Emit a single "up" this long after the last keystroke (idle) — shorter than the receiver's expiry so a
// real stop lands before the watchdog would guess it.
const IDLE_UP_MS = 5_000

interface TypingSendState {
	lastDownAt: number
	idleTimer: ReturnType<typeof setTimeout> | undefined
	downActive: boolean
}

const sendStates = new Map<string, TypingSendState>()
// Serializes signal sends so an "up" can never overtake the "down" it is meant to follow (mobile's
// Semaphore(1) around sendTyping).
const sendSemaphore = new Semaphore(1)

function getSendState(chatUuid: string): TypingSendState {
	let state = sendStates.get(chatUuid)

	if (state === undefined) {
		state = { lastDownAt: 0, idleTimer: undefined, downActive: false }
		sendStates.set(chatUuid, state)
	}

	return state
}

function emitSignal(chat: Chat, typingType: ChatTypingType): void {
	// Fire-and-forget, serialized: a dropped typing signal is never user-visible (the receiver's watchdog
	// covers a lost "up"), so failures are logged, never surfaced.
	void sendSemaphore
		.acquire()
		.then(async () => {
			try {
				await sdkApi.sendTypingSignal(chat, typingType)
			} finally {
				sendSemaphore.release()
			}
		})
		.catch((e: unknown) => {
			log.warn("chats-typing", "sendTypingSignal failed", chat.uuid, typingType, e)
		})
}

// Call on every keystroke while composing. Throttles the "down" and (re)arms the idle "up".
export function signalTyping(chat: Chat): void {
	const state = getSendState(chat.uuid)
	const now = Date.now()

	if (state.idleTimer !== undefined) {
		clearTimeout(state.idleTimer)
	}

	state.idleTimer = setTimeout(() => {
		signalStopped(chat)
	}, IDLE_UP_MS)

	if (now - state.lastDownAt >= DOWN_THROTTLE_MS) {
		state.lastDownAt = now
		state.downActive = true

		emitSignal(chat, "down")
	}
}

// Call on send / clear / blur / thread teardown. Emits a single "up" iff a "down" is outstanding.
export function signalStopped(chat: Chat): void {
	const state = getSendState(chat.uuid)

	if (state.idleTimer !== undefined) {
		clearTimeout(state.idleTimer)
		state.idleTimer = undefined
	}

	state.lastDownAt = 0

	if (!state.downActive) {
		return
	}

	state.downActive = false

	emitSignal(chat, "up")
}
