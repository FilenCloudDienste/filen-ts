import { create } from "zustand"

export type State = "connected" | "disconnected" | "reconnecting"

export type SocketStore = {
	state: State
	// When the socket last became connected (0 = never). Data fetched before this may have missed
	// events that arrived while it was down, so socket-invalidated caches must not trust it.
	connectedAt: number
	setState: (fn: State | ((prev: State) => State)) => void
}

export const useSocketStore = create<SocketStore>(set => ({
	state: "disconnected",
	connectedAt: 0,
	setState(fn) {
		set(state => {
			const next = typeof fn === "function" ? fn(state.state) : fn

			return {
				state: next,
				connectedAt: next === "connected" && state.state !== "connected" ? Date.now() : state.connectedAt
			}
		})
	}
}))

export default useSocketStore
