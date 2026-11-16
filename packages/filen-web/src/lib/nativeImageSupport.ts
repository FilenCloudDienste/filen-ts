import { scheduleIdle } from "@filen/shared/dom/scheduleIdle"
import { deviceProfile, refineDeviceProfile, type DeviceProfile, type Probe } from "@/lib/deviceProfile"
import { HEIC_PROBE_BASE64, JXL_PROBE_BASE64 } from "@/lib/imageProbeFixtures"

// Formats only a decode can tell this browser shows by itself.
export type NativeImageFormat = "heic" | "jxl"

const PROBES: Record<NativeImageFormat, { base64: string; type: string }> = {
	heic: { base64: HEIC_PROBE_BASE64, type: "image/heic" },
	jxl: { base64: JXL_PROBE_BASE64, type: "image/jxl" }
}

// A decode that has not answered by then counts as none.
const PROBE_TIMEOUT_MS = 3_000

const results = new Map<NativeImageFormat, Promise<boolean>>()

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(base64)

	return Uint8Array.from(binary, character => character.charCodeAt(0))
}

// Whether an <img> decodes `bytes`: never rejects, false on any failure or after the timeout.
async function decodes(bytes: Uint8Array<ArrayBuffer>, type: string): Promise<boolean> {
	if (typeof Image !== "function" || typeof HTMLImageElement.prototype.decode !== "function") {
		return false
	}

	const url = URL.createObjectURL(new Blob([bytes], { type }))
	const image = new Image()
	let timer: ReturnType<typeof setTimeout> | undefined

	image.src = url

	const timeout = new Promise<boolean>(resolve => {
		timer = setTimeout(() => {
			resolve(false)
		}, PROBE_TIMEOUT_MS)
	})
	const decoded = image.decode().then(
		() => image.naturalWidth > 0,
		() => false
	)
	const native = await Promise.race([decoded, timeout])

	clearTimeout(timer)
	image.src = ""
	URL.revokeObjectURL(url)

	return native
}

// Whether this browser shows `format` by itself: one decode of a few hundred bytes, once per tab.
export function supportsNativeImage(format: NativeImageFormat): Promise<boolean> {
	let result = results.get(format)

	if (result === undefined) {
		const probe = PROBES[format]

		result = decodes(bytesOf(probe.base64), probe.type).catch(() => false)
		results.set(format, result)
	}

	return result
}

function refined(format: NativeImageFormat, value: Probe): Partial<Pick<DeviceProfile, "heicNative" | "jxlNative">> {
	return format === "heic" ? { heicNative: value } : { jxlNative: value }
}

// supportsNativeImage, written into the device profile while it still says "unknown", so every gate and viewer
// reading the profile learns it.
export function probeNativeImage(format: NativeImageFormat): Promise<boolean> {
	return supportsNativeImage(format).then(native => {
		const current = format === "heic" ? deviceProfile().heicNative : deviceProfile().jxlNative

		if (current === "unknown") {
			refineDeviceProfile(refined(format, native ? "yes" : "no"))
		}

		return native
	})
}

// Starts both probes once the page is idle after its first paint. A viewer that needs an answer sooner awaits the
// same decode (probeNativeImage).
export function startNativeImageProbes(): void {
	scheduleIdle(
		() => {
			void probeNativeImage("heic")
			void probeNativeImage("jxl")
		},
		{ timeout: 5_000, fallbackMs: 1_000 }
	)
}
