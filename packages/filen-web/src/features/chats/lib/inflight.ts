// Stub until Wave C3 wires the send outbox (the durable per-chat message queue, synthesis §3.3). Owner
// actions that must never let the sync retry into a chat the user just left/deleted — leaveChat and
// deleteChat in lib/actions.ts — already call this today, so C3 only has to fill this function in
// (drop the chat's queued sends + error map + input draft) without touching either call site again. A
// no-op today: there is no outbox yet to purge.
export function purgeChatInflightState(_chatUuid: string): Promise<void> {
	return Promise.resolve()
}
