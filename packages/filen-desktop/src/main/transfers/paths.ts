import path from "node:path"
import type { DesktopTransferKind } from "@filen/shared/desktop"
import { keepBothName } from "@filen/shared/localName"

// Past this many taken names something else is wrong; nothing loops forever.
const MAX_CANDIDATES = 10_000

// The first keep-both name in `dir` that `taken` does not refuse ("a.txt", "a (1).txt", …). `taken` may claim the
// candidate it answers false for, so two downloads picking names at once never get the same one.
export async function freeTarget(
	dir: string,
	name: string,
	kind: DesktopTransferKind,
	taken: (path: string) => Promise<boolean>
): Promise<string> {
	for (let n = 0; n < MAX_CANDIDATES; n++) {
		const candidate = path.join(dir, keepBothName(name, n, kind))

		if (!(await taken(candidate))) {
			return candidate
		}
	}

	throw new Error(`no free name for ${path.join(dir, name)}`)
}
