import * as os from 'os';
import { dirname } from 'path';
import * as net from 'net';
import { URL } from 'url';
import { LanguageClient, LanguageClientOptions, StreamInfo, DocumentFilter, ErrorAction, CloseAction, RevealOutputChannelOn, Middleware } from 'vscode-languageclient/node';
import { Disposable, workspace, Uri, TextDocument, WorkspaceConfiguration, OutputChannel, window, WorkspaceFolder } from 'vscode';
import { DisposableProcess, getRLibPaths, getRpath, promptToInstallRPackage, spawn, substituteVariables } from './util';
import { extensionContext } from './extension';
import { CommonOptions } from 'child_process';

export class LanguageService implements Disposable {
    private static readonly singleClientKey = 'global';
    private static readonly idleStopDelayMs = 30_000;
    private client: LanguageClient | undefined;
    private readonly clients: Map<string, LanguageClient> = new Map();
    private readonly initSet: Set<string> = new Set();
    // Track open documents per server key for proper cleanup
    private readonly openDocuments: Map<string, Set<string>> = new Map();
    private readonly stoppingClients: Map<string, Promise<void>> = new Map();
    private readonly restartAfterStop: Map<string, () => void> = new Map();
    private readonly idleStopTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private readonly quartoVirtualDocumentServerKeys: Map<string, string> = new Map();
    private readonly disposables: Disposable[] = [];
    private readonly config: WorkspaceConfiguration;
    private readonly outputChannel: OutputChannel;
    private disposed = false;

    constructor() {
        this.outputChannel = window.createOutputChannel('R Language Server');
        this.client = undefined;
        this.config = workspace.getConfiguration('r');
        void this.startLanguageService(this);
    }

    dispose(): Thenable<void> {
        this.disposed = true;
        return this.stopLanguageService();
    }

    private spawnServer(client: LanguageClient, rPath: string, args: readonly string[], options: CommonOptions & { cwd: string },
        onExit?: (client: LanguageClient) => void): DisposableProcess {
        const childProcess = spawn(rPath, args, options);
        const pid = childProcess.pid || -1;
        client.outputChannel.appendLine(`R Language Server (${pid}) started`);
        childProcess.stderr.on('data', (chunk: Buffer) => {
            client.outputChannel.appendLine(chunk.toString());
        });
        childProcess.on('exit', (code, signal) => {
            client.outputChannel.appendLine(`R Language Server (${pid}) exited ` +
                (signal ? `from signal ${signal}` : `with exit code ${code || 'null'}`));
            if (code !== 0) {
                if (code === 10) {
                    // languageserver is not installed.
                    void promptToInstallRPackage(
                        'languageserver', 'lsp.promptToInstall', options.cwd,
                        'R package {languageserver} is required to enable R language service features such as code completion, function signature, find references, etc. Do you want to install it?',
                        'You may need to reopen an R file to start the language service after the package is installed.'
                    );
                } else {
                    client.outputChannel.show();
                }
            }
            onExit?.(client);
        });
        return childProcess;
    }

