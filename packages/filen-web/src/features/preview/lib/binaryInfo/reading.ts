import type { CmsSignerSummary } from "@filen/office/core/pdfsign"
import { budgetedSource } from "@/features/preview/lib/binaryInfo/budget"
import { readBinaryInfo } from "@/features/preview/lib/binaryInfo/read"
import type { BinaryInfo, BinarySource } from "@/features/preview/lib/binaryInfo/types"

// What the text-family worker answers for an executable or a disk image: its headers' facts and the signer its
// signature names. The signature's DER stays in the worker: a present one comes back with an empty array in its place.
export interface BinaryReading {
	readonly info: BinaryInfo | null
	readonly signer: CmsSignerSummary | null
}

const SENT_DER = new Uint8Array(0)

export async function readBinaryReading(
	source: BinarySource,
	name: string,
	signerOf: (der: Uint8Array) => CmsSignerSummary | null
): Promise<BinaryReading> {
	const info = await readBinaryInfo(budgetedSource(source), name)

	if (
		info === null ||
		(info.format !== "pe" && info.format !== "macho") ||
		info.signature.state !== "present" ||
		info.signature.der === null
	) {
		return { info, signer: null }
	}

	return { info: { ...info, signature: { state: "present", der: SENT_DER } }, signer: signerOf(info.signature.der) }
}
