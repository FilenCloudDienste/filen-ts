import NetInfo, { type NetInfoState } from "@react-native-community/netinfo"
import { onlineManager } from "@tanstack/react-query"
import { AppState } from "react-native"
import { NETINFO_CONFIG } from "@/constants"
import logger from "@/lib/logger"

// NetInfo.configure MUST run before the first NetInfo.addEventListener anywhere in the app:
// configure() tears down NetInfo's internal state — severing every existing subscription ("calling
// this will stop all previously added listeners from being called again") and replacing it with a
// fresh, subscriber-less one. It used to run in global.ts AFTER this module's subscription below,
// so onlineManager received exactly ONE boot-time connectivity snapshot and was then frozen for the
// process lifetime — a cold launch during a connectivity blip left the whole app (sign-in included)
// permanently "offline" until the process died. Keeping configure and the subscription in this one
// module makes the ordering impossible to break from the outside.
NetInfo.configure(NETINFO_CONFIG)

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

	// Push the refreshed state into onlineManager directly instead of relying on the subscription
	// above to observe it — foreground recovery then works even if the NetInfo subscription is ever
	// severed again (defense in depth against the configure()-ordering freeze documented above).
	NetInfo.refresh()
		.then(state => onlineManager.setOnline(computeOnline(state)))
		.catch(e => logger.warn("onlineStatus", "NetInfo.refresh failed", { error: e }))
})
