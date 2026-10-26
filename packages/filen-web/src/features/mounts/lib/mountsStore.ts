import { useEffect, useState } from "react"
import { create } from "zustand"
import { replaceEqualDeep } from "@tanstack/react-query"
import type {
	DesktopDrive,
	DesktopMounts,
	DesktopMountsOverview,
	DesktopMountsRole,
	DesktopMountsRoleState,
	DesktopMountsStats,
	DesktopServe,
	DesktopServeProtocol,
	DesktopSyncHostState
} from "@filen/shared/desktop"
import { desktopBridge } from "@/lib/desktop"
import { log } from "@/lib/log"
import { aggregateMountsState, type MountsAggregate } from "@/features/mounts/lib/mountsStatus.logic"

interface MountsState {
	// The shell's latest overview; null until it answered, and always in a browser.
	overview: DesktopMountsOverview | null
}

// This page's mirror of the shell's mounts overview, structurally shared push to push like the sync store's, so a
// selector on the drive re-renders nothing while a server's state changes.
export const useMountsStore = create<MountsState>(() => ({ overview: null }))

function apply(overview: DesktopMountsOverview): void {
	useMountsStore.setState(state => ({ overview: replaceEqualDeep(state.overview, overview) }))
}

let loaded = false

// Starts following the shell's overview, once per page. Listening is what keeps the shell forwarding it.
export function loadMounts(): void {
	const mounts = desktopBridge()?.mounts

	if (mounts === undefined || loaded) {
		return
	}

	loaded = true
	mounts.onOverview(apply)

	// onOverview calls back right away only with an overview the preload already holds.
	mounts.overview().then(
		overview => {
			if (useMountsStore.getState().overview === null) {
				apply(overview)
			}
		},
		(error: unknown) => {
			log.warn("mounts", "overview could not be read", error)
		}
	)
}

// The bridge's mounts namespace. The Mounts section renders only with the bridge (its route redirects otherwise).
export function mountsApi(): DesktopMounts {
	const mounts = desktopBridge()?.mounts

	if (mounts === undefined) {
		throw new Error("Mounts need the desktop app")
	}

	return mounts
}

// Before a sign-out: true to go on. Outside the desktop app there is nothing to ask. A failed ask goes on, since the
// shell keeps a cache with pending uploads on sign-out either way.
export async function confirmMountsSignOut(): Promise<boolean> {
	const mounts = desktopBridge()?.mounts

	if (mounts === undefined) {
		return true
	}

	try {
		return await mounts.confirmSignOut()
	} catch (error) {
		log.warn("mounts", "sign-out confirm failed", error)

		return true
	}
}

export function useMountsHost(): DesktopSyncHostState | null {
	return useMountsStore(state => state.overview?.host ?? null)
}

export function useMountsDrive(): DesktopDrive | null {
	return useMountsStore(state => state.overview?.drive ?? null)
}

export function useMountsServe(protocol: DesktopServeProtocol): DesktopServe | null {
	return useMountsStore(state => state.overview?.serves.find(serve => serve.protocol === protocol) ?? null)
}

// null before the first overview, and for a protocol this platform does not offer.
export function useMountsRoleState(role: DesktopMountsRole): DesktopMountsRoleState | null {
	return useMountsStore(state => {
		const overview = state.overview

		if (overview === null) {
			return null
		}

		return role === "drive" ? overview.drive.state : (overview.serves.find(serve => serve.protocol === role)?.state ?? null)
	})
}

export function useMountsAggregate(): MountsAggregate | null {
	return useMountsStore(state => aggregateMountsState(state.overview))
}

// The drive's live transfers, followed only while `active` and the caller is mounted: the shell polls them only
// while some page listens.
export function useMountsStats(active: boolean): DesktopMountsStats | null {
	const [stats, setStats] = useState<DesktopMountsStats | null>(null)

	useEffect(() => {
		if (!active) {
			return
		}

		const mounts = mountsApi()
		let pushed = false
		let live = true
		const unsubscribe = mounts.onStats(next => {
			pushed = true
			setStats(next)
		})

		mounts.stats().then(
			first => {
				if (live && !pushed) {
					setStats(first)
				}
			},
			(error: unknown) => {
				log.warn("mounts", "stats could not be read", error)
			}
		)

		return () => {
			live = false
			unsubscribe()
		}
	}, [active])

	return active ? stats : null
}
