import type { NetInfoState } from "@react-native-community/netinfo"

// The app's single online rule. Only a definitive `false` counts as offline: `null` means NetInfo
// has not determined the value yet (iOS reports a null `isInternetReachable` until its reachability
// probe first settles, at the start of every process).
export function computeOnline(state: Pick<NetInfoState, "isConnected" | "isInternetReachable">): boolean {
	return state.isConnected !== false && state.isInternetReachable !== false
}
