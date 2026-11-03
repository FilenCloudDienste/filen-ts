import { Bytes } from "./bytes"
import { convertMetafile } from "./index"
import { MAX_METAFILE_BYTES } from "./limits"
import { convertPict, isPict } from "./pict"
import { convertSvm, isSvm } from "./svm"
import type { MetafileConversion } from "./types"

// The metafiles only presentations hold: StarView (ODF object previews and pictures) and QuickDraw PICT (the Mac blips
// of .ppt files), beside EMF and WMF. A module of its own, so only the presentation renderer loads their players; the
// shared converter (index.ts) stays EMF and WMF.

// Converts an EMF, WMF (or a gzip-compressed one), SVM or PICT. Never throws.
export function convertPresentationMetafile(bytes: Uint8Array): MetafileConversion {
	const shared = convertMetafile(bytes)

	if (shared.ok || shared.reason !== "malformed" || bytes.length > MAX_METAFILE_BYTES) return shared

	const view = new Bytes(bytes)

	try {
		if (isSvm(view)) return convertSvm(view)
		if (isPict(view)) return convertPict(view)
	} catch {
		return { ok: false, reason: "failed" }
	}

	return shared
}
