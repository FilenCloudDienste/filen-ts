import type { UserEventResult } from "@filen/sdk-rs"

export type OkEventResult = Extract<UserEventResult, { type: "ok" }>

// Pure pagination step, mirrors filen-mobile's computeNextPage (features/events/screens/events.tsx):
// given the already-loaded Ok event ids and a raw next page from the server, returns only the new Ok
// items (Err entries have no stable id, cannot be deduped, and must never be persisted into the cache)
// plus a `terminate` flag. Termination fires when the page delivers zero new decryptable events — an
// empty page, an all-Err page, or a page whose Ok ids were all already seen — which prevents an
// Err-only page from causing an infinite refetch loop.
export function computeNextEventsPage(
	existingOkIds: ReadonlySet<bigint>,
	page: UserEventResult[]
): { newOk: OkEventResult[]; terminate: boolean } {
	const newOk = page.filter((e): e is OkEventResult => e.type === "ok" && !existingOkIds.has(e.id))

	return { newOk, terminate: newOk.length === 0 }
}
