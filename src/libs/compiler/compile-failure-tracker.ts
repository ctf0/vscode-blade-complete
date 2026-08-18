import * as vscode from 'vscode'
import path from 'path'
import {debugLog, debugOutputChannel} from '../core/debug'
import {
    COMPILE_FAILURE_WARN_THRESHOLD,
    COMPILE_FAILURE_REPEAT_INTERVAL,
    PER_FILE_WARN_THROTTLE_MS,
} from '../core/constants'

const warnedLargeFiles = new Set<string>()
let compileFailureCount = 0

// Per-file failure tracking: a single broken blade file should not cause
// all language features to silently fail. Track failures per file so the
// status bar can show which file is broken, and throttle repeated warnings.
const perFileFailures = new Map<string, {count: number, lastWarned: number}>()

export function warnIfTooLarge(uri: string, fsPath: string, length: number): void {
    if (warnedLargeFiles.has(uri)) {
        return
    }

    warnedLargeFiles.add(uri)
    void vscode.window.showWarningMessage(
        `"${path.basename(fsPath)}" is too large (${(length / 1024).toFixed(0)}KB). extension support is disabled for this file.`,
    )
}

function shouldWarnCompileFailure(): boolean {
    return compileFailureCount === COMPILE_FAILURE_WARN_THRESHOLD
      || (compileFailureCount > COMPILE_FAILURE_WARN_THRESHOLD
        && (compileFailureCount - COMPILE_FAILURE_WARN_THRESHOLD) % COMPILE_FAILURE_REPEAT_INTERVAL === 0)
}

function showOpenOutputWarning(message: string): void {
    void vscode.window.showWarningMessage(message, 'Open Output').then((action) => {
        if (action === 'Open Output') {
            debugOutputChannel.show()
        }
    })
}

export function warnCompileFailure(message: string): void {
    compileFailureCount++

    if (shouldWarnCompileFailure()) {
        showOpenOutputWarning(
            `PHP compilation is failing (${compileFailureCount} failures). Check the "Blade Complete" output channel for details.`,
        )
    }
}

export function resetCompileFailureCount(): void {
    compileFailureCount = 0
}

function trackPerFileCompileFailure(fsPath: string): boolean {
    const now = Date.now()
    const entry = perFileFailures.get(fsPath) ?? {count: 0, lastWarned: 0}
    entry.count++

    if (now - entry.lastWarned < PER_FILE_WARN_THROTTLE_MS) {
        perFileFailures.set(fsPath, entry)

        return false
    }

    entry.lastWarned = now
    perFileFailures.set(fsPath, entry)

    return true
}

export function warnPerFileCompileFailure(fsPath: string): void {
    if (!trackPerFileCompileFailure(fsPath)) {
        return
    }
}

export function clearPerFileCompileFailure(fsPath: string): void {
    perFileFailures.delete(fsPath)
}
