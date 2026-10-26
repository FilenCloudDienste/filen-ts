import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Configuration, WindowsConfiguration } from "electron-builder"

// Everything here that installed 3.x clients can observe (appId, productName, artifact names, feed URL, install
// locations, Linux package name) is frozen: changing any of it stops the fleet from upgrading in place.

const packageDir = path.dirname(fileURLToPath(import.meta.url))
const archs: ("x64" | "arm64")[] = ["x64", "arm64"]
const publisher = "Filen Cloud Dienste UG (haftungsbeschränkt)"

/**
 * Electron 45's own LSMinimumSystemVersion. electron-updater compares the feed's minimumSystemVersion to os.release(),
 * i.e. the Darwin version (macOS 13 = Darwin 22), and electron-builder never writes it, so scripts/dist.ts injects it
 * into latest-mac.yml. Keep both in step when Electron raises its floor.
 */
export const macMinimum = { macos: "13.0", darwin: "22.0.0" } as const

const webDist = path.resolve(packageDir, process.env["FILEN_DESKTOP_WEB_DIST"] ?? "../filen-web/dist")

// A missing extraResources source is skipped silently, which would ship an app with nothing to serve.
if (!existsSync(path.join(webDist, "index.html"))) {
	throw new Error(`No web build at ${webDist}; build @filen/web or set FILEN_DESKTOP_WEB_DIST`)
}

// Only the non-secret account identifiers live in env so that local builds stay unsigned; the Azure credentials
// (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET) are read by the signer itself.
const azureEndpoint = process.env["AZURE_SIGNING_ENDPOINT"]
const azureAccount = process.env["AZURE_SIGNING_ACCOUNT"]
const azureProfile = process.env["AZURE_SIGNING_PROFILE"]
const azureSignOptions: WindowsConfiguration["azureSignOptions"] =
	azureEndpoint && azureAccount && azureProfile
		? {
				publisherName: publisher,
				endpoint: azureEndpoint,
				codeSigningAccountName: azureAccount,
				certificateProfileName: azureProfile,
				timestampRfc3161: "http://timestamp.acs.microsoft.com",
				timestampDigest: "SHA256",
				fileDigest: "SHA256"
			}
		: null

const config: Configuration = {
	appId: "io.filen.desktop",
	productName: "Filen",
	artifactName: "Filen_${os}_${arch}.${ext}",
	directories: {
		output: "release",
		buildResources: "build"
	},
	// Runtime dependencies are empty: esbuild bundles main and preload into dist.
	files: ["dist/**/*", "!dist/**/*.map", "package.json"],
	extraResources: [
		{ from: webDist, to: "web" },
		{ from: "build/tray", to: "tray" }
	],
	asar: true,
	npmRebuild: false,
	nodeGypRebuild: false,
	// No channel, and none derived from a prerelease version: a channel renames the feed manifests the installed
	// clients poll.
	publish: [{ provider: "generic", url: "https://cdn.filen.io/@filen/desktop/release/latest/" }],
	detectUpdateChannel: false,
	electronFuses: {
		runAsNode: false,
		enableNodeOptionsEnvironmentVariable: false,
		enableNodeCliInspectArguments: false,
		// One-way: disabling it later corrupts the cookie store.
		enableCookieEncryption: true,
		// Enforced on macOS and Windows only; Electron has no Linux implementation.
		enableEmbeddedAsarIntegrityValidation: true,
		onlyLoadAppFromAsar: true,
		// Flipping fuses breaks the bundle's ad-hoc signature; re-sign so unsigned local builds still launch on Apple
		// silicon. Real signing runs afterwards and replaces it.
		resetAdHocDarwinSignature: true
	},
	mac: {
		target: [
			{ target: "dmg", arch: archs },
			{ target: "zip", arch: archs }
		],
		category: "public.app-category.productivity",
		// An Icon Composer bundle; building it needs Xcode 26's actool.
		icon: "build/icons/mac/icon.icon",
		darkModeSupport: true,
		minimumSystemVersion: macMinimum.macos,
		hardenedRuntime: true,
		gatekeeperAssess: false,
		entitlements: "build/entitlements.mac.plist",
		entitlementsInherit: "build/entitlements.mac.plist",
		// Signing identity comes from CSC_LINK / CSC_KEY_PASSWORD (Developer ID, Team 7YTW5D2K7P, which the
		// installed apps' designated requirement pins); notarization from APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD /
		// APPLE_TEAM_ID or an App Store Connect API key, and is skipped without them.
		notarize: true
	},
	dmg: {
		sign: false
	},
	win: {
		target: [
			{ target: "nsis", arch: archs },
			{ target: "zip", arch: archs }
		],
		icon: "build/icons/win/icon.ico",
		azureSignOptions
	},
	nsis: {
		oneClick: false,
		perMachine: true,
		selectPerMachineByDefault: true,
		allowElevation: true,
		packElevateHelper: true,
		allowToChangeInstallationDirectory: false,
		runAfterFinish: true,
		createDesktopShortcut: true,
		createStartMenuShortcut: true,
		deleteAppDataOnUninstall: true,
		include: "build/installer.nsh"
	},
	linux: {
		target: [
			{ target: "deb", arch: archs },
			{ target: "rpm", arch: archs },
			{ target: "AppImage", arch: archs },
			{ target: "zip", arch: archs }
		],
		executableName: "Filen",
		icon: "build/icons/png",
		// The .desktop file follows package.json desktopName so it matches Electron's app_id / WM_CLASS.
		syncDesktopName: true,
		maintainer: publisher,
		vendor: publisher,
		category: "Utility",
		synopsis: "Filen Desktop Client",
		description: "Filen Desktop Client"
	},
	// electron-builder derives the package name from package.json name only when it is unscoped.
	deb: { packageName: "Filen" },
	rpm: { packageName: "Filen" },
	toolsets: {
		appimage: "1.0.3"
	}
}

export default config
