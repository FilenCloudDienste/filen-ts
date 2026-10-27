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

export interface HostLookup {
	lookup(name: string, options: { all: true }): Promise<{ address: string; family: number }[]>
	interfaces(): NodeJS.Dict<NetworkInterfaceInfo[]>
	timeoutMs: number
}

// The address `name` resolves to that this machine can listen on (loopback or one of listenAddresses' LAN ones); null
// when it resolves to none of them, fails, or takes longer than `timeoutMs`.
export function createHostResolver(deps: HostLookup): (name: string) => Promise<string | null> {
	return async name => {
		let timer: NodeJS.Timeout | undefined

		try {
			const resolved = await Promise.race([
				deps.lookup(name, { all: true }),
				new Promise<null>(resolve => {
					timer = setTimeout(() => {
						resolve(null)
					}, deps.timeoutMs)
				})
			])

			if (resolved === null) {
				return null
			}

			const lan = new Set(listenAddresses(deps.interfaces()).flatMap(entry => (entry.kind === "lan" ? [entry.address] : [])))

			return resolved.find(entry => isLoopbackHost(entry.address) || lan.has(entry.address))?.address ?? null
		} catch {
			return null
		} finally {
			clearTimeout(timer)
		}
	}
}
