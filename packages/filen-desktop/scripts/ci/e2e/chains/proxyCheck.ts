import { randomBytes } from "node:crypto"
import { existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type { DesktopLockStatus } from "@filen/shared/desktop"
import { errorMessage, fail, onTimeout, runBounded, waitFor } from "../../support.ts"
import { desktop, unlockThroughScreen } from "../app.ts"
import { type ConnectProxy, type Fault, startConnectProxy, type Tunnel } from "../connectProxy.ts"
import { DRIVE_LOCK_TIMING } from "../driveLock.ts"
import { nothingSeen, pairOf, sha256, sha256File, syncNow, watchPairs, type PairWatch } from "../extraPair.ts"
import { seededBytes } from "../fixtures.ts"
import type { LaunchExtra } from "../launch.ts"
import { createSampler, describeSample, offlineBlockFor, relaunchThrough, type Sample, type Sampler } from "../offlineBlock.ts"
import { tail, START_TIMEOUT_MS } from "../update.ts"
import { type LogMark, logMark, logSince } from "../updateFaults.ts"
import type { Chain } from "./common.ts"

// P14 and P15: N with no network but a proxy. Its direct egress is blocked (offlineBlock.ts; the loopback interface
// stays open, and the harness, outside the block, keeps its own) and N starts with HTTPS_PROXY, NO_PROXY for loopback
// and Chromium's --proxy-server, all pointing at a CONNECT proxy on 127.0.0.1 (connectProxy.ts), which only relays.
//   P14 proxy only     N starts with every pair idle and no attention (none inherited from an earlier check); the proxy
//                      carried gateway, ingest and egest; a local edit uploads and a cloud edit downloads within 60 s;
//                      the drive reads a file; never offline, no attention. The SDK's websocket ignores proxies until
//                      its proxy-aware connector lands (plan A5), a known bug read from main.log (the renderer's own
//                      socket, which honours --proxy-server, makes a tunnel to the socket's host either way). While the
//                      socket is down a pass enumerates the cloud from the SDK's cache, which nothing refreshes, and the
//                      engine does not report remote events degraded (the subscription validates the root over HTTP,
//                      through the proxy), so syncNow does not find a cloud edit either: a second known bug. Until both
//                      are fixed the cloud edit is found by a relaunch under the proxy, whose first listing is over HTTP
//   P15 faults         through the same proxy, one at a time, each must fire:
//                      F1 the first 2 ingest tunnels reset after 512 KiB up; F2 the same on egest, down (sdk-rs speaks
//                      HTTP/1.1 and moves 1 MiB chunks concurrently, one per tunnel, so the reset lands mid-chunk; the
//                      cloud file found as P14's was);
//                      F3 a gateway tunnel reset during a listing; F4 everything throttled to 256 KiB/s with an 8 MiB
//                      upload; F5 the gateway's first reply bytes held 20 s; F6 every ingest tunnel reset for 60 s from
//                      N's first new one (a foreign hold of drive-write can keep N from ingest for up to its cap).
//                      F1-F5 never offline, never error or attention, the file byte for byte; F6 offline, no
//                      attention, and recovered (the file uploaded) within 60 s of the end of the outage
// Information: N's renderer started without --proxy-server (HTTPS_PROXY alone). N is started plainly again at the end.

const MIB = 1024 * 1024
const KIB = 1024
const GATEWAY = "gateway.filen.io"
const INGEST = "ingest.filen.io"
const EGEST = "egest.filen.io"
// Below one 1 MiB chunk: a tunnel often carries a single chunk.
const RESET_BYTES = 512 * KIB
const START_MS = 3 * 60 * 1000
const EDIT_MS = 60_000
const FAULT_MS = 3 * 60 * 1000
const OUTAGE_MS = 60_000
const RECOVER_MS = 60_000

// The released SDK's two bugs behind a cloud edit not found under the proxy.
const SOCKET_ISSUE =
	"plan A5: the SDK's websocket connects directly and ignores proxies (sdk-rs socket/native.rs connect: CONNECT through HTTPS_PROXY/ALL_PROXY, honouring NO_PROXY)"
const STALE_CACHE_ISSUE =
	"plan A5: with the websocket down the SDK does not report remote events degraded, so a whole pass enumerates the cloud from a cache nothing refreshes (sdk-rs: degraded.remote while the socket is not authed, a whole pass relisting over HTTP)"
const SOCKET_REFUSED = "Error initializing WebSocket connection"
const SOCKET_DIAL_FAILED = "failed to connect to websocket"
// The SDK's handshake span: it starts on a connected socket only, which under the block is the proxy's.
const SOCKET_HANDSHAKE = "websocket_handshake"

export interface ProxyCheckOptions {
	pairs: readonly { name: string; id: string; localRoot: string }[]
	// A twoWay pair the edits go into, and its cloud directory.
	editPair: string
	editCloudDir: string
	pin: string
	// A file read through the drive (relative to the drive's root, "/"-separated) and its sha256.
	driveFile: { path: string; sha256: string }
}

// What N is started with to reach the network through `proxy` only.
export function proxyLaunch(proxy: Pick<ConnectProxy, "url">, renderer = true): LaunchExtra {
	return {
		env: { HTTPS_PROXY: proxy.url, NO_PROXY: "localhost,127.0.0.1" },
		args: renderer ? [`--proxy-server=${proxy.url}`] : []
	}
}

async function startWith(chain: Chain, via: readonly string[] | null, pin: string, extra: LaunchExtra): Promise<void> {
	chain.launchVia = via
	await chain.connect(extra)

	if ((await desktop<DesktopLockStatus>(chain.page(), "window.desktop.lock.status()")).locked) {
		await unlockThroughScreen(chain.page(), pin, START_TIMEOUT_MS)
	}
}

export async function runProxyChecks(chain: Chain, options: ProxyCheckOptions): Promise<void> {
	const { findings, target, cloud } = chain
	const block = offlineBlockFor(target)
	const pair = options.pairs.find(candidate => candidate.name === options.editPair) ?? fail(`no pair ${options.editPair}`)
	const sampler = createSampler(chain, new Set(options.pairs.map(candidate => candidate.id)))
	const proxy = await startConnectProxy()
	const inCloud = async (name: string) =>
		(await cloud.list(options.editCloudDir, false))?.some(item => item.path === name && !item.isDir) === true

	// A local file of `bytes` uploads byte for byte within `timeoutMs`; its name.
	const upload = async (label: string, bytes: number, timeoutMs: number): Promise<string> => {
		const name = `${label}-${randomBytes(4).toString("hex")}.bin`
		const content = seededBytes(name, bytes)

		writeFileSync(path.join(pair.localRoot, name), content)
		await waitFor(`${name} in the cloud`, timeoutMs, async () => ((await inCloud(name)) ? true : null))

		if ((await cloud.sha256Of(`${options.editCloudDir}/${name}`)) !== sha256(content)) {
			fail(`${name} in the cloud differs from the local file`)
		}

		return name
	}
	// A cloud file of `bytes`, put there by the harness.
	const inCloudOnly = async (label: string, bytes: number): Promise<CloudEdit> => {
		const name = `${label}-${randomBytes(4).toString("hex")}.bin`
		const content = seededBytes(name, bytes)
		const staged = path.join(chain.work, name)

		writeFileSync(staged, content)
		await cloud.uploadFile(staged, `${options.editCloudDir}/${name}`)

		return { name, content }
	}
	// The cloud file downloaded byte for byte within `timeoutMs`.
	const onDisk = async (edit: CloudEdit, timeoutMs: number): Promise<void> => {
		const local = path.join(pair.localRoot, edit.name)

		await waitFor(`${edit.name} on disk`, timeoutMs, () =>
			existsSync(local) && sha256File(local) === sha256(edit.content) ? true : null
		)
	}
	// N started again under the proxy: a launch lists each pair's cloud over HTTP, so it finds what the cache missed.
	const relaunchUnderProxy = async (label: string): Promise<void> => {
		await chain.quit(label)
		await startWith(chain, block.via, options.pin, proxyLaunch(proxy))
	}
	// Where main.log stood at N's launch under the proxy.
	let launched: LogMark | null = null

	// Neither stops the chain: without them every check below is moot, and the rest of chain P still runs.
	if (!(await findings.check("P14 the offline block prepared", () => block.prepare()))) {
		await proxy.close()

		return
	}

	let watch: PairWatch | null = null

	try {
		const started = await findings.check("P14 N started with direct egress blocked and the proxy only", async () => {
			await chain.quit("N-before-proxy")
			await block.block(target, [])
			launched = logMark(target)
			await startWith(chain, block.via, options.pin, proxyLaunch(proxy))

			const settled = await sampler.watch(START_MS, startedClean)

			// Attention the proxy has not caused yet would be blamed on it by every check below.
			if (settled.hit === null) {
				fail(
					`${settled.last.syncAttention ? "attention before any fault (left by an earlier check)" : "not every pair idle within 3 min"}: ${describeSample(settled.last)}`
				)
			}

			return `proxy ${proxy.url}; ${describeSample(settled.hit)}`
		})

		if (!started) {
			return
		}

		sampler.reset()
		watch = watchPairs(sampler)

		await findings.check("P14 a local edit uploads within 60 s", async () => `${await upload("proxy-up", 64 * KIB, EDIT_MS)} uploaded`)

		await findings.check("P14 the drive reads a file through the proxy", async () => {
			const root = chain.os.driveRoot((await chain.mountsOverview()).drive) ?? fail("the drive reports no location")
			const file = path.join(root, ...options.driveFile.path.split("/"))
			// A FUSE mount made under the block's group admits that group only, so the read runs in it too.
			const read =
				target.platform === "linux" && block.via !== null
					? await runBounded(block.via[0] ?? "sudo", [...block.via.slice(1), "sha256sum", file], EDIT_MS)
					: null
			const digest = read === null ? await chain.os.sha256Through(file, EDIT_MS) : (read.stdout.split(" ")[0] ?? "")

			if (digest !== options.driveFile.sha256) {
				fail(
					`${options.driveFile.path} through the drive hashes ${digest || "nothing"} (${read === null ? "" : read.stderr.trim()})`
				)
			}

			return `${options.driveFile.path} reads back byte for byte`
		})

		// Heard (the cache's websocket) or not: what the SDK's websocket did is read from main.log, since the launch.
		const edit = await inCloudOnly("proxy-down", 64 * KIB)
		const heard = await onDisk(edit, EDIT_MS).then(
			() => null,
			(error: unknown) => errorMessage(error)
		)
		const socket = sdkSocket(logSince(target, launched ?? fail("no launch mark")))
		const degraded = (await pairOf(chain, pair.id)).degraded.remote
		const detail = `the cloud edit ${heard === null ? "heard" : "not heard"}; remote events ${degraded ? "degraded" : "not degraded"}`

		await findings.known("P14 remote change notifications through the proxy (the SDK's websocket)", SOCKET_ISSUE, () => {
			if (socket !== "proxied") {
				fail(`${SOCKET_STATES[socket]}; ${detail}`)
			}

			return `${SOCKET_STATES[socket]}; ${detail}`
		})

		// Whether a pass reads a stale cache while the socket is down: a syncNow for the edit not heard.
		const staleCache =
			heard !== null &&
			socket !== "proxied" &&
			(await findings.known("P14 a cloud edit found by syncNow while the SDK's websocket is down", STALE_CACHE_ISSUE, async () => {
				await syncNow(chain, pair.id)
				await onDisk(edit, EDIT_MS)

				return `${edit.name} downloaded on syncNow; remote events ${degraded ? "degraded" : "not degraded"}`
			}))

		await findings.check("P14 a cloud edit downloads within 60 s", async () => {
			if (heard === null) {
				return `${edit.name} downloaded`
			}

			// With the socket through the proxy, the edit must have been heard.
			if (socket === "proxied") {
				fail(heard)
			}

			if (!staleCache) {
				return `not heard (the known A5); ${edit.name} downloaded on syncNow`
			}

			await relaunchUnderProxy("N-proxy-relist")
			await onDisk(edit, EDIT_MS)

			return `not heard and not found by syncNow (the known A5); ${edit.name} downloaded by a relaunch's first listing`
		})

		await findings.check("P14 the proxy carried gateway, ingest and egest", () => {
			const hosts = proxy.hosts()
			const missing = [GATEWAY, INGEST, EGEST].filter(host => !hosts.includes(`${host}:443`))

			if (missing.length > 0) {
				fail(`no tunnel to ${missing.join(", ")}; tunnels: ${hosts.join(", ")}`)
			}

			return `${String(proxy.tunnels().length)} tunnels: ${hosts.join(", ")}`
		})

		await findings.check("P14 never offline, never in error, no attention", async () =>
			nothingSeen(watch?.seen() ?? fail("no watch"), ["offline", "error", "attention"])
		)
		await watch.stop()
		watch = null

		// One fault at a time: armed, its traffic made, disarmed whatever happens; it must have fired.
		const fault = async (name: string, spec: Fault, run: () => Promise<string>): Promise<void> => {
			await findings.check(name, async () => {
				sampler.reset()

				const watching = watchPairs(sampler)
				const armed = proxy.arm(spec)
				let result: string

				try {
					result = await run()
				} finally {
					armed.disarm()
					await watching.stop()
				}

				if (armed.fired === 0) {
					fail(`the fault never fired (${result})`)
				}

				const seen = watching.seen()
				const fired = `fired ${String(armed.fired)}x${armed.delayedMs > 0 ? `, ${String(armed.delayedMs)} ms delayed` : ""}`

				return `${result}; ${fired}; ${nothingSeen(seen, ["offline", "error", "attention"])}`
			})
		}

		await fault(
			"P15 F1 the first 2 ingest tunnels reset after 512 KiB: the upload completes, byte for byte",
			{ kind: "resetAfter", host: INGEST, direction: "up", bytes: RESET_BYTES, tunnels: 2 },
			async () => `${await upload("f1", 6 * MIB, FAULT_MS)} uploaded`
		)
		await fault(
			"P15 F2 the first 2 egest tunnels reset after 512 KiB: the download completes, byte for byte",
			{ kind: "resetAfter", host: EGEST, direction: "down", bytes: RESET_BYTES, tunnels: 2 },
			async () => {
				const file = await inCloudOnly("f2", 6 * MIB)

				if (staleCache) {
					await relaunchUnderProxy("N-proxy-f2")
				} else {
					await syncNow(chain, pair.id)
				}

				await onDisk(file, FAULT_MS)

				return `${file.name} downloaded${staleCache ? " by a relaunch's first listing (the known A5)" : " on syncNow"}`
			}
		)
		await fault(
			"P15 F3 a gateway tunnel reset during a listing: the pass completes",
			{ kind: "resetAfter", host: GATEWAY, direction: "down", bytes: 2 * KIB, tunnels: 1 },
			async () => {
				const since = (await pairOf(chain, pair.id)).lastSyncedAt ?? 0

				// A directory beside the pairs changes the drive, so the pass lists the cloud again.
				await cloud.mkdir(`${chain.cloudDir}/relist-${randomBytes(4).toString("hex")}`)
				await syncNow(chain, pair.id)
				await waitFor(`a completed pass of ${pair.name}`, FAULT_MS, async () => {
					const read = await pairOf(chain, pair.id)

					return read.phase === "idle" && (read.lastSyncedAt ?? 0) > since ? true : null
				})

				return "a pass completed after the reset"
			}
		)
		await fault(
			"P15 F4 everything throttled to 256 KiB/s: an 8 MiB upload completes, byte for byte",
			{ kind: "throttle", bytesPerSecond: 256 * KIB },
			async () => `${await upload("f4", 8 * MIB, 5 * 60 * 1000)} uploaded`
		)
		await fault(
			"P15 F5 the gateway's first reply bytes held 20 s: an edit still uploads",
			{ kind: "holdFirstReply", host: GATEWAY, ms: 20_000 },
			async () => `${await upload("f5", 64 * KIB, FAULT_MS)} uploaded`
		)

		await findings.check("P15 F6 every ingest tunnel reset for 60 s: offline, no attention; recovered within 60 s", async () => {
			sampler.reset()

			const watching = watchPairs(sampler)
			const name = `f6-${randomBytes(4).toString("hex")}.bin`
			const content = seededBytes(name, 2 * MIB)
			const armed = proxy.arm({ kind: "resetAll", host: INGEST })
			const armedAt = Date.now()
			let offline: string
			let reached: string

			try {
				writeFileSync(path.join(pair.localRoot, name), content)

				// The outage starts when N first tries ingest: another client's hold of the account's drive-write keeps
				// N's pass waiting for the lock (up to its cap) before any upload, and an idle tunnel's reset fails nothing.
				const outageAt = await waitFor(
					`a new ${INGEST} tunnel`,
					DRIVE_LOCK_TIMING.capMs,
					() => firstNewTunnel(proxy.tunnels(), INGEST, armedAt),
					500
				)

				reached = `N reached ${INGEST} ${String(Math.round((outageAt - armedAt) / 1000))} s after the edit`

				const went = await sampler.watch(Math.max(0, outageAt + OUTAGE_MS - Date.now()), sample =>
					sample.phases.includes(`${pair.name}:offline`)
				)

				offline = went.hit === null ? "" : describeSample(went.hit)
				// The outage lasts its whole minute either way: it is the fault.
				await sleep(Math.max(0, outageAt + OUTAGE_MS - Date.now()))
			} finally {
				armed.disarm()
			}

			const lifted = Date.now()
			const recovered = await sampler.watch(RECOVER_MS, sample => sample.offline === 0 && sample.errors === 0)
			const uploaded = await waitFor(`${name} in the cloud`, Math.max(0, lifted + RECOVER_MS - Date.now()), async () =>
				(await inCloud(name)) ? true : null
			).catch(onTimeout(false))
			const seen = await watching.stop()

			if (armed.fired === 0) {
				fail("the fault never fired")
			}

			if (offline === "") {
				fail(`${pair.name} not offline during the outage`)
			}

			if (recovered.hit === null || !uploaded) {
				fail(`not recovered within 60 s (${name} ${uploaded ? "uploaded" : "not uploaded"}): ${describeSample(recovered.last)}`)
			}

			if ((await cloud.sha256Of(`${options.editCloudDir}/${name}`)) !== sha256(content)) {
				fail(`${name} in the cloud differs from the local file`)
			}

			return `fired ${String(armed.fired)}x; ${reached}; offline (${offline}); recovered and uploaded in ${String(Math.round((Date.now() - lifted) / 1000))} s; ${nothingSeen(seen, ["attention"])}`
		})

		findings.info(
			"P14 the renderer without --proxy-server (HTTPS_PROXY only)",
			await rendererWithoutFlag(chain, block.via, options.pin, proxy, sampler)
		)
	} finally {
		await watch?.stop()
		proxy.disarmAll()
		findings.info("P14 the block lifted", await block.lift().catch(errorMessage))
		findings.info("P14 tunnels per host", tunnelsPerHost(proxy))
		findings.info("P14 halts and lastError texts", sampler.errorsSeen().join(" | ") || "none")
		await proxy.close()
		// The chain goes on with N as it starts it.
		await relaunchThrough(chain, "N-after-proxy", null, options.pin)
	}
}

// Every pair of the sample idle (a lastError aside) and none offline.
export function allIdle(sample: Pick<Sample, "phases" | "offline">): boolean {
	return sample.offline === 0 && sample.phases.split(", ").every(phase => /:idle(\(lastError\))?$/.test(phase))
}

// P14's start: every pair idle and the sync status asking for no attention.
export function startedClean(sample: Pick<Sample, "phases" | "offline" | "syncAttention">): boolean {
	return allIdle(sample) && !sample.syncAttention
}

interface CloudEdit {
	name: string
	content: Buffer
}

export type SdkSocket = "proxied" | "direct" | "silent"

const SOCKET_STATES: Record<SdkSocket, string> = {
	proxied: "the SDK's websocket connected through the proxy",
	direct: "the SDK's websocket dials directly, refused under the block",
	silent: "main.log has no line of the SDK's websocket"
}

// What the SDK's websocket did last in `log` (main.log since N's launch under the block): a handshake, which needs a
// connected socket, or a failed dial, the block refusing a direct connection.
export function sdkSocket(log: string): SdkSocket {
	const lines = log.split("\n")

	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index] ?? ""

		if (line.includes(SOCKET_HANDSHAKE)) {
			return "proxied"
		}

		if (line.includes(SOCKET_REFUSED) && line.includes(SOCKET_DIAL_FAILED)) {
			return "direct"
		}
	}

	return "silent"
}

