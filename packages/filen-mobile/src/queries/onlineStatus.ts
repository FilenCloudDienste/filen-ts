import NetInfo, { type NetInfoState } from "@react-native-community/netinfo"
import { onlineManager } from "@tanstack/react-query"
import { AppState } from "react-native"

function computeOnline(state: NetInfoState): boolean {
	return state.isConnected !== false && state.isInternetReachable !== false
}

onlineManager.setEventListener(setOnline => {
	return NetInfo.addEventListener(state => {
		setOnline(computeOnline(state))
	})
})

AppState.addEventListener("change", nextAppState => {
	if (nextAppState !== "active") {
		return
	}

	NetInfo.refresh().catch(console.error)
})
