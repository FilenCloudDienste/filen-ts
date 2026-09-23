// The realtime socket's authenticated session, for the query families that trust a server read only
// while the socket is there to patch whatever changes after it. Each authSuccess opens a new epoch; the
// socket is down (null) before the first one, from a drop until the next one, and after logout. The
// bridge (socket.ts) updates it before any handler sees the event.
let lastEpoch = 0
let liveEpoch: number | null = null

export function socketAuthenticated(): void {
	lastEpoch++
	liveEpoch = lastEpoch
}

export function socketDropped(): void {
	liveEpoch = null
}

// Read at the start of a server read and handed to socketLiveSince when it settles.
export function currentSocketEpoch(): number | null {
	return liveEpoch
}

// Whether a read that began under `epoch` can count as current: the socket was live when it began and
// has neither dropped nor re-authenticated since, so no event it would have missed went undelivered.
export function socketLiveSince(epoch: number | null): boolean {
	return epoch !== null && epoch === liveEpoch
}