    private async createClient(config: WorkspaceConfiguration, selector: DocumentFilter[],
        cwd: string, workspaceFolder: WorkspaceFolder | undefined, outputChannel: OutputChannel,
        serverKey: string, onExit?: (client: LanguageClient) => void): Promise<LanguageClient> {

        let client: LanguageClient;

        const debug = config.get<boolean>('lsp.debug');
        const useRenvLibPath = config.get<boolean>('useRenvLibPath') ?? false;
        const rPath = await getRpath() || ''; // TODO: Abort gracefully
        if (debug) {
            console.log(`R path: ${rPath}`);
        }
        const use_stdio = config.get<boolean>('lsp.use_stdio');
        const env = Object.create(process.env) as NodeJS.ProcessEnv;
        env.VSCR_LSP_DEBUG = debug ? 'TRUE' : 'FALSE';
        env.VSCR_LIB_PATHS = getRLibPaths();
        env.VSCR_USE_RENV_LIB_PATH = useRenvLibPath ? 'TRUE' : 'FALSE';

        const lang = config.get<string>('lsp.lang');
        if (lang !== '') {
            env.LANG = lang;
        } else if (env.LANG === undefined) {
            env.LANG = 'en_US.UTF-8';
        }

        if (debug) {
            // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
            console.log(`LANG: ${env.LANG}`);
        }

        const rScriptPath = extensionContext.asAbsolutePath('R/languageServer.R');
        const options = { cwd: cwd, env: env };
        const args = (config.get<string[]>('lsp.args')?.map(substituteVariables) ?? []).concat(
            '--silent',
            '--no-echo',
            '--no-save',
            '--no-restore',
            '-e',
            'base::source(base::commandArgs(TRUE))',
            '--args',
            rScriptPath
        );

        const tcpServerOptions = () => new Promise<DisposableProcess | StreamInfo>((resolve, reject) => {
            // Use a TCP socket because of problems with blocking STDIO
            const server = net.createServer(socket => {
                // 'connection' listener
                console.log('R process connected');
                socket.on('end', () => {
                    console.log('R process disconnected');
                });
                socket.on('error', (e: Error) => {
                    console.log(`R process error: ${e.message}`);
                    reject(e);
                });
                server.close();
                resolve({ reader: socket, writer: socket });
            });
            // Listen on random port
            server.listen(0, '127.0.0.1', () => {
                const port = (server.address() as net.AddressInfo).port;
                env.VSCR_LSP_PORT = String(port);
                return this.spawnServer(client, rPath, args, options, onExit);
            });
        });

        // Options to control the language client
        const middleware: Middleware = {
            sendRequest: async (type, param, token, next) => {
                if (!this.shouldRouteToClient(serverKey, param)) {
                    return undefined as never;
                }
                return next(type, param, token);
            },
            sendNotification: async (type, next, params) => {
                if (!this.shouldRouteToClient(serverKey, params)) {
                    return;
                }
                return next(type, params);
            }
        };

        const clientOptions: LanguageClientOptions = {
            // Register the server for selected R documents
            documentSelector: selector,
            uriConverters: {
                // VS Code by default %-encodes even the colon after the drive letter
                // NodeJS handles it much better
                code2Protocol: uri => new URL(uri.toString(true)).toString(),
                protocol2Code: str => Uri.parse(str)
            },
            workspaceFolder: workspaceFolder,
            outputChannel: outputChannel,
            synchronize: {
                // Synchronize the setting section 'r' to the server
                configurationSection: 'r.lsp',
                fileEvents: workspace.createFileSystemWatcher('**/*.{R,r}'),
            },
            middleware,
            revealOutputChannelOn: RevealOutputChannelOn.Never,
            errorHandler: {
                error: () =>    {
                    return {
                        action: ErrorAction.Continue
                    };
                },
                closed: () => {
                    onExit?.(client);
                    return {
                        action: CloseAction.DoNotRestart,
                        handled: true
                    };
                },
            },
        };

        // Create the language client and start the client.
        if (use_stdio && process.platform !== 'win32') {
            client = new LanguageClient('r', 'R Language Server', { command: rPath, args: args, options: options }, clientOptions);
        } else {
            client = new LanguageClient('r', 'R Language Server', tcpServerOptions, clientOptions);
        }

        try {
            await client.start();
            return client;
        } catch (error) {
            try {
                await client.dispose();
            } catch {
                // A failed start may leave no active connection to dispose.
            }
            throw error;
        }
    }

    private isClientInitializing(name: string): boolean {
        return this.initSet.has(name);
    }

    private isQuartoDocument(document: TextDocument): boolean {
        return document.languageId === 'quarto' ||
            document.uri.fsPath.toLowerCase().endsWith('.qmd');
    }

    private isQuartoVirtualDocument(document: TextDocument): boolean {
        const fsPath = document.uri.fsPath.toLowerCase();
        return document.uri.scheme === 'file' &&
            document.languageId === 'r' &&
            fsPath.includes('.vdoc.') &&
            fsPath.endsWith('.r');
    }

