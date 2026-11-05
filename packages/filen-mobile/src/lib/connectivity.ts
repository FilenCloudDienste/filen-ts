// The app's single online rule: a network interface is up and Filen answers over a verified
// connection. Only a definitive `false` counts as offline; `null` is not known yet (NetInfo has not
// reported the interface, or no reachability probe has settled since launch), which reads as online.
export function computeOnline(interfaceConnected: boolean | null, reachable: boolean | null): boolean {
	return interfaceConnected !== false && reachable !== false
}
