import * as vscode from 'vscode'
import {activateIntelephense, waitForIntelephense} from './libs/intelephense'
import {extendMarkdownIt} from './parsers/markdown'
import {setIntelephenseConfig, BLADE_SELECTOR} from './libs/utils'
import {DefinitionProvider} from './providers/definition'
import {HoverProvider} from './providers/hover'
import {CompletionProvider} from './providers/completion'
import {ReferenceProvider, registerPhpReferenceProvider} from './providers/reference'
import {activate as activateSymbolProvider} from './providers/symbol'
import {CodeLensProvider} from './providers/codelens'
import {DocumentLinkProvider} from './providers/document-link'
import {registerPhpCodeLensProvider} from './providers/php-codelens'
import {registerRenameProvider} from './providers/rename'
import {handleSave} from './events/on-save'
import {initDiagnostics, refreshAllOpenBlades} from './libs/diagnostics'
import {handleChange} from './events/on-change'
import {handleClose} from './events/on-close'
import {handleFileRename} from './events/on-file-rename'
import {debugOutputChannel, debugLog} from './libs/debug'
import {openCompiledPath} from './libs/commands'
import {cleanupStaleCompiledFiles, initCompiledDir, startupCompileWorkspace} from './libs/compiled'
import {statusBarItem} from './libs/status'
import {activateLaravelGotoView, waitForLaravelGotoView} from './libs/view-data'
import {removeAllCompiledFiles} from './libs/manifest'

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
        await cleanupStaleCompiledFiles()
        await setIntelephenseConfig()
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
            debugOutputChannel,
            vscode.commands.registerCommand('bladeParser.openCompiledPath', async(document) => await openCompiledPath(document)),
            vscode.commands.registerCommand('bladeParser.indexWorkspace', async() => {
                await removeAllCompiledFiles()
                await startupCompileWorkspace()
                refreshAllOpenBlades()
            }),

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

            /* Events ------------------------------------------------------------------- */
            vscode.workspace.onDidRenameFiles(handleFileRename),
            vscode.workspace.onDidSaveTextDocument(handleSave),
            vscode.workspace.onDidChangeTextDocument(handleChange),
            vscode.workspace.onDidCloseTextDocument(handleClose),
            activateSymbolProvider(BLADE_SELECTOR),
        )
    })()

    return {extendMarkdownIt}
}

export async function deactivate() {
}