    private isTemporaryRSource(document: TextDocument): boolean {
        if (document.uri.scheme !== 'file') {
            return false;
        }
        const fsPath = document.uri.fsPath.toLowerCase();
        return fsPath.includes('rtmp') &&
            fsPath.endsWith('.r') &&
            !fsPath.includes('.vdoc.');
    }

    private shouldRouteToClient(serverKey: string, params: unknown): boolean {
        if (!params || typeof params !== 'object') {
            return true;
        }
        const textDocument = (params as { textDocument?: { uri?: unknown } }).textDocument;
        if (typeof textDocument?.uri !== 'string') {
            return true;
        }
        const documentKey = Uri.parse(textDocument.uri).toString();
        const mappedServerKey = this.quartoVirtualDocumentServerKeys.get(documentKey);
        return !mappedServerKey || mappedServerKey === serverKey;
    }

    private getParentQuartoDocument(document: TextDocument): TextDocument | undefined {
        const sourceFolder = workspace.getWorkspaceFolder(document.uri);
        const matchesWorkspace = (candidate: TextDocument): boolean =>
            this.isQuartoDocument(candidate) &&
            (!sourceFolder ||
                workspace.getWorkspaceFolder(candidate.uri)?.uri.toString(true) === sourceFolder.uri.toString(true));

        const activeDocument = window.activeTextEditor?.document;
        if (activeDocument && matchesWorkspace(activeDocument)) {
            return activeDocument;
        }

        const visibleDocuments = window.visibleTextEditors
            .map(editor => editor.document)
            .filter(matchesWorkspace);
        if (visibleDocuments.length === 1) {
            return visibleDocuments[0];
        }
        const visibleServerKeys = new Set(
            visibleDocuments
                .map(candidate => this.getServerKey(candidate))
                .filter((key): key is string => key !== null)
        );
        if (visibleDocuments.length > 1 && visibleServerKeys.size === 1) {
            return visibleDocuments[visibleDocuments.length - 1];
        }

        const openDocuments = workspace.textDocuments.filter(matchesWorkspace);
        if (openDocuments.length === 1) {
            return openDocuments[0];
        }
        const openServerKeys = new Set(
            openDocuments
                .map(candidate => this.getServerKey(candidate))
                .filter((key): key is string => key !== null)
        );
        return openDocuments.length > 1 && openServerKeys.size === 1
            ? openDocuments[openDocuments.length - 1]
            : undefined;
    }

    private getServerKey(document: TextDocument): string | null {
        // For workspace files, use workspace folder URI as key
        const folder = workspace.getWorkspaceFolder(document.uri);
        if (folder) {
            return folder.uri.toString(true);
        }

        // For notebook cells, use notebook path as key
        if (document.uri.scheme === 'vscode-notebook-cell') {
            return `vscode-notebook:${document.uri.fsPath}`;
        }

        // For untitled documents, use shared key
        if (document.uri.scheme === 'untitled') {
            return 'untitled';
        }

        // For files outside workspace, use parent directory as key
        if (document.uri.scheme === 'file') {
            return dirname(document.uri.fsPath);
        }

        return null;
    }

    private trackDocument(serverKey: string, documentUri: string): void {
        if (!this.openDocuments.has(serverKey)) {
            this.openDocuments.set(serverKey, new Set());
        }
        this.openDocuments.get(serverKey)?.add(documentUri);
    }

    private untrackDocument(serverKey: string, documentUri: string): boolean {
        const docs = this.openDocuments.get(serverKey);
        if (docs) {
            docs.delete(documentUri);
            if (docs.size === 0) {
                this.openDocuments.delete(serverKey);
                return true; // All documents closed for this server
            }
        }
        return false; // Still has open documents
    }

