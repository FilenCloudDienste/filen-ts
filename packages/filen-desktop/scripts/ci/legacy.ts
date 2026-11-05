// The last 3.x release, which every installed client runs before it updates to 4.x. Its installers come from the old
// repository's GitHub release (the same files cdn.filen.io served as the 3.0.53 feed); the sha512 values are copied
// from that release's latest*.yml, so a replaced or corrupted download fails instead of being tested.
//
// 3.0.53 carries its own CI hook (filen-desktop src/lib/updater.ts): FILEN_E2E_UPDATER=1 with a loopback
// FILEN_E2E_UPDATE_FEED makes it check that feed right after start and install a downloaded update without the user's
// click, once per FILEN_E2E_ONCE_FILE. Its log is <appData>/@filen/logs/desktop.log.

export const LEGACY_VERSION = "3.0.53"
export const LEGACY_RELEASE_URL = "https://github.com/FilenCloudDienste/filen-desktop/releases/download/v3.0.53/"
export const LEGACY_E2E_BANNER = "Updater E2E mode enabled"

export const LEGACY_SHA512: Readonly<Record<string, string>> = {
	"Filen_win.exe": "5ze1QM+l9QGKd2T6liM31PDKtXkmhp2OKifK+gelWpnnAoa6470mzhKk0/ldL8fkhBTMVjY13JoNObQrovejqg==",
	"Filen_mac_x64.dmg": "3EXv/+dPxWx+UcN1meCvE+cgvWFYRXCOdeBRrJOYQwI9/y0mrY2xFJkA22lea3M12L3DACkAYevp4w10uJxujg==",
	"Filen_mac_arm64.dmg": "gsi6ZSs6WuZA5jBadrXkB9QaIgTIA0KX9nPxYbZ9skKTpCG+MZHvpJC5gp4kd1TPEFRQRq1cWwZ6NK77fyremw==",
	"Filen_linux_x86_64.AppImage": "eAATu6IpTjNVUBkjDjxTI7GV+Km5XtJGz3pzGq9ZyVx/r6whwWG1iLXgMc+fMV0hdat9ugnib/QPwAkMTTETrA==",
	"Filen_linux_arm64.AppImage": "yP+941V+NN8+M2Y+r3m/Elj5cf6anf/qVaTM9YXRhe/1m/Ja4SsYIIGBkqYys41eSMvuup+BJItVOFl0cqPmxA==",
	"Filen_linux_amd64.deb": "8ONvTj+wSKWpEsOipgq+txwXR1rsNeaMRYGCCi4av5vOB2AcCQ69DUjbLIeHyExvNlTtXmbrS4VTA0TRzWJClA==",
	"Filen_linux_arm64.deb": "PYH8L3uKpzg6iX2bF/hv/8au5PpWIYWkoTlXx0K2q9oo0zwyY5io3pGPA4aQ3PZyRoKqG1pcXDBXD67Yl09tPA==",
	"Filen_linux_x86_64.rpm": "6/8jHYz1rhbhU+6npysJVIlda4Szuu3Yr3hJT8hlX9r4vrOTZ1wSTb239vLduIhST9nIFfNrXUuhcabKyT2/qg==",
	"Filen_linux_aarch64.rpm": "R9LhkuWZnEuvJOTgIODyKVbM9+awkVBokTrfgMkMIN92vhNDZUSqLqCwUhs8Jd1Rn8xbbryGh0xvmc8eh2c2Cw=="
}

