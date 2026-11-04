import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type { DesktopLockStatus } from "@filen/shared/desktop"
import { errorMessage, fail, onTimeout, runBounded, waitFor } from "../../support.ts"
import { desktop, unlockThroughScreen } from "../app.ts"
import { type ConnectProxy, type Fault, startConnectProxy, type Tunnel } from "../connectProxy.ts"
import { DRIVE_LOCK_TIMING, driveWriteGrants, lockWaitNote, outputMark, outputSince, residualBackoff } from "../driveLock.ts"
import { nothingSeen, pairOf, sha256, sha256File, syncNow, waitPair, watchPairs, type PairWatch } from "../extraPair.ts"
import { seededBytes } from "../fixtures.ts"
import type { LaunchExtra } from "../launch.ts"
import { createSampler, describeSample, offlineBlockFor, relaunchThrough, type Sample, type Sampler, seconds } from "../offlineBlock.ts"
import { tail, START_TIMEOUT_MS } from "../update.ts"
import { type LogMark, logMark, logSince } from "../updateFaults.ts"
import type { Chain } from "./common.ts"

// P14 and P15: N with no network but a proxy. Its direct egress is blocked (offlineBlock.ts; the loopback interface
// stays open, and the harness, outside the block, keeps its own) and N starts with HTTPS_PROXY, NO_PROXY for loopback
// and Chromium's --proxy-server, all pointing at a CONNECT proxy on 127.0.0.1 (connectProxy.ts), which only relays.
//   P14 proxy only     N starts with every pair idle and no attention (none inherited from an earlier check); the proxy
//                      carried gateway, ingest and egest; a local edit uploads within 60 s of N's drive-write and a
//                      cloud edit downloads within 60 s, heard through the SDK's websocket, which connects through
//                      the proxy (read from main.log: the renderer's own socket, which honours --proxy-server, makes a
//                      tunnel to the socket's host either way); with every tunnel to the socket's host reset, the pair
//                      reports remote events degraded, a cloud edit downloads within 60 s of a syncNow (the cache
//                      catches up over HTTP), and once tunnels go through again the socket is back within its proxy
//                      backoff (60 s at most) and the report clears; the drive reads a file; never offline, no attention
//   P15 faults         through the same proxy, one at a time, each must fire:
//                      F1 the first 2 ingest tunnels reset after 512 KiB up; F2 the same on egest, down (sdk-rs speaks
//                      HTTP/1.1 and moves 1 MiB chunks concurrently, one per tunnel, so the reset lands mid-chunk; the
//                      cloud file found on syncNow);
//                      F3 a gateway tunnel reset inside the launch's resync listing (`dir/download`, inflated by 128
//                      seeded files): retried, every seeded file on disk, no attention; F4 everything throttled to
//                      256 KiB/s with an 8 MiB upload; F5 the gateway's first reply bytes held 20 s; F6 every ingest
//                      tunnel reset for 60 s from N's first new one.
//                      F1-F5 never offline, never error or attention, the file byte for byte; F6 offline, no attention,
//                      back online within 60 s of the end of the outage, N at drive-write or ingest again within its
//                      leftover pass backoff plus the lock's cap, and the file uploaded within 60 s of that
// Every upload's window starts when N gets the account's drive-write, not when the file is written: every deep entry of
// a run shares the lock and it has no queue, so N's wait for it can be a chain of other entries' holds (each up to 60 s,
// PASS_LOCK_MAX_HOLD, or a lease another entry's lost network left for its 60 s TTL), bounded by the lock's cap (150 s)
// from the edit and reported. The upload itself must then complete within its own window.
// Information: N's renderer started without --proxy-server (HTTPS_PROXY alone). N is started plainly again at the end.

const MIB = 1024 * 1024
const KIB = 1024
const GATEWAY = "gateway.filen.io"
const INGEST = "ingest.filen.io"
const EGEST = "egest.filen.io"
const SOCKET = "socket.filen.io"
// Below one 1 MiB chunk: a tunnel often carries a single chunk.
const RESET_BYTES = 512 * KIB
const START_MS = 3 * 60 * 1000
const EDIT_MS = 60_000
const FAULT_MS = 3 * 60 * 1000
const OUTAGE_MS = 60_000
const RECOVER_MS = 60_000
// The most of a pass backoff the engine may still have to sleep at F6's lift (sdk-rs doubles it from 2 s per failure).
const BACKOFF_CAP_MS = 60_000
// F3's seeded files: enough small ones that the pair root's `dir/download` reply is tens of KiB, far above any other
// reply the SDK gets from the gateway (lock, messageIds, `v3/dir`, user and keys), so only that listing is reset.
const F3_FILES = 128
const F3_REPLY_BYTES = 16 * KIB
// How soon after F3's reset the SDK's retry must reach the gateway again.
const F3_RETRY_MS = 10_000
// How often upload() lists the cloud while it waits for N's drive-write.
const UPLOAD_CLOUD_POLL_MS = 5000

