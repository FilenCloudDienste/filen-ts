// The native host (the SDK's HTTP client and websocket) and the rclone it starts read their proxy from the environment,
// which a PAC script, WPAD or the OS settings never reach. Main asks Chromium's resolver once per launch, for the API's
// address, and hands the answer on; a host started before the answer goes without until it restarts.
export const PROXY_PROBE_URL = "https://gateway.filen.io"
// What startup waits for the answer before it starts the native host anyway.
export const PROXY_RESOLVE_WAIT_MS = 3 * 1000

const LOOPBACK = ["localhost", "127.0.0.1", "::1"]

const PAC_SCHEMES: Record<string, string> = {
	PROXY: "http",
	HTTPS: "https",
	// socks5h: the proxy resolves the API's name, as Chromium has it do. SOCKS (version 4 to a PAC script) goes the
	// same way, as neither the SDK nor rclone speaks SOCKS4.
	SOCKS5: "socks5h",
	SOCKS: "socks5h"
}

// The first entry of a PAC result ("PROXY host:port; DIRECT") as a proxy URL. DIRECT, an empty answer and the kinds
// neither the SDK nor rclone speaks (QUIC) give null.
export function proxyFromPac(result: string): string | null {
	const first = result.split(";")[0]?.trim() ?? ""
	const match = /^(\S+)\s+(\S+)$/.exec(first)
	const scheme = match === null ? undefined : PAC_SCHEMES[(match[1] ?? "").toUpperCase()]

	if (match === null || scheme === undefined) {
		return null
	}

	try {
		const url = new URL(`${scheme}://${match[2] ?? ""}`)

		// A SOCKS URL is not a special scheme to WHATWG URL: its path is empty rather than "/".
		return url.username === "" && (url.pathname === "/" || url.pathname === "") && url.search === "" && url.hash === ""
			? `${scheme}://${url.host}`
			: null
	} catch {
		return null
	}
}

// The variable the environment holds `name` under, in any case and set to something; Windows' variables are
// case-insensitive, so a second spelling of one would be a duplicate.
function envKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
	return Object.keys(env).find(key => key.toUpperCase() === name && (env[key]?.trim() ?? "") !== "")
}

// The spelling to write `name` under: the environment's own, set or empty, so it is replaced rather than doubled.
function spelling(env: NodeJS.ProcessEnv, name: string): string {
	return Object.keys(env).find(key => key.toUpperCase() === name) ?? name
}

// The variables to add to the host's environment for `proxy`. A proxy the user set in the environment (HTTPS_PROXY or
// ALL_PROXY) stays as it is; NO_PROXY keeps the user's entries and always covers loopback (rclone's control port, the
// local serves). A SOCKS proxy goes in ALL_PROXY, which the SDK reads, and in HTTPS_PROXY as well: rclone (Go's
// ProxyFromEnvironment) reads no ALL_PROXY, but takes a socks5h:// URL there.
export function proxyEnv(env: NodeJS.ProcessEnv, proxy: string | null): Record<string, string> {
	if (proxy === null || envKey(env, "HTTPS_PROXY") !== undefined || envKey(env, "ALL_PROXY") !== undefined) {
		return {}
	}

	const noProxyKey = envKey(env, "NO_PROXY")
	const entries =
		noProxyKey === undefined
			? []
			: (env[noProxyKey] ?? "")
					.split(",")
					.map(entry => entry.trim())
					.filter(entry => entry !== "")
	const missing = LOOPBACK.filter(host => !entries.includes(host))

	return {
		...(proxy.startsWith("socks5h://") ? { [spelling(env, "ALL_PROXY")]: proxy } : {}),
		[spelling(env, "HTTPS_PROXY")]: proxy,
		[noProxyKey ?? spelling(env, "NO_PROXY")]: [...entries, ...missing].join(",")
	}
}

export interface HostProxyDeps {
	env: NodeJS.ProcessEnv
	// session.resolveProxy.
	resolve(url: string): Promise<string>
	log: { info(message: string): void; warn(message: string): void }
	waitMs: number
}

export interface HostProxy {
	// The native host's environment: the app's own, with the proxy once it is resolved.
	env(): NodeJS.ProcessEnv
	// Settles once the proxy is resolved, or after `waitMs` while it still is not.
	ready: Promise<void>
}

export function resolveHostProxy(deps: HostProxyDeps): HostProxy {
	let env = deps.env
	const resolving = deps.resolve(PROXY_PROBE_URL).then(
		result => {
			const proxy = proxyFromPac(result)
			const extra = proxyEnv(deps.env, proxy)

			if (proxy !== null && Object.keys(extra).length > 0) {
				env = { ...deps.env, ...extra }
				deps.log.info(`proxy: the native host uses ${proxy}`)
			}
		},
		(error: unknown) => {
			deps.log.warn(`proxy: not resolved: ${error instanceof Error ? error.message : String(error)}`)
		}
	)
	let timer: NodeJS.Timeout | undefined

	return {
		env: () => env,
		ready: Promise.race([
			resolving,
			new Promise<void>(resolve => {
				timer = setTimeout(resolve, deps.waitMs)
			})
		]).finally(() => {
			clearTimeout(timer)
		})
	}
}