// Every old release the e2e tests install, by scenario: chain L's 3.0.53, and 3.0.47 (gap 1), an older 3.x that still
// updates straight to 4.x (the feed has no channel). Each is pinned the same way: its old repository's release, the
// installers' sha512 from that release's latest*.yml. What differs between them is what the harness has to make up
// for: 3.0.47 has no E2E hook (its update launch gets one through its Node inspector, scripts/ci/e2e/legacyHook.ts),
// installs its Linux executable as @filendesktop (4.x's deb and rpm ship that name as a link, scripts/legacyExecutable.ts),
// asks for root on Linux through pkexec and nothing else (electron-updater 6.5.0 has no sudo fallback), and its JS SDK
// (@filen/sdk 0.1.193) signs in to auth v1 and v2 accounts only.
export interface LegacyPin {
	version: string
	// The release's date (UTC).
	released: string
	releaseUrl: string
	// Installer name (Target.installer) -> sha512 from the release's latest*.yml.
	sha512: Readonly<Record<string, string>>
	// FILEN_E2E_UPDATER and its banner (LEGACY_E2E_BANNER); without it the update launch is hooked from outside.
	hasE2eHook: boolean
	// The deb's and rpm's executable, which its updater relaunches after installing 4.x.
	linuxExecutable: string
	// The auth versions its SDK can sign in to.
	authVersions: readonly number[]
	// Its Linux updater finds root through gksudo, kdesudo, pkexec or beesu only (no sudo fallback).
	linuxNeedsPrompt: boolean
	// Its sync carries 0-byte files. @filen/sync before 0.3.1 (3.0.47 ships 0.1.101) leaves them out of both trees
	// (ignored, reason "empty"), so they stay on the side they were made on.
	syncsEmptyFiles: boolean
	// How a user quits it. 3.0.53's tray Exit runs app.quit(), whose before-quit lets the window close and will-quit
	// stops the sync worker and rclone. 3.0.47 cancels app.quit() while minimize to tray is on (its window's close
	// handler minimizes instead and nothing marks the quit), and every quit it offers (the tray's Exit, the last window
	// closing) is app.exit(0), which ends the worker with the process; rclone's monitor follows the process out (not on
	// Windows: winRcloneOutlivesExit).
	quit: LegacyQuit
	// On Windows its rclone outlives app.exit(0), the drive mounted: @filen/network-drive 0.9.x starts rclone and its
	// monitor script through cmd.exe, which libuv puts in the job object that dies with the app; rclone and the monitor's
	// PowerShell wait, the grandchildren, break away silently, and the monitor's taskkill never runs. The app's next start
	// with the drive on (its network drive's start ends every rclone by name) or a sign-out of Windows ends it.
	winRcloneOutlivesExit: boolean
	// What it leaves beside userData that N does not delete, by name. 3.0.47's @filen/network-drive downloads its rclone
	// into its platformConfigPath() (`<appData>/@filen/network-drive`), and its @filen/s3 and @filen/webdav create theirs
	// as their modules load (`s3`, `webdav`: certificates once HTTPS ran, tempDiskFiles), directories @filen/cli shares.
	besideUserData: readonly string[]
}

export type LegacyQuit = "app.quit()" | "app.exit(0)"

export const LEGACY_PIN: LegacyPin = {
	version: LEGACY_VERSION,
	released: "2026-07-21",
	releaseUrl: LEGACY_RELEASE_URL,
	sha512: LEGACY_SHA512,
	hasE2eHook: true,
	linuxExecutable: "/opt/Filen/Filen",
	authVersions: [1, 2, 3],
	linuxNeedsPrompt: false,
	syncsEmptyFiles: true,
	quit: "app.quit()",
	winRcloneOutlivesExit: false,
	besideUserData: []
}

