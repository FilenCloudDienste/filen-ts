import { OCR_ENGINE_FACTORY } from "virtual:ocr-engine/simd-lstm"
import { serveOcrWorker } from "@/features/pdf/workers/ocrWorker"

// The OCR worker for browsers with SIMD but not relaxed SIMD (ocrWorker.ts).
serveOcrWorker("simd-lstm", OCR_ENGINE_FACTORY)
