// Centralized tunables — single source of truth for magic numbers used
// across the codebase. These are not user-configurable (use package.json
// contributes for that); they are internal tuning knobs.

// ---- Cache sizes ----
export const MAX_DIAGNOSTICS_ENTRIES = 50
export const MAX_COMPILATION_CACHE_SIZE = 500
export const MAX_RESULTS_CACHE_SIZE = 500
export const MAX_REFERENCE_BATCH_DOCUMENTS = 50

// ---- Compilation ----
export const MAX_COMPILE_FILE_SIZE = 200 * 1024 // 200KB
export const COMPILE_BATCH_SIZE = 50

// ---- Debounce timers (ms) ----
export const DIAGNOSTICS_REFRESH_DEBOUNCE_MS = 200
export const DIAGNOSTICS_WAIT_MS = 1000
export const DIAGNOSTICS_REPUBLISH_DEBOUNCE_MS = 150
export const SAVE_DEBOUNCE_MS = 150
export const COMPLETION_DEBOUNCE_MS = 50
export const RECOMPILE_DEBOUNCE_MS = 1000

// ---- I/O ----
export const CONCURRENT_READS = 64

// ---- Warnings ----
export const COMPILE_FAILURE_WARN_THRESHOLD = 3
export const COMPILE_FAILURE_REPEAT_INTERVAL = 10
export const PER_FILE_WARN_THROTTLE_MS = 30_000
export const TINKER_FAILURE_WARN_THRESHOLD = 3
