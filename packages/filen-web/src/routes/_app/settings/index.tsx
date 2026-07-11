import { createFileRoute, redirect } from "@tanstack/react-router"

// Bare /settings redirects to the Account section (D3's landing section — see the settings study's
// proposed web shape). A plain component render would also work, but a redirect keeps one canonical
// URL per section active in the sidebar rather than a sixth, section-less "/settings" state.
export const Route = createFileRoute("/_app/settings/")({
	beforeLoad: () => {
		throw redirect({ to: "/settings/account" })
	}
})
