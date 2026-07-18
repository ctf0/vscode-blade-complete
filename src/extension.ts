import * as vscode from 'vscode'
import {activateIntelephense, waitForIntelephense} from './libs/php/intelephense'
import {extendMarkdownIt} from './parsers/markdown'
import {BLADE_SELECTOR} from './libs/core/utils'
import {DefinitionProvider} from './providers/definition'
import {HoverProvider} from './providers/hover'
import {CompletionProvider} from './providers/completion'
import {ReferenceProvider, registerPhpReferenceProvider} from './providers/reference'
import {activate as activateSymbolProvider} from './providers/symbol'
import {CodeLensProvider} from './providers/codelens'
import {CodeActionProvider} from './providers/code-action'
import {DocumentLinkProvider} from './providers/document-link'
import {registerPhpCodeLensProvider} from './providers/php-codelens'
import {registerRenameProvider} from './providers/rename'
import {handleSave} from './events/on-save'
import {initDiagnostics, refreshAllOpenBlades} from './libs/blade/diagnostics'
import {handleChange} from './events/on-change'
import {handleClose} from './events/on-close'
import {handleFileRename} from './events/on-file-rename'
import {debugLog, debugOutputChannel, dispose as disposeDebugOutput} from './libs/core/debug'
import {openCompiledPath} from './libs/commands'
import {cleanupStaleCompiledFiles, initCompiledDir, startupCompileWorkspace} from './libs/compiler/compiled'
import {statusBarItem} from './libs/core/status'
import {activateLaravelGotoView, waitForLaravelGotoView, invalidateViewPhpDocBlocksCache} from './libs/blade/view-data'
import {removeAllCompiledFiles} from './libs/compiler/manifest'
import {requestCodeLensRefresh, dispose as disposeRefresh} from './libs/core/codelens-refresh'
import {dispose as disposeHtml} from './libs/blade/html'

async function reindexWorkspace(): Promise<void> {
    await removeAllCompiledFiles()
    invalidateViewPhpDocBlocksCache()
    await startupCompileWorkspace()
    refreshAllOpenBlades()
}

export async function activate(context: vscode.ExtensionContext) {
    initCompiledDir(context)

    context.subscriptions.push(
        statusBarItem,
    )

    const hasWorkspace = Boolean(vscode.workspace.workspaceFolders?.length)

    if (!hasWorkspace) {
        return vscode.window.showWarningMessage('No workspace folder found. Extension features won\'t work without a workspace.')
    }

    void (async() => {
        try {
            await cleanupStaleCompiledFiles()
            await Promise.all([
                activateIntelephense(),
                activateLaravelGotoView(),
            ])
            await Promise.all([
                waitForIntelephense(),
                waitForLaravelGotoView(),
            ])
            initDiagnostics(context)
            void startupCompileWorkspace()

            context.subscriptions.push(
                vscode.commands.registerCommand('bladeComplete.openCompiledPath', async(document) => await openCompiledPath(document)),
                vscode.commands.registerCommand('bladeComplete.indexWorkspace', () => reindexWorkspace()),

                /* Providers ---------------------------------------------------------------- */
                registerRenameProvider(),
                registerPhpReferenceProvider(),
                registerPhpCodeLensProvider(),
                vscode.languages.registerHoverProvider(BLADE_SELECTOR, new HoverProvider()),
                vscode.languages.registerCompletionItemProvider(BLADE_SELECTOR, new CompletionProvider(), '>', ':'),
                vscode.languages.registerReferenceProvider(BLADE_SELECTOR, new ReferenceProvider()),
                vscode.languages.registerCodeLensProvider(BLADE_SELECTOR, new CodeLensProvider()),
                vscode.languages.registerDefinitionProvider(BLADE_SELECTOR, new DefinitionProvider()),
                vscode.languages.registerDocumentLinkProvider(BLADE_SELECTOR, new DocumentLinkProvider()),
                vscode.languages.registerCodeActionsProvider(BLADE_SELECTOR, new CodeActionProvider()),

                /* Events ------------------------------------------------------------------- */
                vscode.workspace.onDidRenameFiles(handleFileRename),
                vscode.workspace.onDidSaveTextDocument(handleSave),
                vscode.workspace.onDidChangeTextDocument(handleChange),
                vscode.workspace.onDidCloseTextDocument(handleClose),
                vscode.workspace.onDidChangeConfiguration((event) => {
                    if (event.affectsConfiguration('bladeComplete.showCodeLens')) {
                        requestCodeLensRefresh()
                    }

                    if (
                        event.affectsConfiguration('bladeComplete.phpDefaultImports')
                        || event.affectsConfiguration('bladeComplete.phpDocBlocks')
                        || event.affectsConfiguration('bladeComplete.referenceDirectives')
                    ) {
                        void reindexWorkspace()
                    }
                }),
                activateSymbolProvider(BLADE_SELECTOR),
            )
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            debugLog(`activation failed: ${message}`)
            void vscode.window.showErrorMessage(
                `Blade Complete: activation failed. Some features may not work. Check the "Blade Complete" output channel for details.`,
                'Open Output',
            ).then((action) => {
                if (action === 'Open Output') {
                    debugOutputChannel.show()
                }
            })
        }
    })()

    return {extendMarkdownIt}
}

export async function deactivate() {
    disposeRefresh()
    disposeHtml()
    disposeDebugOutput()
}
