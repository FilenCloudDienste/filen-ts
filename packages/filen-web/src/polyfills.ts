// Targeted polyfills only — each line lists its consumer.
// Buffer: @filen/utils parseFilenPublicLink + its serializer helpers.
import { Buffer } from "buffer"
;(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer
