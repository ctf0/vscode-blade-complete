import * as vscode from 'vscode'

export const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000)
statusBarItem.tooltip = 'Blade Parser'

const busyLabels = new Map<string, number>()

type IndexProgress = {
    indexed : number
    total   : number
}

let indexProgress: IndexProgress | undefined

function render(): void {
    if (indexProgress) {
        statusBarItem.text = `$(sync~spin) Blade: indexing ${indexProgress.indexed}/${indexProgress.total}`
        statusBarItem.show()

        return
    }

    let activeLabel: string | undefined

    for (const [label, count] of busyLabels) {
        if (count > 0) {
            activeLabel = label

            break
        }
    }

    if (activeLabel) {
        statusBarItem.text = `$(sync~spin) ${activeLabel}`
        statusBarItem.show()
    } else {
        statusBarItem.hide()
    }
}

export function setIndexProgress(indexed: number, total: number): void {
    indexProgress = {indexed, total}
    render()
}

export function clearIndexProgress(): void {
    if (indexProgress) {
        indexProgress = undefined
        render()
    }
}

export function showBusy(label: string): () => void {
    busyLabels.set(label, (busyLabels.get(label) ?? 0) + 1)

    render()

    let released = false

    return () => {
        if (released) {
            return
        }

        released = true

        const count = busyLabels.get(label) ?? 0

        if (count <= 1) {
            busyLabels.delete(label)
        } else {
            busyLabels.set(label, count - 1)
        }

        render()
    }
}
