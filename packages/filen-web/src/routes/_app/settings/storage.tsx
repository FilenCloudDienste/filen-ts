import { createFileRoute, redirect } from "@tanstack/react-router"

// The local caches moved into Advanced; old links still land there.
export const Route = createFileRoute("/_app/settings/storage")({
	beforeLoad: () => {
		throw redirect({ to: "/settings/advanced", replace: true })
	}
})
