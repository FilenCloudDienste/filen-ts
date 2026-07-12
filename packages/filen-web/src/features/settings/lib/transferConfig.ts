import { type, type Type } from "arktype"
import type { JsClientConfig } from "@filen/sdk-rs"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"

// Advanced settings → bandwidth caps + transfer performance preset. Scoped to THIS web app's own
// uploads/downloads (the worker-held wasm Client every drive/notes/chats transfer runs through) —
// worded that way everywhere this reaches the UI, since the app also serves as the Electron
// frontend and the desktop client's future file-sync/network-drive engine will carry its own,
// separate bandwidth/concurrency settings.
//
// The wasm `Client` exposes no live bandwidth/concurrency setter (unlike the RN uniffi client
// mobile builds against, which has `setBandwidthLimits`) — every one of these knobs is a
// `JsClientConfig` field `UnauthClient.from_config()` only reads at construction time. So a change
// here can only apply the next time the worker builds a client: at the next full page load (see
// sdk.worker.ts's `setClientConfig`/`clientConfig`), not live. The UI surfaces that as an
// info toast rather than pretending the change is immediate.
export const TRANSFER_PERFORMANCE_PRESETS = ["batterySaver", "balanced", "performance", "maximum"] as const

export type TransferPerformancePreset = (typeof TRANSFER_PERFORMANCE_PRESETS)[number]

export const DEFAULT_TRANSFER_PERFORMANCE_PRESET: TransferPerformancePreset = "balanced"

const MIB = 1024 * 1024

// concurrency = the SDK's global in-flight HTTP request cap; memoryMib = its file-IO chunk-buffer
// budget. Same ladder mobile's own advanced settings use (transferConfig.ts) — there is no
// web-specific constraint (no low iOS-style file-descriptor ceiling in a browser tab) that would
// argue for different numbers, and keeping them identical means the four preset names mean the
// same thing on every Filen client.
export const TRANSFER_PRESET_VALUES: Record<TransferPerformancePreset, { concurrency: number; memoryMib: number }> = {
	batterySaver: { concurrency: 4, memoryMib: 4 },
	balanced: { concurrency: 8, memoryMib: 8 },
	performance: { concurrency: 16, memoryMib: 16 },
	maximum: { concurrency: 32, memoryMib: 32 }
}

// 1 / 2 / 5 / 10 / 25 / 50 MB/s in KB/s (1024-based). `null` = unlimited.
export const TRANSFER_BANDWIDTH_PRESETS_KBPS: readonly number[] = [1024, 2048, 5120, 10240, 25600, 51200]

export function kbpsToMbLabel(kbps: number): string {
	return `${String(kbps / 1024)} MB/s`
}

export interface TransferPreferences {
	preset: TransferPerformancePreset
	uploadKbps: number | null
	downloadKbps: number | null
}

export const DEFAULT_TRANSFER_PREFERENCES: TransferPreferences = {
	preset: DEFAULT_TRANSFER_PERFORMANCE_PRESET,
	uploadKbps: null,
	downloadKbps: null
}

const TRANSFER_CONFIG_KV_KEY = "settings.transferConfig.v1"

const transferPreferencesSchema: Type<TransferPreferences> = type({
	preset: type.enumerated(...TRANSFER_PERFORMANCE_PRESETS),
	uploadKbps: "number | null",
	downloadKbps: "number | null"
})

// kvGetJson collapses "absent" and "schema-invalid" to null (see @/lib/storage/adapter); the `??`
// default is the self-heal, same rule as every other kv-backed preference in this app.
export async function getTransferPreferences(): Promise<TransferPreferences> {
	return (await kvGetJson(TRANSFER_CONFIG_KV_KEY, transferPreferencesSchema)) ?? DEFAULT_TRANSFER_PREFERENCES
}

export async function setTransferPreferences(next: TransferPreferences): Promise<void> {
	await kvSetJson(TRANSFER_CONFIG_KV_KEY, next)
}

// Pure preset -> JsClientConfig mapping, called from boot.ts (main thread, after the preference is
// read from kv) and unit-tested without touching the worker or wasm at all.
export function buildJsClientConfig(prefs: TransferPreferences): JsClientConfig {
	const { concurrency, memoryMib } = TRANSFER_PRESET_VALUES[prefs.preset]

	return {
		concurrency,
		fileIoMemoryBudget: memoryMib * MIB,
		uploadBandwidthKilobytesPerSec: prefs.uploadKbps ?? undefined,
		downloadBandwidthKilobytesPerSec: prefs.downloadKbps ?? undefined
	}
}
