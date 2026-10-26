import type { NetworkInterfaceInfo } from "node:os"

// An address a server can listen on. `lan` ones carry their interface's name.
export interface ListenAddress {
	address: string
	kind: "loopback" | "lan" | "all"
	interface: string | null
}

// Loopback first, then every external IPv4 address of `interfaces` (os.networkInterfaces()), then every interface at
// once.
export function listenAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): ListenAddress[] {
	const lan: ListenAddress[] = []
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
