import { SourcegraphExtension } from '@sourcegraph/extensions-client-common/lib/schema/extension.schema'
import { applyEdits } from '@sqs/jsonc-parser'
import { setProperty } from '@sqs/jsonc-parser/lib/edit'
import { ClientOptions, ClientState } from 'cxp/lib/client/client'
import { Controller } from 'cxp/lib/environment/controller'
import { Environment } from 'cxp/lib/environment/environment'
import { Extension as CXPExtension } from 'cxp/lib/environment/extension'
import { MessageTransports } from 'cxp/lib/jsonrpc2/connection'
import { BrowserConsoleTracer, Trace } from 'cxp/lib/jsonrpc2/trace'
import { createWebSocketMessageTransports } from 'cxp/lib/jsonrpc2/transports/browserWebSocket'
import { TextDocumentDecoration } from 'cxp/lib/protocol'
import { merge } from 'rxjs'
import { switchMap } from 'rxjs/operators'
import { Disposable } from 'vscode-languageserver'
import storage from '../../extension/storage'
import { ErrorLike, isErrorLike } from './errors'
import { createExtensionsContextController } from './extensions'
import { createPortMessageTransports } from './PortMessageTransports'

export const CXP_CONTROLLER = createController()

export const CXP_EXTENSIONS_CONTEXT_CONTROLLER = createExtensionsContextController()

CXP_EXTENSIONS_CONTEXT_CONTROLLER.viewerConfiguredExtensions.subscribe(
    configuredExtensions => {
        console.log('setEnvironment with extensions', configuredExtensions)
        CXP_CONTROLLER.setEnvironment({
            ...CXP_CONTROLLER.environment.environment.value,
            extensions: configuredExtensions.map(x => ({
                id: x.extensionID,
                settings: { merged: x.settings },
                isEnabled: x.isEnabled,
                manifest: x.manifest,
            })),
        })
    },
    err => {
        console.error('Error fetching viewer configured extensions via GraphQL: %O', err)
    }
)

CXP_CONTROLLER.configurationUpdates.subscribe(
    update =>
        storage.getSync(items => {
            const format = { tabSize: 2, insertSpaces: true, eol: '\n' }
            items.clientSettings = applyEdits(
                items.clientSettings,
                setProperty(items.clientSettings, update.path, update.value, format)
            )
            storage.setSync({ ...items, clientSettings: items.clientSettings })
        }),
    err => console.error(err)
)

// TODO(chris) consider putting the environmentFilter in extensions-client-common

/**
 * Filter the environment to omit extensions that should not be activated (based on their manifest's
 * activationEvents).
 */
function environmentFilter(
    nextEnvironment: Environment<CXPExtensionWithManifest>
): Environment<CXPExtensionWithManifest> {
    return {
        ...nextEnvironment,
        extensions:
            nextEnvironment.extensions &&
            nextEnvironment.extensions.filter(x => {
                try {
                    const component = nextEnvironment.component
                    if (x.isEnabled && x.manifest && !isErrorLike(x.manifest) && x.manifest.activationEvents) {
                        return x.manifest.activationEvents.some(
                            e => e === '*' || (!!component && e === `onLanguage:${component.document.languageId}`)
                        )
                    }
                } catch (err) {
                    console.error(err)
                }
                return false
            }),
    }
}

function clientStateToColor(state: ClientState): string {
    switch (state) {
        case ClientState.Initial:
            return 'AliceBlue'
        case ClientState.Connecting:
            return 'AliceBlue'
        case ClientState.Initializing:
            return 'AliceBlue'
        case ClientState.ActivateFailed:
            return 'Pink'
        case ClientState.Active:
            return 'PaleGreen'
        case ClientState.ShuttingDown:
            return 'LemonChiffon'
        case ClientState.Stopped:
            return 'LightGray'
    }
}

function clientStateToName(state: ClientState): string {
    switch (state) {
        case ClientState.Initial:
            return 'Initial'
        case ClientState.Connecting:
            return 'Connecting'
        case ClientState.Initializing:
            return 'Initializing'
        case ClientState.ActivateFailed:
            return 'ActivateFailed'
        case ClientState.Active:
            return 'Active'
        case ClientState.ShuttingDown:
            return 'ShuttingDown'
        case ClientState.Stopped:
            return 'Stopped'
    }
}