    private hasOpenTrackedDocuments(serverKey: string): boolean {
        const documents = this.openDocuments.get(serverKey);
        if (!documents) {
            return false;
        }

        for (const uri of Array.from(documents)) {
            const isOpen = workspace.textDocuments.some(document =>
                document.uri.toString(true) === uri
            );
            if (isOpen) {
                return true;
            }
            documents.delete(uri);
        }

        this.openDocuments.delete(serverKey);
        return false;
    }

    private hasOpenSingleServerDocuments(): boolean {
        const hasOpenRDocument = workspace.textDocuments.some(document =>
            (document.uri.scheme === 'file' ||
                document.uri.scheme === 'untitled' ||
                document.uri.scheme === 'vscode-notebook-cell') &&
            (document.languageId === 'r' || document.languageId === 'rmd') &&
            !this.isTemporaryRSource(document) &&
            !this.isQuartoVirtualDocument(document)
        );
        return hasOpenRDocument ||
            this.hasOpenTrackedDocuments(LanguageService.singleClientKey);
    }

    private getClient(serverKey: string): LanguageClient | undefined {
        return serverKey === LanguageService.singleClientKey
            ? this.client
            : this.clients.get(serverKey);
    }

    private deleteClient(serverKey: string): void {
        if (serverKey === LanguageService.singleClientKey) {
            this.client = undefined;
        } else {
            this.clients.delete(serverKey);
        }
    }

    private cancelIdleStop(serverKey: string): void {
        const timer = this.idleStopTimers.get(serverKey);
        if (timer) {
            clearTimeout(timer);
            this.idleStopTimers.delete(serverKey);
        }
    }

    private scheduleIdleStop(serverKey: string, shouldStop: () => boolean): void {
        if (this.disposed || this.idleStopTimers.has(serverKey)) {
            return;
        }
        const timer = setTimeout(() => {
            this.idleStopTimers.delete(serverKey);
            if (shouldStop()) {
                void this.stopClient(serverKey);
            }
        }, LanguageService.idleStopDelayMs);
        this.idleStopTimers.set(serverKey, timer);
    }

    private clearIdleStops(): void {
        for (const timer of this.idleStopTimers.values()) {
            clearTimeout(timer);
        }
        this.idleStopTimers.clear();
    }

    private stopAndDisposeClient(client: LanguageClient): Thenable<void> {
        client.clientOptions.errorHandler = undefined;
        if (!client.needsStop()) {
            return client.dispose();
        }
        return client.stop().then(() => client.dispose());
    }

    private queueRestartAfterStop(serverKey: string, restart: () => void): boolean {
        if (!this.stoppingClients.has(serverKey)) {
            return false;
        }
        this.restartAfterStop.set(serverKey, restart);
        return true;
    }

    private stopClient(serverKey: string): Promise<void> | undefined {
        this.cancelIdleStop(serverKey);
        const existingStop = this.stoppingClients.get(serverKey);
        if (existingStop) {
            return existingStop;
        }

        const client = this.getClient(serverKey);
        this.openDocuments.delete(serverKey);
        if (!client) {
            return undefined;
        }

        this.deleteClient(serverKey);
        this.initSet.delete(serverKey);
        const stopPromise = Promise.resolve(this.stopAndDisposeClient(client))
            .catch(error => {
                this.outputChannel.appendLine(`Failed to stop R language server: ${String(error)}`);
            })
            .finally(() => {
                this.stoppingClients.delete(serverKey);
                const restart = this.restartAfterStop.get(serverKey);
                this.restartAfterStop.delete(serverKey);
                if (!this.disposed) {
                    restart?.();
                }
            });
        this.stoppingClients.set(serverKey, stopPromise);
        return stopPromise;
    }

    private handleClientExit(serverKey: string, client: LanguageClient): void {
        if (this.getClient(serverKey) !== client) {
            return;
        }
        this.deleteClient(serverKey);
        this.initSet.delete(serverKey);
        this.cancelIdleStop(serverKey);
        void client.dispose();
    }

