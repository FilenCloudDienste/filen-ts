import { useEffect } from "react"
import { create } from "zustand"
import { useShallow } from "zustand/shallow"
import { toast } from "sonner"
import { replaceEqualDeep } from "@tanstack/react-query"
import type {
	DesktopFileProvider,
	DesktopFileProviderErrorCode,
	DesktopFileProviderResult,
	DesktopFileProviderState
} from "@filen/shared/desktop"
import { desktopBridge } from "@/lib/desktop"
import { i18n } from "@/lib/i18n"
import { log } from "@/lib/log"
import {
	FILE_PROVIDER_ERROR_KEY,
	type FileProviderPending,
	type FileProviderStatus,
	fileProviderStatus,
	fileProviderSwitchLocked
} from "@/features/mounts/lib/fileProviderStatus.logic"

interface FileProviderStoreState {
	// The shell's latest answer; null until it answered, and always where Filen in Finder is unsupported.
	state: DesktopFileProviderState | null
	pending: FileProviderPending
	// The last failure: a switch's lasts until the next switch succeeds, a read's until the next read does.
	failure: { code: DesktopFileProviderErrorCode; read: boolean } | null
}

export const useFileProviderStore = create<FileProviderStoreState>(() => ({ state: null, pending: null, failure: null }))

// What a card, sidebar row or switch draws: primitives only, so an unrelated change re-renders nothing.
export function useFileProviderStatus(): { status: FileProviderStatus; enabled: boolean; locked: boolean } {
	return useFileProviderStore(
		useShallow(({ state, pending, failure }) => ({
			status: fileProviderStatus(state, pending, failure?.code ?? null),
			enabled: state?.enabled ?? false,
			locked: fileProviderSwitchLocked(state, pending)
		}))
	)
}

// The bridge's File Provider namespace, only where the shell supports it.
function fileProviderApi(): DesktopFileProvider | null {
	const fileProvider = desktopBridge()?.fileProvider

	return fileProvider?.supported === true ? fileProvider : null
}

function apply(state: DesktopFileProviderState): void {
	useFileProviderStore.setState(prev => ({ state: replaceEqualDeep(prev.state, state) }))
}

let reading: Promise<void> | null = null

// Reads the shell's state; a read already in flight is shared.
export function refreshFileProvider(): Promise<void> {
	const fileProvider = fileProviderApi()

	if (fileProvider === null) {
		return Promise.resolve()
	}

	reading ??= fileProvider
		.state()
		.then(
			state => {
				apply(state)

				if (useFileProviderStore.getState().failure?.read === true) {
					useFileProviderStore.setState({ failure: null })
				}
			},
			(error: unknown) => {
				log.warn("mounts", "file provider state could not be read", error)
				useFileProviderStore.setState(prev => ({ failure: prev.failure ?? { code: "unknown", read: true } }))
			}
		)
		.finally(() => {
			reading = null
		})

	return reading
}

function onFocus(): void {
	void refreshFileProvider()
}

// Follows the shell's state while the Mounts section is open: read on entry and whenever the window gains focus,
// which is when a switch flipped in System Settings can have changed. Nothing polls.
export function useFollowFileProvider(): void {
	useEffect(() => {
		if (fileProviderApi() === null) {
			return
		}

		void refreshFileProvider()
		window.addEventListener("focus", onFocus)

		return () => {
			window.removeEventListener("focus", onFocus)
		}
	}, [])
}

// A failed bridge call reads as `unknown`.
async function call<T>(run: () => Promise<DesktopFileProviderResult<T>>): Promise<DesktopFileProviderResult<T>> {
	try {
		return await run()
	} catch (error) {
		log.warn("mounts", "file provider bridge call failed", error)

		return { ok: false, error: { code: "unknown" } }
	}
}

export function fileProviderErrorLabel(code: DesktopFileProviderErrorCode): string {
	return i18n.t(`mounts:${FILE_PROVIDER_ERROR_KEY[code]}`)
}

// The one path every Filen in Finder switch takes. A failure stays on the card until the next switch succeeds; the
// state is read again after it, since the shell may have got halfway.
export async function setFileProviderEnabled(enabled: boolean): Promise<void> {
	const fileProvider = fileProviderApi()

	if (fileProvider === null || useFileProviderStore.getState().pending !== null) {
		return
	}

	useFileProviderStore.setState({ pending: enabled ? "enable" : "disable" })

	const result = await call(() => (enabled ? fileProvider.enable() : fileProvider.disable()))

	if (result.ok) {
		apply(result.value)
		useFileProviderStore.setState({ pending: null, failure: null })

		return
	}

	log.warn("mounts", "file provider could not be switched", result.error)
	useFileProviderStore.setState({ pending: null, failure: { code: result.error.code, read: false } })
	await refreshFileProvider()
}

// Opens the user's Filen directory in Finder; a failure is a toast.
export async function revealFileProvider(): Promise<void> {
	const fileProvider = fileProviderApi()

	if (fileProvider === null) {
		return
	}

	const result = await call(() => fileProvider.reveal())

	if (!result.ok) {
		toast.error(fileProviderErrorLabel(result.error.code))
	}
}

export function openFileProviderSettings(): void {
	fileProviderApi()
		?.openSettings()
		.catch((error: unknown) => {
			log.warn("mounts", "System Settings could not be opened", error)
		})
}
