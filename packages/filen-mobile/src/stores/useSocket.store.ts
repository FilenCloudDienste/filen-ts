import { create } from "zustand"

export type State = "connected" | "disconnected" | "reconnecting"

export type SocketStore = {
	state: State
	// When the socket last became connected (0 = never). Data fetched before this may have missed
	// events that arrived while it was down, so socket-invalidated caches must not trust it.
	connectedAt: number
	// When the socket last stopped being connected (0 = never). A read begun since then reflects every
	// change the gap hid, give or take the moments before the reconnect.
	disconnectedAt: number
	setState: (fn: State | ((prev: State) => State)) => void
}

export const useSocketStore = create<SocketStore>(set => ({
	state: "disconnected",
	connectedAt: 0,
	disconnectedAt: 0,
	setState(fn) {
		set(state => {
			const next = typeof fn === "function" ? fn(state.state) : fn

			return {
				state: next,
				connectedAt: next === "connected" && state.state !== "connected" ? Date.now() : state.connectedAt,
				disconnectedAt: next !== "connected" && state.state === "connected" ? Date.now() : state.disconnectedAt
			}
		})
	}
}))

export default useSocketStore

// Calls `listener` each time the socket connects again after this call: whatever it sent while down, a
// background included (which tears the listener down), was missed. Returns the unsubscribe.
export function onSocketReconnected(listener: () => void): () => void {
	return useSocketStore.subscribe((state, prev) => {
		if (state.connectedAt !== prev.connectedAt) {
			listener()
		}
	})
}
