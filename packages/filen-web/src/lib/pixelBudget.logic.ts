// The pixel budget's arithmetic, apart from the device profile: a worker given workerDecodeBytes in its init message
// (pixelBudget.ts) works out its own figure for the bytes it holds.

// What remains of `budgetBytes` once `fileBytes` are held, at `bytesPerPixel` (the decoded frame plus every copy made of
// it).
export function pixelsWithin(budgetBytes: number, fileBytes: number, bytesPerPixel: number): number {
	return Math.max(0, Math.floor((budgetBytes - fileBytes) / bytesPerPixel))
}