// How soon the pair reports remote events degraded once the socket's tunnels are reset: the reset closes its connection.
const DEGRADED_MS = 30_000
// How soon the socket is back once its tunnels go through again: sdk-rs waits up to 60 s between attempts through a
// proxy that failed it, plus the handshake.
const SOCKET_BACK_MS = 90_000
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

	// A local file of `bytes` uploads byte for byte: N gets drive-write within the lock's cap of the edit, and the file
	// is in the cloud within `timeoutMs` of that grant. A file already in the cloud before a grant is seen (uploaded under
	// a hold N took before the edit, or a grant line the log does not show) counts from when it was found. Its name, the
	// lock wait and the time from grant to upload.
	const upload = async (label: string, bytes: number, timeoutMs: number): Promise<string> => {
		const name = `${label}-${randomBytes(4).toString("hex")}.bin`
		const content = seededBytes(name, bytes)
		const mark = outputMark(chain.appOutput)
		const written = Date.now()

		writeFileSync(path.join(pair.localRoot, name), content)

		// The cloud is listed every UPLOAD_CLOUD_POLL_MS, the log on every probe.
		let listedAt = 0
		const started = await waitFor(
			`N's drive-write after ${name}`,
			DRIVE_LOCK_TIMING.capMs,
			async () => {
				const grant = driveWriteGrants(outputSince(chain.appOutput, mark)).find(at => at >= written)

				if (grant !== undefined) {
					return { at: grant, grant: true }
				}

				if (Date.now() - listedAt < UPLOAD_CLOUD_POLL_MS) {
					return null
				}

				listedAt = Date.now()

				return (await inCloud(name)) ? { at: listedAt, grant: false } : null
			},
			500
		).catch(onTimeout(null))

		if (started === null) {
			fail(`N never got drive-write within ${seconds(0, DRIVE_LOCK_TIMING.capMs)} of the edit, nor was ${name} in the cloud`)
		}

		const granted = started.at

		if (!started.grant) {
			if ((await cloud.sha256Of(`${options.editCloudDir}/${name}`)) !== sha256(content)) {
				fail(`${name} in the cloud differs from the local file`)
			}

			return `${name} in the cloud ${seconds(written, granted)} after the edit, before any drive-write grant was seen`
		}

		await waitFor(`${name} in the cloud`, Math.max(0, granted + timeoutMs - Date.now()), async () =>
			(await inCloud(name)) ? true : null
		).catch((error: unknown) =>
			fail(`${errorMessage(error)} (${seconds(0, timeoutMs)} from N's drive-write, ${seconds(written, granted)} after the edit)`)
		)

		const uploaded = Date.now()

		if ((await cloud.sha256Of(`${options.editCloudDir}/${name}`)) !== sha256(content)) {
			fail(`${name} in the cloud differs from the local file`)
		}

		return `${name} uploaded; drive-write ${seconds(written, granted)} after the edit, in the cloud ${seconds(granted, uploaded)} after it`
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

		await findings.check("P14 a local edit uploads within 60 s of N's drive-write", () => upload("proxy-up", 64 * KIB, EDIT_MS))

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

		await findings.check("P14 remote change notifications through the proxy (the SDK's websocket)", () => {
			if (socket !== "proxied" || degraded) {
				fail(`${SOCKET_STATES[socket]}; ${detail}`)
			}

			return `${SOCKET_STATES[socket]}; ${detail}`
		})

		await findings.check("P14 a cloud edit downloads within 60 s", () => {
			if (heard !== null) {
				fail(`${heard}; ${SOCKET_STATES[socket]}`)
			}

			return `${edit.name} downloaded, heard through the SDK's websocket`
		})

		await findings.check(
			"P14 the SDK's websocket cut off: remote events degraded, a cloud edit found by syncNow within 60 s, the socket back once let through",
			async () => {
				const armed = proxy.arm({ kind: "resetAll", host: SOCKET })
				let found: string

				try {
					await waitPair(chain, pair.id, "remote events reported degraded", DEGRADED_MS, candidate => candidate.degraded.remote)

					// Not heard while the socket is down: the requested pass catches the cache up over HTTP.
					const unheard = await inCloudOnly("proxy-nosocket", 64 * KIB)
					const asked = Date.now()

					await syncNow(chain, pair.id)
					await onDisk(unheard, EDIT_MS)
					found = `${unheard.name} downloaded ${seconds(asked, Date.now())} after syncNow`
				} finally {
					armed.disarm()
				}

				const letThrough = Date.now()

				await waitPair(chain, pair.id, "remote events live again", SOCKET_BACK_MS, candidate => !candidate.degraded.remote)

				return `${found}; ${String(armed.fired)} socket tunnel(s) reset; live again ${seconds(letThrough, Date.now())} after the reset ended`
			}
		)

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
			() => upload("f1", 6 * MIB, FAULT_MS)
		)
		await fault(
			"P15 F2 the first 2 egest tunnels reset after 512 KiB: the download completes, byte for byte",
			{ kind: "resetAfter", host: EGEST, direction: "down", bytes: RESET_BYTES, tunnels: 2 },
			async () => {
				const file = await inCloudOnly("f2", 6 * MIB)

				await syncNow(chain, pair.id)
				await onDisk(file, FAULT_MS)

				return `${file.name} downloaded on syncNow`
			}
		)
		await fault(
			"P15 F3 a gateway tunnel reset inside the launch's resync listing: retried, every seeded file on disk",
			{ kind: "resetInReply", host: GATEWAY, minReplyBytes: F3_REPLY_BYTES, tunnels: 1, sdkOnly: true },
			async () => {
				// The drive moves while N is quit, so its launch relists every root over HTTP whether its socket is up or
				// not; the seeded files make the edit pair's `dir/download` reply the one the fault resets.
				await chain.quit("N-proxy-f3")

				const dir = `f3-${randomBytes(4).toString("hex")}`
				const staged = path.join(chain.work, dir)
				const seeded = Array.from({ length: F3_FILES }, (_, index) => {
					const name = `f3-${String(index).padStart(3, "0")}-${randomBytes(15).toString("hex")}.bin`

					return { name, sha256: sha256(seededBytes(name, KIB)) }
				})

				mkdirSync(staged, { recursive: true })

				for (const file of seeded) {
					writeFileSync(path.join(staged, file.name), seededBytes(file.name, KIB))
				}

				await cloud.upload(staged, `${options.editCloudDir}/${dir}`)

				await startWith(chain, block.via, options.pin, proxyLaunch(proxy))

				const verified = new Set<string>()

				await waitFor(`every seeded file of ${dir} on disk and every pair idle`, FAULT_MS, async () => {
					for (const file of seeded) {
						const local = path.join(pair.localRoot, dir, file.name)

						if (!verified.has(file.name) && existsSync(local) && sha256File(local) === file.sha256) {
							verified.add(file.name)
						}
					}

					if (verified.size < seeded.length) {
						return null
					}

					const sample = await sampler.sample().catch(() => null)

					return sample !== null && allIdle(sample) && sample.waiting === 0 ? true : null
				}).catch((error: unknown) => fail(`${errorMessage(error)}: ${String(verified.size)} of ${String(seeded.length)} on disk`))

				const reset = proxy.tunnels().find(tunnel => tunnel.end?.includes("(resetInReply)") === true)
				const tunnel =
					reset === undefined
						? "no tunnel reset"
						: `tunnel ${String(reset.id)} (${reset.userAgent ?? "no User-Agent"}): ${reset.end ?? ""}`

				// The reset hit the listing (an SDK tunnel, a reply of F3_REPLY_BYTES, which only `dir/download` reaches) and the
				// SDK retried it on another of its tunnels. main.log cannot tell: a body read cut by a reset is retried
				// without a log line.
				if (reset !== undefined && !listingRetried(reset, proxy.tunnels(), GATEWAY, F3_RETRY_MS)) {
					fail(`no SDK tunnel to ${GATEWAY} carried a retry within ${seconds(0, F3_RETRY_MS)} of the reset (${tunnel})`)
				}

				return `${String(seeded.length)} seeded files on disk byte for byte; ${tunnel}`
			}
		)
		await fault(
			"P15 F4 everything throttled to 256 KiB/s: an 8 MiB upload completes, byte for byte",
			{ kind: "throttle", bytesPerSecond: 256 * KIB },
			() => upload("f4", 8 * MIB, 5 * 60 * 1000)
		)
		await fault(
			"P15 F5 the gateway's first reply bytes held 20 s: an edit still uploads",
			{ kind: "holdFirstReply", host: GATEWAY, ms: 20_000 },
			() => upload("f5", 64 * KIB, FAULT_MS)
		)

		await findings.check(
			"P15 F6 every ingest tunnel reset for 60 s: offline, no attention; back online within 60 s, the file uploaded within 60 s of N's next drive-write",
			async () => {
				sampler.reset()

				const watching = watchPairs(sampler)
				const name = `f6-${randomBytes(4).toString("hex")}.bin`
				const content = seededBytes(name, 2 * MIB)
				const mark = outputMark(chain.appOutput)
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
				// What the resets' pass backoff still had to run at the lift (the last one logged before it).
				const backoff = residualBackoff(outputSince(chain.appOutput, mark), lifted, BACKOFF_CAP_MS)
				const recovered = await sampler.watch(RECOVER_MS, sample => sample.offline === 0 && sample.errors === 0)
				// N's next try after the lift: a drive-write grant, or a new ingest tunnel when it held the lock through the
				// outage. A hold of another client (a lease its lost network left included) delays it up to the lock's cap.
				const retried = await waitFor(
					`N at drive-write or ${INGEST} after the lift`,
					backoff + DRIVE_LOCK_TIMING.capMs,
					() => nextTry(driveWriteGrants(outputSince(chain.appOutput, mark)), proxy.tunnels(), INGEST, lifted),
					500
				).catch(onTimeout(null))
				const uploaded =
					retried !== null &&
					(await waitFor(`${name} in the cloud`, Math.max(0, retried + RECOVER_MS - Date.now()), async () =>
						(await inCloud(name)) ? true : null
					).catch(onTimeout(false)))
				const uploadedAt = Date.now()
				const seen = await watching.stop()
				const timing = `residual backoff ${seconds(0, backoff)}; from the lift to N's next drive-write or ${INGEST} ${retried === null ? "never" : seconds(lifted, retried)}`

				if (armed.fired === 0) {
					fail("the fault never fired")
				}

				if (offline === "") {
					fail(`${pair.name} not offline during the outage`)
				}

				if (recovered.hit === null) {
					fail(`not back online within 60 s of the lift: ${describeSample(recovered.last)}`)
				}

				if (retried === null) {
					fail(
						`N neither got drive-write nor reached ${INGEST} within ${seconds(0, backoff + DRIVE_LOCK_TIMING.capMs)} of the lift (${timing}): ${lockWaitNote(outputSince(chain.appOutput, mark))}`
					)
				}

				if (!uploaded) {
					fail(`${name} not uploaded within 60 s of N's next try (${timing}): ${describeSample(recovered.last)}`)
				}

				if ((await cloud.sha256Of(`${options.editCloudDir}/${name}`)) !== sha256(content)) {
					fail(`${name} in the cloud differs from the local file`)
				}

				return `fired ${String(armed.fired)}x; ${reached}; offline (${offline}); back online ${seconds(lifted, recovered.hit.at)} after the lift; ${timing}; uploaded ${seconds(retried, uploadedAt)} after it; ${nothingSeen(seen, ["attention"])}`
			}
		)

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

