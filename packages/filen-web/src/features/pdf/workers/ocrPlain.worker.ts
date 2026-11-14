import { OCR_ENGINE_FACTORY } from "virtual:ocr-engine/lstm"
import { serveOcrWorker } from "@/features/pdf/workers/ocrWorker"

// The OCR worker for browsers without SIMD (ocrWorker.ts).
serveOcrWorker("lstm", OCR_ENGINE_FACTORY)
