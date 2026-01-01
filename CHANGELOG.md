# Changelog

## 0.2.4-alpha

### ⚡ Performance
- 🧠 Background: track “manga tabs” incrementally (no more full tab rescans on every event)
- 🚀 Host startup: de-dupe concurrent `ensureHostRunning()` calls in the MV3 service worker
- 📦 AI streaming: store one `ArrayBuffer` per result and slice chunks on-demand (less copying)

### 🧈 Smoothness
- 🧩 AI streaming: build the final `Blob` directly from streamed chunks (avoids extra full-buffer copies)
- 🕸️ Prefetch: keep short-lived references to prefetch `Image` objects (prevents early-GC request cancels on some browsers)
- 👀 Preload timing: slightly earlier “near viewport” window when preload slider > 0

### 🛡️ Stability / Compatibility
- 🧹 Cleanup: unobserve removed `<img>` nodes to keep `IntersectionObserver` bookkeeping clean on infinite-scroll readers
