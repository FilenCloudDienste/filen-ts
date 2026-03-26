import { useRouter, type Router } from "expo-router"
import { throttle } from "es-toolkit"

const THROTTLE_MS = 1000

// This hook wraps the router's navigation methods with a throttle to prevent multiple rapid navigations that can cause issues in React Navigation.
// Such as navigating to the same screen multiple times, which can lead to unexpected behavior or crashes.
export function useThrottledRouter() {
	const router = useRouter()

	const throttledFns = {
		push: throttle(
			(...args: Parameters<Router["push"]>) => {
				router.push(...args)
			},
			THROTTLE_MS,
			{
				edges: ["leading"]
			}
		),
		replace: throttle(
			(...args: Parameters<Router["replace"]>) => {
				router.replace(...args)
			},
			THROTTLE_MS,
			{
				edges: ["leading"]
			}
		),
		navigate: throttle(
			(...args: Parameters<Router["navigate"]>) => {
				router.navigate(...args)
			},
			THROTTLE_MS,
			{
				edges: ["leading"]
			}
		)
	}

	return {
		...router,
		...throttledFns
	}
}
