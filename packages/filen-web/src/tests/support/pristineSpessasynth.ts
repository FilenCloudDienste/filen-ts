import { copyFileSync, cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// spessasynth_core as published, before the repository's patch: the installed (patched) build with the patch taken
// back out, so a test can hold the patch's behaviour against upstream's. The copy sits beside the installed one, where
// its own dependencies resolve, only while it is imported.

const PATCH = fileURLToPath(new URL("../../../../../patches/spessasynth_core@4.4.10.patch", import.meta.url))

export interface PristineMidi {
	tracks: { events: unknown[] }[]
}

export interface PristineSpessasynth {
	BasicMIDI: { fromArrayBuffer(buffer: ArrayBuffer): PristineMidi; maxEvents?: number }
}

export async function importPristineSpessasynth(): Promise<PristineSpessasynth> {
	const installed = realpathSync(fileURLToPath(new URL("../../../node_modules/spessasynth_core", import.meta.url)))
	const work = mkdtempSync(join(tmpdir(), "spessasynth-pristine-"))
	const target = join(installed, "dist", `.pristine-${String(process.pid)}.mjs`)

	try {
		cpSync(join(installed, "dist"), join(work, "dist"), { recursive: true })
		execFileSync("patch", ["-R", "-p1", "-s", "-d", work, "-i", PATCH])
		copyFileSync(join(work, "dist", "index.js"), target)

		return (await import(/* @vite-ignore */ pathToFileURL(target).href)) as PristineSpessasynth
	} finally {
		rmSync(work, { recursive: true, force: true })
		rmSync(target, { force: true })
	}
}
