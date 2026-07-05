import { useEffect } from "react"
import { bootSdk } from "@/lib/sdk/boot"
import { useBootStore } from "@/stores/boot"
import { labelFirst } from "@/lib/sdk/errors"

// TEMPORARY dev smoke (T9 replaces App.tsx): boots the SDK worker on mount and renders the boot
// phase, so T3 Step 1 (spawn-base) and the COI gate can be observed live in a real browser.
// Module-level guard survives StrictMode's effect double-invoke so we boot exactly once.
let started = false

export function App() {
	const phase = useBootStore(s => s.phase)
	const reason = useBootStore(s => s.reason)
	const error = useBootStore(s => s.error)

	useEffect(() => {
		if (started) {
			return
		}
		started = true
		void bootSdk()
	}, [])

	return (
		<div className="flex min-h-svh flex-col gap-2 p-6 font-mono text-sm">
			<div data-testid="boot-phase">boot: {phase}</div>
			{phase === "error" && (
				<>
					<div data-testid="boot-reason">reason: {reason}</div>
					<div data-testid="boot-label">{error ? labelFirst(error) : ""}</div>
				</>
			)}
		</div>
	)
}

export default App