    private forgetStoppedClient(serverKey: string): void {
        const client = this.getClient(serverKey);
        if (client && !client.needsStop()) {
            this.deleteClient(serverKey);
            this.initSet.delete(serverKey);
            void client.dispose();
        }
    }

    private withQuartoVirtualSelector(selector: DocumentFilter[]): DocumentFilter[] {
        return selector.concat({
            scheme: 'file',
            language: 'r',
            pattern: '**/.vdoc.*.r'
        });
    }

    private async registerMultiClient(serverKey: string, client: LanguageClient): Promise<void> {
        if (this.disposed) {
            await this.stopAndDisposeClient(client);
            return;
        }
        this.clients.set(serverKey, client);
        if (!this.hasOpenTrackedDocuments(serverKey)) {
            this.scheduleIdleStop(serverKey, () => !this.hasOpenTrackedDocuments(serverKey));
        }
    }

    private startMultiLanguageService(self: LanguageService): void {
        async function didOpenTextDocument(document: TextDocument) {
            if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled' && document.uri.scheme !== 'vscode-notebook-cell') {
                return;
            }

            if (document.languageId !== 'r' && document.languageId !== 'rmd') {
                return;
            }
            
            if (self.isTemporaryRSource(document)) {
                return;
            }

            const quartoParent = self.isQuartoVirtualDocument(document)
                ? self.getParentQuartoDocument(document)
                : undefined;
            const serverDocument = quartoParent ?? document;
            const serverKey = self.getServerKey(serverDocument);
            if (!serverKey) {
                return;
            }

            if (self.isQuartoVirtualDocument(document)) {
                self.quartoVirtualDocumentServerKeys.set(document.uri.toString(), serverKey);
            }
            self.trackDocument(serverKey, serverDocument.uri.toString(true));
            self.cancelIdleStop(serverKey);

            if (self.queueRestartAfterStop(serverKey, () => {
                if (self.hasOpenTrackedDocuments(serverKey)) {
                    void didOpenTextDocument(document);
                }
            })) {
                return;
            }

            // Check if server already exists or is being initialized
            self.forgetStoppedClient(serverKey);
            if (self.clients.has(serverKey) || self.isClientInitializing(serverKey)) {
                return;
            }

            // Mark as initializing to prevent duplicate creation
            self.initSet.add(serverKey);

            try {
                const folder = workspace.getWorkspaceFolder(serverDocument.uri);

                // Each notebook uses a server started from parent folder
                if (serverDocument.uri.scheme === 'vscode-notebook-cell') {
                    console.log(`Starting language server for notebook: ${document.uri.toString(true)}`);
                    const documentSelector = self.withQuartoVirtualSelector([
                        { scheme: 'vscode-notebook-cell', language: 'r', pattern: `${serverDocument.uri.fsPath}` },
                    ]);
                    const client = await self.createClient(
                        self.config, documentSelector, dirname(serverDocument.uri.fsPath),
                        folder, self.outputChannel, serverKey,
                        exitedClient => self.handleClientExit(serverKey, exitedClient)
                    );
                    await self.registerMultiClient(serverKey, client);
                    return;
                }

                if (folder) {
                    // Each workspace uses a server started from the workspace folder
                    console.log(`Starting language server for workspace: ${folder.name} (${folder.uri.toString(true)})`);
                    const pattern = `${folder.uri.fsPath}/**/*`;
                    const documentSelector = self.withQuartoVirtualSelector([
                        { scheme: 'file', language: 'r', pattern: pattern },
                        { scheme: 'file', language: 'rmd', pattern: pattern },
                    ]);
                    const client = await self.createClient(
                        self.config, documentSelector, folder.uri.fsPath,
                        folder, self.outputChannel, serverKey,
                        exitedClient => self.handleClientExit(serverKey, exitedClient)
                    );
                    await self.registerMultiClient(serverKey, client);

                } else {
                    // All untitled documents share a server started from home folder
                    if (serverDocument.uri.scheme === 'untitled') {
                        console.log(`Starting language server for untitled documents`);
                        const documentSelector = self.withQuartoVirtualSelector([
                            { scheme: 'untitled', language: 'r' },
                            { scheme: 'untitled', language: 'rmd' },
                        ]);
                        const client = await self.createClient(
                            self.config, documentSelector, os.homedir(),
                            undefined, self.outputChannel, serverKey,
                            exitedClient => self.handleClientExit(serverKey, exitedClient)
                        );
                        await self.registerMultiClient(serverKey, client);
                        return;
                    }

                    // Each file outside workspace uses a server started from parent folder
                    if (serverDocument.uri.scheme === 'file') {
                        console.log(`Starting language server for standalone file: ${document.uri.toString(true)}`);
                        const dir = dirname(serverDocument.uri.fsPath);
                        const documentSelector = self.withQuartoVirtualSelector([
                            { scheme: 'file', pattern: `${dir}/**/*.{R,r,Rmd,rmd}` },
                        ]);
                        const client = await self.createClient(
                            self.config, documentSelector, dir,
                            undefined, self.outputChannel, serverKey,
                            exitedClient => self.handleClientExit(serverKey, exitedClient)
                        );
                        await self.registerMultiClient(serverKey, client);
                        return;
                    }
                }
            } finally {
                // Remove from initializing set
                self.initSet.delete(serverKey);
            }
        }

