import { createFileRoute, notFound } from "@tanstack/react-router"
import { SmoothTransitionsSpike } from "@/features/audio/spike/smoothTransitionsSpike"
import { routeHead } from "@/lib/head/routeHead"

// Throwaway hardware gate page. Without VITE_SMOOTH_TRANSITIONS_SPIKE=1 at build time the route is a 404 and
// the spike component folds out of the bundle.
const ENABLED = import.meta.env.VITE_SMOOTH_TRANSITIONS_SPIKE === "1"

export const Route = createFileRoute("/_app/dev/smooth-transitions-spike")({
	beforeLoad: () => {
		if (!ENABLED) {
			throw notFound()
		}
	},
	head: routeHead({ title: () => ["Smooth transitions spike"] }),
	component: ENABLED ? SmoothTransitionsSpike : () => null
})
