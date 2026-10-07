import { type, type Type } from "arktype"
import type { JsClientConfig } from "@filen/sdk-rs"
import { kvPreference } from "@/lib/storage/preference"
import { TRANSFER_PERFORMANCE_PRESETS, type TransferPerformancePreset, DEFAULT_TRANSFER_PERFORMANCE_PRESET } from "@filen/shared"

// Advanced settings → transfer performance preset. Scoped to THIS web app's own uploads/downloads
// (the worker-held wasm Client every drive/notes/chats transfer runs through) — worded that way
// everywhere this reaches the UI, since the app also serves as the Electron frontend and the desktop
// client's future file-sync/network-drive engine will carry its own, separate bandwidth/concurrency
// settings.
//
// The wasm `Client` exposes no live concurrency setter (unlike the RN uniffi client mobile builds
// against, which has `setBandwidthLimits`) — every one of these knobs is a `JsClientConfig` field
// `UnauthClient.from_config()` only reads at construction time. So a change here can only apply the
// next time the worker builds a client: at the next full page load (see sdk.worker.ts's
// `setClientConfig`/`clientConfig`), not live. The UI surfaces that as an
// info toast rather than pretending the change is immediate.
//
// No bandwidth cap here: the wasm build compiles the SDK's bandwidth limiter out entirely, while
// concurrency, the file-IO memory budget and the request rate carry no such gate and are honored
// unconditionally.
//
// The preset NAMES come from @filen/shared, so a stored choice and its label mean the same on every
// client; the numbers behind them are the web's own. Mobile's ladder is held low by the iOS
// file-descriptor ceiling, which a browser tab does not have.

// One full chunk as the SDK's file-IO budget counts it (FULL_CHUNK_BYTES: 1 MiB of data plus the
// 28-byte encryption overhead), so a budget of N of these buys exactly N chunks, not N - 1.
export const FULL_CHUNK_BYTES = 1024 * 1024 + 28

// chunks: the file-IO budget, in full chunks. concurrency: the global in-flight request cap, kept above
// the chunks so listings and thumbnails still get requests while transfers fill the budget.
// rateLimitPerSec: requests started per second across the whole client; the SDK's own 64 would cap
// transfers near 64 MiB/s on every preset above battery saver.
export const WEB_TRANSFER_PRESET_VALUES: Record<
	TransferPerformancePreset,
	{ chunks: number; concurrency: number; rateLimitPerSec: number }
> = {
	batterySaver: { chunks: 8, concurrency: 12, rateLimitPerSec: 64 },
	balanced: { chunks: 32, concurrency: 48, rateLimitPerSec: 160 },
	performance: { chunks: 64, concurrency: 96, rateLimitPerSec: 320 },
	maximum: { chunks: 128, concurrency: 160, rateLimitPerSec: 640 }
}

export interface TransferPreferences {
	preset: TransferPerformancePreset
}

export const DEFAULT_TRANSFER_PREFERENCES: TransferPreferences = {
	preset: DEFAULT_TRANSFER_PERFORMANCE_PRESET
}

const transferPreferencesSchema: Type<TransferPreferences> = type({
	preset: type.enumerated(...TRANSFER_PERFORMANCE_PRESETS)
})

export const { get: getTransferPreferences, set: setTransferPreferences } = kvPreference({
	key: "settings.transferConfig.v1",
	schema: transferPreferencesSchema,
	fallback: DEFAULT_TRANSFER_PREFERENCES
})

// Pure preset -> JsClientConfig mapping, called from boot.ts (main thread, after the preference is
// read from kv) and unit-tested without touching the worker or wasm at all.
export function buildJsClientConfig(prefs: TransferPreferences): JsClientConfig {
	const { chunks, concurrency, rateLimitPerSec } = WEB_TRANSFER_PRESET_VALUES[prefs.preset]

	return {
		concurrency,
		fileIoMemoryBudget: chunks * FULL_CHUNK_BYTES,
		rateLimitPerSec
	}
}

// The transfer config this page's client was built with, so the service worker's own client, which runs
// the downloads FSA cannot, gets the same one rather than a preset changed since this page loaded.
let appliedTransferConfig: JsClientConfig = buildJsClientConfig(DEFAULT_TRANSFER_PREFERENCES)

export function rememberAppliedTransferConfig(config: JsClientConfig): void {
	appliedTransferConfig = config
}

export function getAppliedTransferConfig(): JsClientConfig {
	return appliedTransferConfig
}
