import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { MacPackager, type AfterPackContext } from "electron-builder"

// The Developer ID team the installed apps' designated requirement pins.
export const MAC_TEAM = "7YTW5D2K7P"

const entitlements = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "build", "entitlements.rclone.plist")

function codesignIdentity(keychain: string | null): string | null {
	const args = ["find-identity", "-v", "-p", "codesigning"]

	if (keychain !== null) {
		args.push(keychain)
	}

	const listing = spawnSync("/usr/bin/security", args, { encoding: "utf8" })

	if (listing.status !== 0) {
		throw new Error(`security find-identity failed: ${listing.stderr.trim()}`)
	}

	return (
		new RegExp(`^\\s*\\d+\\)\\s+([0-9A-F]{40})\\s+"Developer ID Application: .*\\(${MAC_TEAM}\\)"$`, "m").exec(listing.stdout)?.[1] ??
		null
	)
}

/**
 * afterPack (macOS): signs the bundled rclone with the team's Developer ID, the hardened runtime, a secure timestamp
 * and its own entitlements (only disable-library-validation, which cmount's dlopen of macFUSE's libfuse needs). The
 * app's signing skips it (mac.signIgnore), since it would re-sign it with the app's inherited entitlements. Skipped
 * where electron-builder does not sign either: no identity of the team, or discovery disabled without CSC_NAME; such
 * builds keep the release's own signature, and `checkPackage --signed` refuses them.
 */
export async function signRclone(context: AfterPackContext): Promise<void> {
	if (context.electronPlatformName !== "darwin" || !(context.packager instanceof MacPackager)) {
		return
	}

	const file = path.join(
		context.appOutDir,
		`${context.packager.appInfo.productFilename}.app`,
		"Contents",
		"Resources",
		"rclone",
		"rclone"
	)

	if (process.env["CSC_IDENTITY_AUTO_DISCOVERY"] === "false" && !process.env["CSC_NAME"]) {
		console.log(`signRclone: code signing disabled; ${file} left as released`)

		return
	}

	// The keychain electron-builder imported CSC_LINK into, else the default search list.
	const keychain = (await context.packager.codeSigningInfo.value).keychainFile ?? null
	const identity = codesignIdentity(keychain)

	if (identity === null) {
		console.log(`signRclone: no Developer ID Application identity of team ${MAC_TEAM}; ${file} left as released`)

		return
	}

	// The release is linker-signed as "a.out"; the identifier names it in the team's signature.
	const args = [
		"--force",
		"--sign",
		identity,
		"--identifier",
		"io.filen.desktop.rclone",
		"--options",
		"runtime",
		"--timestamp",
		"--entitlements",
		entitlements
	]

	if (keychain !== null) {
		args.push("--keychain", keychain)
	}

	const signed = spawnSync("/usr/bin/codesign", [...args, file], { encoding: "utf8" })

	if (signed.status !== 0) {
		throw new Error(`codesign ${file} failed: ${signed.stderr.trim()}`)
	}

	console.log(`signRclone: signed ${file}`)
}
