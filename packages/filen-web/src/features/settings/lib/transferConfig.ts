import { type, type Type } from "arktype"
import type { JsClientConfig } from "@filen/sdk-rs"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"
import {
	TRANSFER_PERFORMANCE_PRESETS,
	type TransferPerformancePreset,
	DEFAULT_TRANSFER_PERFORMANCE_PRESET,
	TRANSFER_PRESET_VALUES
} from "@filen/shared"

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
// concurrency and the file-IO memory budget below carry no such gate and are honored unconditionally.
//
// The preset ladder itself (TRANSFER_PERFORMANCE_PRESETS / TRANSFER_PRESET_VALUES) lives in
// @filen/shared and is the same one mobile's advanced settings use — there is no web-specific
// constraint (no low iOS-style file-descriptor ceiling in a browser tab) that would argue for
// different numbers, and keeping them identical means the four preset names mean the same thing on
// every Filen client.
const MIB = 1024 * 1024

export interface TransferPreferences {
	preset: TransferPerformancePreset
}

export const DEFAULT_TRANSFER_PREFERENCES: TransferPreferences = {
	preset: DEFAULT_TRANSFER_PERFORMANCE_PRESET
}

const TRANSFER_CONFIG_KV_KEY = "settings.transferConfig.v1"

const transferPreferencesSchema: Type<TransferPreferences> = type({
	preset: type.enumerated(...TRANSFER_PERFORMANCE_PRESETS)
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
		fileIoMemoryBudget: memoryMib * MIB
	}
}
