import { randomBytes } from "node:crypto"
import { existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type { DesktopLockStatus } from "@filen/shared/desktop"
import { errorMessage, fail, runBounded, waitFor } from "../../support.ts"
import { desktop, unlockThroughScreen } from "../app.ts"
import { type ConnectProxy, type Fault, startConnectProxy } from "../connectProxy.ts"
import { nothingSeen, pairOf, sha256, sha256File, syncNow, watchPairs, type PairWatch } from "../extraPair.ts"
import { seededBytes } from "../fixtures.ts"
import type { LaunchExtra } from "../launch.ts"
import { createSampler, describeSample, offlineBlockFor, relaunchThrough, type Sample, type Sampler } from "../offlineBlock.ts"
import { tail, START_TIMEOUT_MS } from "../update.ts"
import type { Chain } from "./common.ts"

// P14 and P15: N with no network but a proxy. Its direct egress is blocked (offlineBlock.ts; the loopback interface
// stays open, and the harness, outside the block, keeps its own) and N starts with HTTPS_PROXY, NO_PROXY for loopback
// and Chromium's --proxy-server, all pointing at a CONNECT proxy on 127.0.0.1 (connectProxy.ts), which only relays.
//   P14 proxy only     the proxy carried gateway, ingest and egest; a local edit uploads and a cloud edit downloads
//                      within 60 s; the drive reads a file; never offline, no attention. The websocket ignores proxies
//                      until the SDK's proxy-aware connector lands (plan A5), so remote change notifications are a
//                      known bug: without them a cloud edit is found by syncNow (or the safety net) instead
//   P15 faults         through the same proxy, one at a time, each must fire:
//                      F1 the first 2 ingest tunnels reset after ~1.5 MiB up; F2 the same on egest, down;
//                      F3 a gateway tunnel reset during a listing; F4 everything throttled to 256 KiB/s with an 8 MiB
//                      upload; F5 the gateway's first reply bytes held 20 s; F6 every ingest tunnel reset for 60 s.
//                      F1-F5 never offline, never error or attention, the file byte for byte; F6 offline, no
//                      attention, and recovered (the file uploaded) within 60 s of the end of the outage
// Information: N's renderer started without --proxy-server (HTTPS_PROXY alone). N is started plainly again at the end.

const MIB = 1024 * 1024
const KIB = 1024
const GATEWAY = "gateway.filen.io"
const INGEST = "ingest.filen.io"
const EGEST = "egest.filen.io"
const START_MS = 3 * 60 * 1000
const EDIT_MS = 60_000
const FAULT_MS = 3 * 60 * 1000
const OUTAGE_MS = 60_000
const RECOVER_MS = 60_000

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
	// A cloud file of `bytes` downloads byte for byte within `timeoutMs`, asked for with syncNow when `nudge`; its name.
	const download = async (label: string, bytes: number, timeoutMs: number, nudge: boolean): Promise<string> => {
		const name = `${label}-${randomBytes(4).toString("hex")}.bin`
		const content = seededBytes(name, bytes)
		const staged = path.join(chain.work, name)
		const local = path.join(pair.localRoot, name)

		writeFileSync(staged, content)
		await cloud.uploadFile(staged, `${options.editCloudDir}/${name}`)

		if (nudge) {
			await syncNow(chain, pair.id)
		}

		await waitFor(`${name} on disk`, timeoutMs, () => (existsSync(local) && sha256File(local) === sha256(content) ? true : null))

		return name
	}

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
			await startWith(chain, block.via, options.pin, proxyLaunch(proxy))

			const settled = await sampler.watch(START_MS, allIdle)

			if (settled.hit === null) {
				fail(`not every pair idle within 3 min: ${describeSample(settled.last)}`)
			}

			return `proxy ${proxy.url}; ${describeSample(settled.hit)}`
		})

		if (!started) {
			return
		}

		sampler.reset()
		watch = watchPairs(sampler)

		await findings.check("P14 a local edit uploads within 60 s", async () => `${await upload("proxy-up", 64 * KIB, EDIT_MS)} uploaded`)

		// Heard (the cache's websocket) or not: without notifications only a pass finds the edit, which syncNow asks for.
		const heard = await download("proxy-down", 64 * KIB, EDIT_MS, false).then(
			name => ({ name, error: null }),
			(error: unknown) => ({ name: null, error: errorMessage(error) })
		)
		const degraded = (await pairOf(chain, pair.id)).degraded.remote

		await findings.known(
			"P14 remote change notifications through the proxy (the websocket)",
			"plan A5: the SDK's websocket connects directly and ignores proxies",
			() => {
				if (degraded) {
					fail(`${pair.name}: remote events degraded`)
				}

				return `${pair.name}: remote events not degraded`
			}
		)
		await findings.check("P14 a cloud edit downloads within 60 s", async () => {
			if (heard.name !== null) {
				return `${heard.name} downloaded`
			}

			if (!degraded) {
				fail(heard.error ?? "not downloaded")
			}

			return `not heard (remote events degraded); ${await download("proxy-down-nudged", 64 * KIB, EDIT_MS, true)} downloaded on syncNow`
		})

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
			"P15 F1 the first 2 ingest tunnels reset after 1.5 MiB: the upload completes, byte for byte",
			{ kind: "resetAfter", host: INGEST, direction: "up", bytes: 1.5 * MIB, tunnels: 2 },
			async () => `${await upload("f1", 6 * MIB, FAULT_MS)} uploaded`
		)
		await fault(
			"P15 F2 the first 2 egest tunnels reset after 1.5 MiB: the download completes, byte for byte",
			{ kind: "resetAfter", host: EGEST, direction: "down", bytes: 1.5 * MIB, tunnels: 2 },
			async () => `${await download("f2", 6 * MIB, FAULT_MS, true)} downloaded`
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

			try {
				writeFileSync(path.join(pair.localRoot, name), content)

				const went = await sampler.watch(OUTAGE_MS, sample => sample.phases.includes(`${pair.name}:offline`))

				offline = went.hit === null ? "" : describeSample(went.hit)
				// The outage lasts its whole minute either way: it is the fault.
				await sleep(Math.max(0, armedAt + OUTAGE_MS - Date.now()))
			} finally {
				armed.disarm()
			}

			const lifted = Date.now()
			const recovered = await sampler.watch(RECOVER_MS, sample => sample.offline === 0 && sample.errors === 0)
			const uploaded = await waitFor(`${name} in the cloud`, Math.max(0, lifted + RECOVER_MS - Date.now()), async () =>
				(await inCloud(name)) ? true : null
			).catch(() => false)
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

			return `fired ${String(armed.fired)}x; offline (${offline}); recovered and uploaded in ${String(Math.round((Date.now() - lifted) / 1000))} s; ${nothingSeen(seen, ["attention"])}`
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