const RESET_COLOR = 'font-weight:normal;background-color:unset'

/**
 * Creates the CXP controller, which handles all CXP communication between the React app and CXP extension.
 *
 * There should only be a single controller for the entire application. The controller's environment represents all
 * of the application state that the controller needs to know.
 *
 * It receives state updates via calls to the setEnvironment method from React components. It provides results to
 * React components via its registries and the showMessages, etc., observables.
 */
export function createController(): Controller<CXPExtensionWithManifest> {
    const controller = new Controller<CXPExtensionWithManifest>({
        clientOptions: (clientKey, clientOptions, extension) => ({
            initializationFailedHandler: err => {
                console.error('Initialization failed for extension', extension.id, ':', err)
                return false
            },
            createMessageTransports: () => createMessageTransports(extension, clientOptions),
            trace: Trace.fromString(localStorage.getItem('traceCXP') || 'off'),
            tracer: new BrowserConsoleTracer(extension.id),
        }),
        environmentFilter,
    })

    controller.clientEntries
        .pipe(
            switchMap(clients => merge(clients)),
            switchMap(client => client.client.state)
        )
        .subscribe(state => {
            console.log(
                '%c CXP client %s %c',
                'background-color:' + clientStateToColor(state),
                clientStateToName(state),
                RESET_COLOR
            )
        })
    controller.showMessages.subscribe(({ message }) => alert(message))
    controller.showMessageRequests.subscribe(({ message, actions, resolve }) => {
        if (!actions || actions.length === 0) {
            alert(message)
            resolve(null)
            return
        }
        const value = prompt(
            `${message}\n\nValid responses: ${actions.map(({ title }) => JSON.stringify(title)).join(', ')}`,
            actions[0].title
        )
        resolve(actions.find(a => a.title === value) || null)
    })

    // Print window/logMessage log messages to the browser devtools console.
    controller.logMessages.subscribe(({ message, extension }) => {
        console.log(
            '%c CXP %s %c %s',
            'font-weight:bold;background-color:#eee',
            extension,
            'font-weight:normal;background-color:unset',
            message
        )
    })

    // Debug helpers.
    if (localStorage.getItem('traceCXP') === 'verbose') {
        // Debug helper: log environment changes.
        controller.environment.environment.subscribe(environment =>
            console.log(
                '%c CXP env %c %o',
                'font-weight:bold;background-color:#999;color:white',
                'background-color:unset;color:unset;font-weight:unset',
                environment
            )
        )

        // Debug helpers: e.g., just run `cxp` in devtools to get a reference to this controller. (If multiple
        // controllers are created, this points to the last one created.)
        if (!('cxp' in window)) {
            Object.defineProperty(window, 'cxp', {
                get: () => controller,
            })
        }
        if (!('cxpenv' in window)) {
            Object.defineProperty(window, 'cxpenv', {
                get: () => controller.environment.environment.value,
            })
        }
    }

    return controller
}

/**
 * Adds the manifest to CXP extensions in the CXP environment, so we can consult it in the createMessageTransports
 * callback (to know how to communicate with or run the extension).
 */
export interface CXPExtensionWithManifest extends CXPExtension {
    isEnabled: boolean
    manifest: SourcegraphExtension | null | ErrorLike
}

const createPlatformMessageTransports = (() => {
    const CONTROL = chrome.runtime.connect({ name: 'CONTROL' })
    return ({ id, platform }) =>
        new Promise<MessageTransports>((resolve, reject) => {
            CONTROL.postMessage({ extensionID: id, platform })
            CONTROL.onMessage.addListener((response: { portName: string } | { error: any }) => {
                if ('error' in response) {
                    reject(response.error)
                } else {
                    resolve(createPortMessageTransports(chrome.runtime.connect({ name: response.portName })))
                }
            })
        })
})()

