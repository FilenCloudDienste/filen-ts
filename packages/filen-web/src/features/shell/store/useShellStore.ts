import { create } from "zustand"

// Persisted UI chrome state for the app shell. Only the sidebar-collapse flag lives here today; the
// rail's collapse toggle writes it and AppShell reads it to drop the sidebar column (rail stays, the
// content card widens to fill the freed space).
const STORAGE_KEY = "sidebarCollapsed"

function readInitial(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) === "1"
	} catch {
		// Private-mode / disabled storage — fall back to expanded; state stays in-memory only.
		return false
	}
}

interface ShellState {
	sidebarCollapsed: boolean
	toggleSidebar: () => void
}

export const useShellStore = create<ShellState>(set => ({
	sidebarCollapsed: readInitial(),
	toggleSidebar: () => {
		set(state => {
			const next = !state.sidebarCollapsed

			try {
				localStorage.setItem(STORAGE_KEY, next ? "1" : "0")
			} catch {
				// Persistence best-effort — the in-memory toggle still applies for this session.
			}

			return { sidebarCollapsed: next }
		})
	}
}))
