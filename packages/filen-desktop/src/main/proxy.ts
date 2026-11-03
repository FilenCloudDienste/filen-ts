// The native host (the SDK's HTTP client) and the rclone it starts read their proxy from the environment, which a PAC
// script, WPAD or the OS settings never reach. Main asks Chromium's resolver once per launch, for the API's address,
// and hands an HTTP or HTTPS proxy on as HTTPS_PROXY; a host started before the answer goes without until it restarts.
export const PROXY_PROBE_URL = "https://gateway.filen.io"
// What startup waits for the answer before it starts the native host anyway.
export const PROXY_RESOLVE_WAIT_MS = 3 * 1000

const LOOPBACK = ["localhost", "127.0.0.1", "::1"]

// The first entry of a PAC result ("PROXY host:port; DIRECT") as a proxy URL. DIRECT, an empty answer and the SOCKS
// kinds (the SDK's client speaks none of them) give null.
export function proxyFromPac(result: string): string | null {
	const first = result.split(";")[0]?.trim() ?? ""
	const match = /^(PROXY|HTTPS)\s+(\S+)$/i.exec(first)

	if (match === null) {
		return null
	}

	const [, kind = "", hostPort = ""] = match

	try {
		const url = new URL(`${kind.toUpperCase() === "HTTPS" ? "https" : "http"}://${hostPort}`)

		return url.username === "" && url.pathname === "/" && url.search === "" ? `${url.protocol}//${url.host}` : null
	} catch {
		return null
	}
}

// The variable the environment holds `name` under, in any case and set to something; Windows' variables are
// case-insensitive, so a second spelling of one would be a duplicate.
function envKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
	return Object.keys(env).find(key => key.toUpperCase() === name && (env[key]?.trim() ?? "") !== "")
}

// The variables to add to the host's environment for `proxy`. A proxy the user set in the environment stays as it is;
// NO_PROXY keeps the user's entries and always covers loopback (rclone's control port, the local serves).
export function proxyEnv(env: NodeJS.ProcessEnv, proxy: string | null): Record<string, string> {
	if (proxy === null || envKey(env, "HTTPS_PROXY") !== undefined) {
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
		HTTPS_PROXY: proxy,
		[noProxyKey ?? "NO_PROXY"]: [...entries, ...missing].join(",")
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
			const extra = proxyEnv(deps.env, proxyFromPac(result))
			const proxy = extra["HTTPS_PROXY"]

			if (proxy !== undefined) {
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
