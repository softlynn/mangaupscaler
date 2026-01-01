# Changelog

## 0.2.4-alpha

### ⚡ Performance
- 🧠 Background: track “manga tabs” incrementally (no more full tab rescans on every event)
- 🚀 Host startup: de-dupe concurrent `ensureHostRunning()` calls in the MV3 service worker
- 📦 AI streaming: store one `ArrayBuffer` per result and slice chunks on-demand (less copying)
- 🔁 Model switching: cache multiple engines + prewarm common models to reduce slowdowns when flipping color ↔ B/W pages

### 🧈 Smoothness
- 🧩 AI streaming: build the final `Blob` directly from streamed chunks (avoids extra full-buffer copies)
- 🕸️ Prefetch: keep short-lived references to prefetch `Image` objects (prevents early-GC request cancels on some browsers)
- 👀 Preload timing: swap cached AI panels earlier (before they become visible) to avoid “pop-in” flicker
- 🖼️ Page priming: start loading upcoming *original* page panels earlier (reduces visible load/flicker on scroll)
- 🧠 Decode-first swap: pre-decode cached `blob:` URLs before swapping into the page (reduces brief blank frames)
- 🎯 WeebCentral: nudge auto-enhance more often so the next visible panel gets enhanced even when only 1–2 panels are in DOM
- 📊 Status UI: show `AI cached`, `Page loaded`, and `Page requested` (clearer than “enhanced/page ready”)

### 🛡️ Stability / Compatibility
- 🧹 Cleanup: unobserve removed `<img>` nodes to keep `IntersectionObserver` bookkeeping clean on infinite-scroll readers
