import { createFileRoute, redirect } from "@tanstack/react-router"
import { parsePlanId } from "@/features/settings/lib/billingLinks"

// The plans with one preselected by its config id, rendered by the layout (plans.tsx). A malformed id opens the
// plans without one.
export const Route = createFileRoute("/_app/settings/plans/$plan")({
	beforeLoad: ({ params }) => {
		if (parsePlanId(params.plan) === undefined) {
			throw redirect({ to: "/settings/plans", replace: true })
		}
	}
})