// When the first tunnel to `host` opened after `since`; null before one did.
export function firstNewTunnel(tunnels: readonly Pick<Tunnel, "host" | "openedAt">[], host: string, since: number): number | null {
	const opened = tunnels.filter(tunnel => tunnel.host === host && tunnel.openedAt > since).map(tunnel => tunnel.openedAt)

	return opened.length === 0 ? null : Math.min(...opened)
}

export function tunnelsPerHost(proxy: Pick<ConnectProxy, "tunnels">): string {
	const counts = new Map<string, { tunnels: number; up: number; down: number }>()

	for (const tunnel of proxy.tunnels()) {
		const key = `${tunnel.host}:${String(tunnel.port)}`
		const entry = counts.get(key) ?? { tunnels: 0, up: 0, down: 0 }

		counts.set(key, { tunnels: entry.tunnels + 1, up: entry.up + tunnel.up, down: entry.down + tunnel.down })
	}

	return (
		[...counts]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([host, entry]) => `${host} x${String(entry.tunnels)} (up ${String(entry.up)}, down ${String(entry.down)})`)
			.join(", ") || "none"
	)
}

// N started again under the block with HTTPS_PROXY but no --proxy-server: what its page and its pairs do. Information.
async function rendererWithoutFlag(
	chain: Chain,
	via: readonly string[] | null,
	pin: string,
	proxy: ConnectProxy,
	sampler: Sampler
): Promise<string> {
	try {
		await chain.quit("N-proxy-env-only")

		const before = proxy.tunnels().length

		await startWith(chain, via, pin, proxyLaunch(proxy, false))

		const settled = await sampler.watch(START_MS, allIdle)
		const fetched = await chain
			.page()
			.evaluate(
				`fetch("https://${GATEWAY}/v3/health", { cache: "no-store" }).then(response => "HTTP " + response.status, error => String(error))`
			)
			.catch(errorMessage)
		const proxyLog = tail(chain.userData("logs", "main.log"), 400)
			.split("\n")
			.filter(line => line.includes("proxy:"))
			.slice(-3)
			.join(" | ")

		return `pairs: ${settled.hit === null ? `not all idle (${describeSample(settled.last)})` : "idle"}; the page's own fetch of the gateway: ${String(fetched)}; ${String(proxy.tunnels().length - before)} tunnels during the launch; main.log: ${proxyLog || "no proxy line"}`
	} catch (error) {
		return `not observed: ${errorMessage(error)}`
	}
}
