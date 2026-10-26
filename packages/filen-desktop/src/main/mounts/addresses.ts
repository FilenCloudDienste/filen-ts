import type { NetworkInterfaceInfo } from "node:os"
import type { DesktopListenAddress } from "@filen/shared/desktop"
import { isLoopbackHost } from "../../shared/nativeProtocol.ts"

// How far a host reaches, by its form alone (it may be one the interface list no longer holds).
export function listenAddressKind(host: string): DesktopListenAddress["kind"] {
	return host === "0.0.0.0" ? "all" : isLoopbackHost(host) ? "loopback" : "lan"
}

// Loopback first, then every external IPv4 address of `interfaces` (os.networkInterfaces()), then every interface at
// once. `lan` ones carry their interface's name.
export function listenAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): DesktopListenAddress[] {
	const lan: DesktopListenAddress[] = []
	const seen = new Set<string>()

	for (const [name, infos] of Object.entries(interfaces)) {
		for (const info of infos ?? []) {
			if (info.family === "IPv4" && !info.internal && !seen.has(info.address)) {
				seen.add(info.address)
				lan.push({ address: info.address, kind: "lan", interface: name })
			}
		}
	}

	return [{ address: "127.0.0.1", kind: "loopback", interface: null }, ...lan, { address: "0.0.0.0", kind: "all", interface: null }]
}