        function didCloseTextDocument(document: TextDocument): void {
            const isRDoc = document.languageId === 'r' || document.languageId === 'rmd';

            if (isRDoc) {
                const serverKey = self.getServerKey(document);
                if (!serverKey) {
                    return;
                }

                self.untrackDocument(serverKey, document.uri.toString(true));
                if (!self.hasOpenTrackedDocuments(serverKey)) {
                    self.scheduleIdleStop(
                        serverKey,
                        () => !self.hasOpenTrackedDocuments(serverKey)
                    );
                }
                return;
            }

            if (self.isQuartoDocument(document)) {
                const serverKey = self.getServerKey(document);
                if (serverKey) {
                    self.untrackDocument(serverKey, document.uri.toString(true));
                    if (!self.hasOpenTrackedDocuments(serverKey)) {
                        self.scheduleIdleStop(
                            serverKey,
                            () => !self.hasOpenTrackedDocuments(serverKey)
                        );
                    }
                }
            }
        }

        const openDisposable = workspace.onDidOpenTextDocument(didOpenTextDocument);
        const closeDisposable = workspace.onDidCloseTextDocument(document => {
            didCloseTextDocument(document);
            if (self.isQuartoVirtualDocument(document)) {
                setTimeout(() => {
                    self.quartoVirtualDocumentServerKeys.delete(document.uri.toString());
                }, 0);
            }
        });
        workspace.textDocuments.forEach((doc) => void didOpenTextDocument(doc));
        
