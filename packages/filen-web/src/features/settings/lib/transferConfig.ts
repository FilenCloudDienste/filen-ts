import { type, type Type } from "arktype"
import type { JsClientConfig } from "@filen/sdk-rs"
import { kvPreference } from "@/lib/storage/preference"
import {
	DESKTOP_WEB_TRANSFER_PRESET_VALUES,
	FULL_CHUNK_BYTES,
	TRANSFER_PERFORMANCE_PRESETS,
	type TransferPerformancePreset,
	DEFAULT_TRANSFER_PERFORMANCE_PRESET
} from "@filen/shared"

// Advanced settings → transfer performance preset. Scoped to THIS web app's own uploads/downloads
// (the worker-held wasm Client every drive/notes/chats transfer runs through) — worded that way
// everywhere this reaches the UI, since the app also serves as the Electron frontend. In the desktop app the
// native host's sync client and its uploads/downloads client take their own preset and bandwidth limits from
// Settings › Desktop › Speed, applied live, on the same ladder as this one.
//
// A change applies at once: the worker sets it on the signed-in client through the wasm `Client`'s live
// setters (`setConcurrency`, `setFileIoMemoryBudget`, `setRequestRateLimit`; sdk.worker.ts's
// `applyTransferConfig`), and the service worker's download client is handed over again with it before the
// next download (features/drive/lib/saveDownload.ts).
//
// No bandwidth cap here: the wasm build compiles the SDK's bandwidth limiter out entirely, while
// concurrency, the file-IO memory budget and the request rate carry no such gate and are honored
// unconditionally.
//
// The preset NAMES come from @filen/shared, so a stored choice and its label mean the same on every
// client; the numbers behind them are DESKTOP_WEB_TRANSFER_PRESET_VALUES (@filen/shared), shared with the
// desktop shell. Mobile's ladder is held low by the iOS file-descriptor ceiling, which a browser tab does not have.

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

// The JsClientConfig fields a preset sets, every one present: what the client is built with at boot and
// what the worker's applyTransferConfig sets on the running client.
export interface TransferClientConfig {
	concurrency: number
	fileIoMemoryBudget: number
	rateLimitPerSec: number
}

// Pure preset -> JsClientConfig mapping, called from boot.ts (main thread, after the preference is
// read from kv) and from the settings row, and unit-tested without touching the worker or wasm at all.
export function buildJsClientConfig(prefs: TransferPreferences): TransferClientConfig {
	const { chunks, concurrency, rateLimitPerSec } = DESKTOP_WEB_TRANSFER_PRESET_VALUES[prefs.preset]

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
