import NetInfo from "@react-native-community/netinfo"
import { onlineManager } from "@tanstack/react-query"
import { AppState } from "react-native"
import { NETINFO_CONFIG } from "@/constants"
import reachability from "@/lib/reachability"
import logger from "@/lib/logger"

// NetInfo.configure MUST run before the first NetInfo.addEventListener anywhere in the app:
// configure() tears down NetInfo's internal state — severing every existing subscription ("calling
// this will stop all previously added listeners from being called again") and replacing it with a
// fresh, subscriber-less one. It used to run in global.ts AFTER this module's subscription below,
// so the app received exactly ONE boot-time connectivity snapshot and was then frozen for the
// process lifetime — a cold launch during a connectivity blip left the whole app (sign-in included)
// permanently "offline" until the process died. Keeping configure and the subscription in this one
// module makes the ordering impossible to break from the outside.
NetInfo.configure(NETINFO_CONFIG)

// NetInfo reports the interface; whether Filen answers is the SDK probe's (lib/reachability.ts).
// Both meet in reachability.isOnline(), which is what onlineManager (and useIsOnline) reads.
NetInfo.addEventListener(state => {
	reachability.setInterface(state.isConnected, state.type)
})

onlineManager.setEventListener(setOnline => {
	setOnline(reachability.isOnline())

	return reachability.subscribe(setOnline)
})

// Re-read the interface on foreground and push it directly instead of relying on the subscription
// above to observe it, so foreground recovery works even if the NetInfo subscription is ever severed
// again (defense in depth against the configure()-ordering freeze documented above). No request: the
// HTTP probe is off.
AppState.addEventListener("change", nextAppState => {
	if (nextAppState !== "active") {
		return
	}

	NetInfo.refresh()
		.then(state => reachability.setInterface(state.isConnected, state.type))
		.catch(e => logger.warn("onlineStatus", "NetInfo.refresh failed", { error: e }))
})

// App state (a foreground re-probe), the socket and the certificate state.
reachability.start()
