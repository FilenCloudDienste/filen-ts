import type { DesktopSyncHostState } from "@filen/shared/desktop"

// The banner keys for the one native host Sync and Mounts share; each section's catalog words them its own way.
export type HostBannerKey =
	"hostStarting" | "hostRestarting" | "hostCrashLoop" | "hostAddonMissing" | "hostBaselineInUse" | "hostKeychainLocked"

// What the host banner says, and whether it offers retryHost. null: nothing worth a banner.
export function hostBanner(host: DesktopSyncHostState): { key: HostBannerKey; retry: boolean; tone: "info" | "warning" } | null {
	switch (host.state) {
		case "off":
		case "running":
			return null
		case "starting":
			return { key: "hostStarting", retry: false, tone: "info" }
		case "restarting":
			return { key: "hostRestarting", retry: false, tone: "warning" }
		case "failed":
			switch (host.reason) {
				case "crashLoop":
					return { key: "hostCrashLoop", retry: true, tone: "warning" }
				case "addonMissing":
					return { key: "hostAddonMissing", retry: true, tone: "warning" }
				case "baselineInUse":
					return { key: "hostBaselineInUse", retry: true, tone: "warning" }
				case "keychainLocked":
					return { key: "hostKeychainLocked", retry: true, tone: "warning" }
			}
	}
}