// N's first try after `since`: its first drive-write grant (driveWriteGrants) or its first new tunnel to `host`,
// whichever came first; null before either.
export function nextTry(
	grants: readonly number[],
	tunnels: readonly Pick<Tunnel, "host" | "openedAt">[],
	host: string,
	since: number
): number | null {
	const first = Math.min(...grants.filter(at => at >= since), firstNewTunnel(tunnels, host, since) ?? Number.POSITIVE_INFINITY)

	return Number.isFinite(first) ? first : null
}

// Whether `reset`, an SDK tunnel (no User-Agent) reset in a reply, was followed within `withinMs` by the SDK's retry:
// another SDK tunnel to `host` that opened after the reset, or one already open that received bytes after it (a pooled
// connection).
export function listingRetried(
	reset: Pick<Tunnel, "id" | "userAgent" | "closedAt">,
	tunnels: readonly Pick<Tunnel, "id" | "host" | "userAgent" | "openedAt" | "lastDownAt" | "closedAt">[],
	host: string,
	withinMs: number
): boolean {
	if (reset.userAgent !== null || reset.closedAt === null) {
		return false
	}

	const at = reset.closedAt

	return tunnels.some(
		tunnel =>
			tunnel.id !== reset.id &&
			tunnel.host === host &&
			tunnel.userAgent === null &&
			((tunnel.openedAt >= at && tunnel.openedAt <= at + withinMs) ||
				(tunnel.openedAt < at && tunnel.lastDownAt !== null && tunnel.lastDownAt > at && tunnel.lastDownAt <= at + withinMs))
	)
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
