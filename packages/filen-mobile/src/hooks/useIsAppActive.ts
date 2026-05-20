import { useEffect, useState } from "react"
import { AppState, type AppStateStatus } from "react-native"
import { runEffect } from "@filen/utils"

export default function useIsAppActive(): boolean {
	const [appState, setAppState] = useState<AppStateStatus>(() => AppState.currentState)

	useEffect(() => {
		const { cleanup } = runEffect(defer => {
			const subscription = AppState.addEventListener("change", next => {
				setAppState(next)
			})

			defer(() => {
				subscription.remove()
			})
		})

		return () => {
			cleanup()
		}
	}, [])

	return appState === "active"
}