export const OLDER_PIN: LegacyPin = {
	version: "3.0.47",
	released: "2025-02-09",
	releaseUrl: "https://github.com/FilenCloudDienste/filen-desktop/releases/download/v3.0.47/",
	sha512: {
		"Filen_win.exe": "m9E/LxzyXIypnyvRPLxFOt45BJLNWY6CZTIc2ycNqR/ZaSPR3Y7lZ9PRzNrPlgUTlA8ySqKZbyCgkypsRdoqUg==",
		"Filen_mac_x64.dmg": "yNODSCALCvYK3uXevvatfpQzxHtkBRuD5Dc5hQZsS+d8HsK+rT8CjUV9Dv+BHh/MzDFH3ar0ZMXJvza0nyjdIw==",
		"Filen_mac_arm64.dmg": "0uu2Wa5ofRXLMByUCGnZGnZlYDM2jw21eloDRZXXkdMN/hLhLV+75LIjGdzN+p7iAbXS9fc6gcGDPz5D7s8F8Q==",
		"Filen_linux_x86_64.AppImage": "tvZ9mZ8KEaiFv1peIAgyElP1IAk+zQO3VHLavD3C/QKpSkHcAPhLV7Lmnjcal9uq8bEuyOis6eEMVpWvkMy6Ug==",
		"Filen_linux_arm64.AppImage": "xaUt4TSlD5ykyrRHCsvhY7a9YqD2XkLEnqsEYtXdC1iKQAST9Da+z0rQ+cqL6yTTwUVoZcwjuW3uKdYSL6v+gw==",
		"Filen_linux_amd64.deb": "ZC4K8CrAQDn/DgWwhBf+lVRKO+pTZILX9rigZDTc6mPDNHMa/meuaeEABS33jOW5V3vCJM0C7e835HewzySPYw==",
		"Filen_linux_arm64.deb": "EFPiCX2EW8/n8bKqvsMAdKDNDGDMkN+TASll3o3l47piLLMDBRK9F9/T+FqHSCimZ1tcGJ7LJtGs+Bob8ZOpIg==",
		"Filen_linux_x86_64.rpm": "mIVP4BYgbWe7z35MLCGqZtgLPDiRlbStLJajjKffa3APXFXv1HDnOsSRZOXhB2KhjAs109+oAVGw2fDAEubVJg==",
		"Filen_linux_aarch64.rpm": "LA+HcabSaHoyfmqCozD3KarX1T8buptiEWs7WLN9YJe34PczmJm3PCCg4rxc5QKCxId+uhKAOa1taGOGsWedtg=="
	},
	hasE2eHook: false,
	linuxExecutable: "/opt/Filen/@filendesktop",
	authVersions: [1, 2],
	linuxNeedsPrompt: true,
	syncsEmptyFiles: false,
	quit: "app.exit(0)",
	winRcloneOutlivesExit: true,
	besideUserData: ["network-drive", "s3", "webdav"]
}

// The update scenarios that start from an old release, by name (scripts/ci/e2e.ts --scenario).
export const PINS = { legacy: LEGACY_PIN, older: OLDER_PIN } as const

export type PinnedScenario = keyof typeof PINS

export function pinFor(scenario: string): LegacyPin | null {
	return Object.hasOwn(PINS, scenario) ? PINS[scenario as PinnedScenario] : null
}

// The old clients a run signs in or seeds (`pins`: their versions, comma-separated) against the account's auth version,
// checked on the run's session before any of them is launched: a login one of them cannot make proves nothing and costs
// the budget. 3.0.47's signed-in chain is dropped (`dropOlder`, with a notice) and the rest of the run goes on, its
// install-only update included; any other old client that cannot sign in is a `problem` that fails the run.
export function authVersionCheck(authVersion: number, pins: string): { dropOlder: string | null; problem: string | null } {
	const refusing = Object.values(PINS).filter(
		pin => pins.split(",").some(item => item.trim() === pin.version) && !pin.authVersions.includes(authVersion)
	)
	const others = refusing.filter(pin => pin !== OLDER_PIN)
	const only = (pin: LegacyPin) => `${pin.version} (v${pin.authVersions.join(", v")} only)`

	return {
		dropOlder: refusing.includes(OLDER_PIN)
			? `the test account uses auth v${String(authVersion)}, which ${only(OLDER_PIN)} cannot sign in to: its signed-in chain is dropped from this run, its install-only update runs instead`
			: null,
		problem:
			others.length === 0
				? null
				: `the test account uses auth v${String(authVersion)}, which ${others.map(only).join(" and ")} cannot sign in to: drop that scenario or use an account it can`
	}
}
