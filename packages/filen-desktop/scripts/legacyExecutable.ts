import { lstatSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// 3.x up to 3.0.47 installed its Linux executable as /opt/Filen/@filendesktop, and its updater relaunches that path
// once it has installed the deb or rpm of 4.x. Both packages ship it as a link to the executable, so dpkg and rpm own
// it: an upgrade replaces the old executable with it, and an uninstall removes it. Shipped in no other target.

export const LEGACY_EXECUTABLE = "@filendesktop"
export const LINUX_INSTALL_DIR = "/opt/Filen"

export const legacyLinkDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "build", "linux", "opt")

// The fpm source mapping that merges the staged directory into the installed one.
export const legacyLinkFpmMapping = `${legacyLinkDir}/=${LINUX_INSTALL_DIR}`

/**
 * beforePack (Linux): stages the link for fpm. Relative, so it resolves inside the installed directory.
 */
export function stageLegacyExecutableLink(executable: string, dir: string = legacyLinkDir): void {
	const link = path.join(dir, LEGACY_EXECUTABLE)

	mkdirSync(dir, { recursive: true })
	// lstat: an earlier link dangles here, which rmSync with force takes for missing.
	if (lstatSync(link, { throwIfNoEntry: false }) !== undefined) {
		unlinkSync(link)
	}

	symlinkSync(executable, link)
}

// Whether a `dpkg-deb -c` or `rpm -qlpv` listing carries the link to the executable.
export function listsLegacyExecutableLink(listing: string, executable: string): boolean {
	return new RegExp(`^l\\S* .*[ .]${LINUX_INSTALL_DIR}/${LEGACY_EXECUTABLE} -> ${executable}$`, "m").test(listing)
}
