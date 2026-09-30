import { create } from "zustand"

export type State = "connected" | "disconnected" | "reconnecting"

export type SocketStore = {
	state: State
	// When the socket last became connected (0 = never). Data fetched before this may have missed
	// events that arrived while it was down, so socket-invalidated caches must not trust it.
	connectedAt: number
	setState: (next: State) => void
}

export const useSocketStore = create<SocketStore>(set => ({
	state: "disconnected",
	connectedAt: 0,
	setState(next) {
		set(state => ({
			state: next,
			connectedAt: next === "connected" && state.state !== "connected" ? Date.now() : state.connectedAt
		}))
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