        const workspaceDisposable = workspace.onDidChangeWorkspaceFolders((event) => {
            for (const folder of event.removed) {
                const serverKey = folder.uri.toString(true);
                console.log(`Stopping language server for removed workspace: ${folder.name}`);
                void self.stopClient(serverKey);
            }
        });
        self.disposables.push(openDisposable, closeDisposable, workspaceDisposable);
    }

    private async startLanguageService(self: LanguageService): Promise<void> {
        if (self.config.get<boolean>('lsp.multiServer')) {
            return this.startMultiLanguageService(self);
        } else {
            // Single server mode - only start when R files are opened
            const startSingleServer = async (document?: TextDocument) => {
                const serverKey = LanguageService.singleClientKey;
                const isQuartoVirtualDocument = document &&
                    self.isQuartoVirtualDocument(document);
                if (isQuartoVirtualDocument) {
                    const parent = self.getParentQuartoDocument(document);
                    if (parent) {
                        self.trackDocument(serverKey, parent.uri.toString(true));
                    }
                }

                if (self.disposed ||
                    (!isQuartoVirtualDocument && !self.hasOpenSingleServerDocuments())) {
                    return;
                }

                self.cancelIdleStop(serverKey);
                if (self.queueRestartAfterStop(serverKey, () => {
                    if (self.hasOpenSingleServerDocuments()) {
                        void startSingleServer();
                    }
                })) {
                    return;
                }

                self.forgetStoppedClient(serverKey);
                if (self.client || self.isClientInitializing(serverKey)) {
                    return;
                }

                self.initSet.add(serverKey);
                const documentSelector: DocumentFilter[] = [
                    { scheme: 'file', language: 'r' },
                    { scheme: 'file', language: 'rmd' },
                    { scheme: 'untitled', language: 'r' },
                    { scheme: 'untitled', language: 'rmd' },
                    { scheme: 'vscode-notebook-cell', language: 'r' },
                ];

                const workspaceFolder = workspace.workspaceFolders?.[0];
                const cwd = workspaceFolder ? workspaceFolder.uri.fsPath : os.homedir();
                console.log(`Starting single language server in: ${cwd}`);
                try {
                    const client = await self.createClient(
                        self.config, documentSelector, cwd,
                        workspaceFolder, self.outputChannel, serverKey,
                        exitedClient => self.handleClientExit(serverKey, exitedClient)
                    );
                    if (self.disposed) {
                        await self.stopAndDisposeClient(client);
                        return;
                    }
                    self.client = client;
                    if (!self.hasOpenSingleServerDocuments()) {
                        self.scheduleIdleStop(
                            serverKey,
                            () => !self.hasOpenSingleServerDocuments()
                        );
                    }
                } finally {
                    self.initSet.delete(serverKey);
                }
            };

            const stopSingleServer = () => {
                if (!self.hasOpenSingleServerDocuments()) {
                    self.scheduleIdleStop(
                        LanguageService.singleClientKey,
                        () => !self.hasOpenSingleServerDocuments()
                    );
                }
            };

            // Set up listeners for single server mode
            const openDisposable = workspace.onDidOpenTextDocument(async (document) => {
                if (document.languageId === 'r' || document.languageId === 'rmd') {
                    await startSingleServer(document);
                }
            });

            const closeDisposable = workspace.onDidCloseTextDocument(document => {
                if (self.isQuartoDocument(document)) {
                    self.untrackDocument(
                        LanguageService.singleClientKey,
                        document.uri.toString(true)
                    );
                }
                stopSingleServer();
            });
            self.disposables.push(openDisposable, closeDisposable);

            for (const document of workspace.textDocuments) {
                if (self.isQuartoVirtualDocument(document)) {
                    const parent = self.getParentQuartoDocument(document);
                    if (parent) {
                        self.trackDocument(
                            LanguageService.singleClientKey,
                            parent.uri.toString(true)
                        );
                    }
                }
            }

            const openRDocument = workspace.textDocuments.find(document =>
                (document.languageId === 'r' || document.languageId === 'rmd') &&
                !self.isTemporaryRSource(document)
            );
            if (openRDocument) {
                await startSingleServer(openRDocument);
            }
        }
    }

    private stopLanguageService(): Thenable<void> {
        this.clearIdleStops();
        this.restartAfterStop.clear();
        for (const disposable of this.disposables.splice(0)) {
            disposable.dispose();
        }

        const promises: Promise<void>[] = [];
        if (this.client) {
            const stopping = this.stopClient(LanguageService.singleClientKey);
            if (stopping) {
                promises.push(stopping);
            }
        }
        for (const serverKey of Array.from(this.clients.keys())) {
            const stopping = this.stopClient(serverKey);
            if (stopping) {
                promises.push(stopping);
            }
        }
        for (const stopping of this.stoppingClients.values()) {
            if (!promises.includes(stopping)) {
                promises.push(stopping);
            }
        }
        this.initSet.clear();
        this.openDocuments.clear();
        this.quartoVirtualDocumentServerKeys.clear();
        return Promise.all(promises).then(() => undefined);
    }
}
