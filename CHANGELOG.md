# Changelog

## 0.2.4-alpha
- Performance: reduce background overhead by incrementally tracking “manga tabs” instead of rescanning all tabs on every event.
- Performance: de-duplicate concurrent host startup/health checks in the MV3 service worker.
- Performance: lower AI stream memory churn by storing a single buffer and slicing per chunk.
- Smoothness: build AI result `Blob`s directly from streamed chunks (avoids extra full-buffer copies).
- Smoothness: make page prefetch more reliable by holding a short-lived reference to prefetch `Image` objects (avoids early GC canceling requests on some browsers).
- Stability: unobserve removed `<img>` nodes to keep `IntersectionObserver` bookkeeping clean on infinite-scroll readers.

