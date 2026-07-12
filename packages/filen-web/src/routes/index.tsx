import { createFileRoute } from "@tanstack/react-router"
import { resolveRootRedirect } from "@/features/shell/lib/rootRedirect"

// The index has no UI of its own — it forwards to the app (honoring the persisted start-screen
// preference) when a session is present, else to sign-in. See rootRedirect.ts for the guard itself
// and its regression test.
export const Route = createFileRoute("/")({
	beforeLoad: resolveRootRedirect
})