function createMessageTransports(
    extension: CXPExtensionWithManifest,
    options: ClientOptions
): Promise<MessageTransports> {
    if (!extension.manifest) {
        throw new Error(`unable to connect to extension ${JSON.stringify(extension.id)}: no manifest found`)
    }
    if (isErrorLike(extension.manifest)) {
        throw new Error(
            `unable to connect to extension ${JSON.stringify(extension.id)}: invalid manifest: ${
                extension.manifest.message
            }`
        )
    }
    if (extension.manifest.platform.type === 'websocket') {
        return createPlatformMessageTransports({ id: extension.id, platform: extension.manifest.platform })
    } else if (extension.manifest.platform.type === 'tcp') {
        // The language server CXP extensions on Sourcegraph are specified as
        // TCP endpoints, but they are also served over WebSockets by lsp-proxy
        // on the Sourcegraph instance. Since we can't connect to a TCP endpoint
        // in the browser, we connect to lsp-proxy via WebSockets instead.
        //
        // TODO(chris): Remove this logic if/when platform-rewriting lands
        // https://github.com/sourcegraph/sourcegraph/issues/12598
        const url = new URL('http://localhost:3080')
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        url.pathname = '.api/lsp'
        url.searchParams.set('mode', extension.id)
        url.searchParams.set('rootUri', options.root || '')
        return createWebSocketMessageTransports(new WebSocket(url.href))
    } else if (extension.manifest.platform.type === 'bundle') {
        return createPlatformMessageTransports({ id: extension.id, platform: extension.manifest.platform })
    } else {
        return Promise.reject(
            new Error(
                `Unable to connect to CXP extension ${JSON.stringify(extension.id)}: type ${JSON.stringify(
                    extension.manifest.platform.type
                )} is not supported`
            )
        )
    }
}

const mergeDisposables = (...disposables: Disposable[]): Disposable => ({
    dispose: () => {
        for (const disposable of disposables) {
            disposable.dispose()
        }
    },
})

// This applies a decoration to a GitHub blob page. This doesn't work with any other code host yet.
export const applyDecoration = ({
    fileElement,
    decoration,
}: {
    fileElement: HTMLElement
    decoration: TextDocumentDecoration
}): Disposable => {
    const disposables: Disposable[] = []

    const ghLineNumber = decoration.range.start.line + 1
    const lineNumberElements: NodeListOf<HTMLElement> = fileElement.querySelectorAll(
        `td[data-line-number="${ghLineNumber}"]`
    )
    if (!lineNumberElements) {
        throw new Error(`Line number ${ghLineNumber} not found`)
    }
    if (lineNumberElements.length !== 1) {
        throw new Error(`Line number ${ghLineNumber} matched ${lineNumberElements.length} elements (expected 1)`)
    }
    const lineNumberElement = lineNumberElements[0]
    if (!lineNumberElement) {
        throw new Error(`Line number ${ghLineNumber} is falsy: ${lineNumberElement}`)
    }
    const lineElement = lineNumberElement.nextElementSibling as HTMLElement | undefined
    if (!lineElement) {
        throw new Error(`Line ${ghLineNumber} is falsy: ${lineNumberElement}`)
    }

    if (decoration.backgroundColor) {
        lineElement.style.backgroundColor = decoration.backgroundColor

        disposables.push({
            dispose: () => {
                lineElement.style.backgroundColor = null
            },
        })
    }

    if (decoration.after) {
        const linkTo = (url: string) => (e: HTMLElement): HTMLElement => {
            const link = document.createElement('a')
            link.setAttribute('href', url)
            link.style.color = decoration.after!.color || null
            link.appendChild(e)
            return link
        }
        const after = document.createElement('span')
        after.style.backgroundColor = decoration.after.backgroundColor || null
        after.textContent = decoration.after.contentText || null
        const annotation = decoration.after.linkURL ? linkTo(decoration.after.linkURL)(after) : after
        lineElement.appendChild(annotation)
        disposables.push({
            dispose: () => {
                annotation.remove()
            },
        })
    }

    return mergeDisposables(...disposables)
}
