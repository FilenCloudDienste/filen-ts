import { create } from "zustand"
import type { BootResult } from "@/workers/sdk.worker"
import type { ErrorDTO } from "@/lib/sdk/errors"

// Kept in lockstep with the worker's BootResult so a new failure reason can't drift out of sync.
type BootReason = Extract<BootResult, { ok: false }>["reason"]

// "sessionUnreadable": the desktop vault holds a session it cannot read; boot waits on the recovery screen.
interface BootState {
	phase: "idle" | "booting" | "ready" | "error" | "sessionUnreadable"
	reason?: BootReason
	error?: ErrorDTO
	setBooting: () => void
	setReady: () => void
	setError: (reason: BootReason, error?: ErrorDTO) => void
	setSessionUnreadable: () => void
}

export const useBootStore = create<BootState>(set => ({
	phase: "idle",
	setBooting: () => {
		set({ phase: "booting" })
	},
	setReady: () => {
		set({ phase: "ready" })
	},
	setSessionUnreadable: () => {
		set({ phase: "sessionUnreadable" })
	},
	setError: (reason, error) => {
		// reason/error are only read while phase === "error", so leaving stale values on the happy
		// path is harmless — and avoids assigning explicit `undefined` under exactOptionalPropertyTypes.
		set(error === undefined ? { phase: "error", reason } : { phase: "error", reason, error })
	}
}))
