import { create } from "zustand"

// Realtime socket connection status, surfaced for the chat disconnect/reconnect indicator (mobile pins a
// "Reconnecting" strip while the socket is down). The SDK owns the socket's own reconnect and reports it
// through the event stream as a "reconnecting" then (on success) an "authSuccess"; the chat socket
// handlers drive this store off those two events. "connected" is the optimistic default — a live socket
// emits no steady-state heartbeat here, only the reconnecting → authSuccess transition on a drop, so the
// indicator is silent until an actual disconnect flips it.
export type SocketStatus = "connected" | "reconnecting"

export interface SocketStatusStore {
	status: SocketStatus
	setStatus: (status: SocketStatus) => void
}

export const useSocketStatusStore = create<SocketStatusStore>(set => ({
	status: "connected",
	setStatus(status) {
		set({ status })
	}
}))

export default useSocketStatusStore
