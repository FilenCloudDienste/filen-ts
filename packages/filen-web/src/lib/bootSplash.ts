import { useLayoutEffect, useSyncExternalStore } from "react"
import { readSignedInHint } from "@/lib/signedInHint"

// Drives the static splash in index.html: it sits outside #root, so React never owns it. The bar has no
// real download progress to show; it steps through fixed targets as boot completes each phase.
export type BootSplashPhase = "bundle" | "engine" | "storage" | "session"

type PhaseTargets = Record<BootSplashPhase, number>

// A signed-out boot has no session to resume and no query cache to restore, so its weight sits earlier.
const SIGNED_IN_TARGETS: PhaseTargets = { bundle: 25, engine: 55, storage: 75, session: 90 }
const SIGNED_OUT_TARGETS: PhaseTargets = { bundle: 25, engine: 65, storage: 85, session: 90 }

export const BOOT_SPLASH_ID = "boot-splash"
// Matches the opacity transition in index.html.
const FADE_MS = 200

let node: HTMLElement | null | undefined
let targets: PhaseTargets | undefined
let progress = 0
let dismissed = false
const listeners = new Set<() => void>()

function splashNode(): HTMLElement | null {
	node ??= typeof document === "undefined" ? null : document.getElementById(BOOT_SPLASH_ID)

	return node
}

function render(splash: HTMLElement, value: number): void {
	splash.setAttribute("aria-valuenow", String(value))

	const fill = splash.lastElementChild?.firstElementChild

	if (fill instanceof HTMLElement) {
		fill.style.transform = `scaleX(${String(value / 100)})`
	}
}

// Monotonic: a phase reported late never moves the bar back.
export function advanceBootSplash(phase: BootSplashPhase): void {
	const splash = splashNode()

	if (splash === null || dismissed) {
		return
	}

	targets ??= readSignedInHint() ? SIGNED_IN_TARGETS : SIGNED_OUT_TARGETS

	const target = targets[phase]

	if (target <= progress) {
		return
	}

	progress = target
	render(splash, target)
}

// Idempotent. Fades over the screen that just committed beneath it, or goes at once under reduced motion.
export function dismissBootSplash(): void {
	if (dismissed) {
		return
	}

	dismissed = true

	const splash = splashNode()

	if (splash === null) {
		return
	}

	render(splash, 100)

	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
		splash.remove()
	} else {
		splash.classList.add("boot-splash-out")
		setTimeout(() => {
			splash.remove()
		}, FADE_MS)
	}

	for (const listener of listeners) {
		listener()
	}
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener)

	return () => {
		listeners.delete(listener)
	}
}

function isBootSplashShown(): boolean {
	return !dismissed && splashNode() !== null
}

// Whether the splash still covers the page, so the boot gate need not draw a loader of its own.
export function useBootSplashShown(): boolean {
	return useSyncExternalStore(subscribe, isBootSplashShown, () => false)
}

// For each first real screen. A layout effect runs before paint, so the screen is drawn the same frame the
// splash starts to go and nothing blank shows between them.
export function useDismissBootSplash(): void {
	useLayoutEffect(() => {
		dismissBootSplash()
	}, [])
}
