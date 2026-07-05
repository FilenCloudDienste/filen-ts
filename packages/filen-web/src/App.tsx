import { useEffect } from "react"
import { bootSdk } from "@/lib/sdk/boot"
import { useBootStore } from "@/stores/boot"
import { labelFirst } from "@/lib/sdk/errors"

// TEMPORARY dev smoke: boots the SDK worker on mount and renders the boot phase, so the boot
// sequence and the COI gate can be observed live in a real browser. This file will be replaced
// once real routing/UI lands.
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
