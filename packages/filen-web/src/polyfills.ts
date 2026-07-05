// D8: targeted polyfills only — each line lists its consumer.
// Buffer: @filen/utils parseFilenPublicLink (slice 3) + its serializer helpers (T4).
import { Buffer } from "buffer"
;(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer
