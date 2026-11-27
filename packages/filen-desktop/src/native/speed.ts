import type { JsClient, JsClientConfig } from "@filen/sdk-rs"
import type { DesktopClientSpeed, DesktopSpeed } from "@filen/shared/desktop"
import { FULL_CHUNK_BYTES, desktopWebTransferValues } from "@filen/shared/transferPresets"

// The host's two clients' speed: each is built with its preset and limits, and a change reaches the running clients
// through their setters, never a rebuild.

// The SDK clamps a live upload limit below this up to it, but refuses one at construction.
const UPLOAD_KBPS_FLOOR = 16

// The JsClientConfig fields a client's speed sets, every one present.
export type SpeedConfig = {
	[
		K in
			"concurrency" | "rateLimitPerSec" | "fileIoMemoryBudget" | "uploadBandwidthKilobytesPerSec" | "downloadBandwidthKilobytesPerSec"
	]-?: Exclude<JsClientConfig[K], undefined>
}

export function speedConfig(speed: DesktopClientSpeed): SpeedConfig {
	const { chunks, concurrency, rateLimitPerSec } = desktopWebTransferValues(speed.preset, speed.customConcurrency)

	return {
		concurrency,
		rateLimitPerSec,
		fileIoMemoryBudget: BigInt(chunks * FULL_CHUNK_BYTES),
		// 0 is unlimited, at construction as in the setter.
		uploadBandwidthKilobytesPerSec: speed.uploadKbps === 0 ? 0 : Math.max(speed.uploadKbps, UPLOAD_KBPS_FLOOR),
		downloadBandwidthKilobytesPerSec: speed.downloadKbps
	}
}

const SETTERS = [
	"setRequestRateLimit",
	"setBandwidthLimits",
	"setConcurrency",
	"setFileIoMemoryBudget"
] as const satisfies readonly (keyof JsClient)[]

export type SpeedClient = Pick<JsClient, (typeof SETTERS)[number]>

function hasSetters(client: object): client is SpeedClient {
	return SETTERS.every(name => typeof (client as Record<string, unknown>)[name] === "function")
}

function sameSpeed(a: DesktopClientSpeed, b: DesktopClientSpeed): boolean {
	return (
		a.preset === b.preset &&
		a.customConcurrency === b.customConcurrency &&
		a.uploadKbps === b.uploadKbps &&
		a.downloadKbps === b.downloadKbps
	)
}

export interface SpeedApplier {
	// Applies what changed since the last call (or construction) to the client it is for; never rejects.
	apply(speed: DesktopSpeed): Promise<void>
}

// `initial`: what the clients were built with. An addon that predates the setters keeps it until the next start,
// logged once.
export function createSpeedApplier(
	clients: { sync: object; transfers: object },
	initial: DesktopSpeed,
	log: { warn(message: string): void }
): SpeedApplier {
	const applied: DesktopSpeed = { ...initial }
	let unsupportedLogged = false

	async function applyTo(name: keyof DesktopSpeed, speed: DesktopClientSpeed): Promise<void> {
		const client = clients[name]

		if (!hasSetters(client)) {
			if (!unsupportedLogged) {
				unsupportedLogged = true
				log.warn("the addon has no speed setters: speed changes apply at the next start")
			}

			return
		}

		applied[name] = speed

		const config = speedConfig(speed)
		const results = await Promise.allSettled([
			client.setConcurrency(config.concurrency),
			client.setRequestRateLimit(config.rateLimitPerSec),
			client.setFileIoMemoryBudget(config.fileIoMemoryBudget),
			client.setBandwidthLimits(config.uploadBandwidthKilobytesPerSec, config.downloadBandwidthKilobytesPerSec)
		])

		for (const result of results) {
			if (result.status === "rejected") {
				const reason: unknown = result.reason

				log.warn(`${name} speed not applied: ${reason instanceof Error ? reason.message : String(reason)}`)
			}
		}
	}

	return {
		apply: async speed => {
			await Promise.all(
				(["sync", "transfers"] as const)
					.filter(name => !sameSpeed(applied[name], speed[name]))
					.map(name => applyTo(name, speed[name]))
			)
		}
	}
}
