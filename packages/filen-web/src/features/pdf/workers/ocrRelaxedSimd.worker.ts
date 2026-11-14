import { OCR_ENGINE_FACTORY } from "virtual:ocr-engine/relaxedsimd-lstm"
import { serveOcrWorker } from "@/features/pdf/workers/ocrWorker"

// The OCR worker for browsers with relaxed SIMD (ocrWorker.ts).
serveOcrWorker("relaxedsimd-lstm", OCR_ENGINE_FACTORY)
