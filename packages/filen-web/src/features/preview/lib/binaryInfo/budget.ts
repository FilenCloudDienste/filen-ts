import { BLOCK_BYTES } from "@filen/shared/videos"
import type { BinarySource } from "@/features/preview/lib/binaryInfo/types"

// The header readers' whole budget for one file: the distinct 1 MiB blocks they may touch, the same blocks the byte
// reader fetches and keeps (four of them), so no read evicts another's block. A read reaching a block past the budget
// comes back cut where the allowed blocks end (empty when it starts past them), as a read past the end would.
export const BINARY_READ_BLOCKS = 4

export interface BudgetedSource extends BinarySource {
	// Distinct blocks touched so far.
	readonly blocksTouched: () => number
}

export function budgetedSource(source: BinarySource, blocks = BINARY_READ_BLOCKS): BudgetedSource {
	const touched = new Set<number>()

	return {
		size: source.size,
		blocksTouched: () => touched.size,
		read: (offset, length, signal) => {
			const start = Math.max(0, Math.min(offset, source.size))
			const end = Math.max(start, Math.min(source.size, start + Math.max(0, length)))
			let allowedEnd = start

			for (let block = Math.floor(start / BLOCK_BYTES); block * BLOCK_BYTES < end; block++) {
				if (!touched.has(block)) {
					if (touched.size >= blocks) break

					touched.add(block)
				}

				allowedEnd = Math.min(end, (block + 1) * BLOCK_BYTES)
			}

			return allowedEnd <= start ? Promise.resolve(new Uint8Array(0)) : source.read(start, allowedEnd - start, signal)
		}
	}
}
