import * as os from 'os';
import { dirname } from 'path';
import * as net from 'net';
import { URL } from 'url';
import { LanguageClient, LanguageClientOptions, StreamInfo, DocumentFilter, ErrorAction, CloseAction, RevealOutputChannelOn } from 'vscode-languageclient/node';
import { Disposable, workspace, Uri, TextDocument, WorkspaceConfiguration, OutputChannel, window, WorkspaceFolder } from 'vscode';
import { DisposableProcess, getRLibPaths, getRpath, promptToInstallRPackage, spawn, substituteVariables } from './util';
import { extensionContext } from './extension';
import { CommonOptions } from 'child_process';

export class LanguageService implements Disposable {
    private client: LanguageClient | undefined;
    private readonly clients: Map<string, LanguageClient> = new Map();
    private readonly initSet: Set<string> = new Set();
    // Track open documents per server key for proper cleanup
    private readonly openDocuments: Map<string, Set<string>> = new Map();
    private readonly config: WorkspaceConfiguration;
    private readonly outputChannel: OutputChannel;

    constructor() {
        this.outputChannel = window.createOutputChannel('R Language Server');
        this.client = undefined;
        this.config = workspace.getConfiguration('r');
        void this.startLanguageService(this);
    }

    dispose(): Thenable<void> {
        return this.stopLanguageService();
    }

    private spawnServer(client: LanguageClient, rPath: string, args: readonly string[], options: CommonOptions & { cwd: string }): DisposableProcess {
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
            void client.stop();
        });
        return childProcess;
    }

    private async createClient(config: WorkspaceConfiguration, selector: DocumentFilter[],
        cwd: string, workspaceFolder: WorkspaceFolder | undefined, outputChannel: OutputChannel): Promise<LanguageClient> {

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
                return this.spawnServer(client, rPath, args, options);
            });
        });

        // Options to control the language client
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
            revealOutputChannelOn: RevealOutputChannelOn.Never,
            errorHandler: {
                error: () =>    {
                    return {
                        action: ErrorAction.Continue
                    };
                },
                closed: () => {
                    return {
                        action: CloseAction.DoNotRestart
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

        extensionContext.subscriptions.push(client);
        await client.start();
        return client;
    }

    private isClientInitializing(name: string): boolean {
        return this.initSet.has(name);
    }

    private getKey(uri: Uri): string {
        switch (uri.scheme) {
            case 'untitled':
                return uri.scheme;
            case 'vscode-notebook-cell':
                return `vscode-notebook:${uri.fsPath}`;
            default:
                return uri.toString(true);
        }
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
        this.openDocuments.get(serverKey)!.add(documentUri);
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

    private startMultiLanguageService(self: LanguageService): void {
        async function didOpenTextDocument(document: TextDocument) {
            if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled' && document.uri.scheme !== 'vscode-notebook-cell') {
                return;
            }

            if (document.languageId !== 'r' && document.languageId !== 'rmd') {
                return;
            }

            const serverKey = self.getServerKey(document);
            if (!serverKey) {
                return;
            }

            // Track this document
            self.trackDocument(serverKey, document.uri.toString(true));

            // Check if server already exists or is being initialized
            if (self.clients.has(serverKey) || self.isClientInitializing(serverKey)) {
                return;
            }

            // Mark as initializing to prevent duplicate creation
            self.initSet.add(serverKey);

            try {
                const folder = workspace.getWorkspaceFolder(document.uri);

                // Each notebook uses a server started from parent folder
                if (document.uri.scheme === 'vscode-notebook-cell') {
                    console.log(`Starting language server for notebook: ${document.uri.toString(true)}`);
                    const documentSelector: DocumentFilter[] = [
                        { scheme: 'vscode-notebook-cell', language: 'r', pattern: `${document.uri.fsPath}` },
                    ];
                    const client = await self.createClient(self.config, documentSelector,
                        dirname(document.uri.fsPath), folder, self.outputChannel);
                    self.clients.set(serverKey, client);
                    return;
                }

                if (folder) {
                    // Each workspace uses a server started from the workspace folder
                    console.log(`Starting language server for workspace: ${folder.name} (${folder.uri.toString(true)})`);
                    const pattern = `${folder.uri.fsPath}/**/*`;
                    const documentSelector: DocumentFilter[] = [
                        { scheme: 'file', language: 'r', pattern: pattern },
                        { scheme: 'file', language: 'rmd', pattern: pattern },
                    ];
                    const client = await self.createClient(self.config, documentSelector, 
                        folder.uri.fsPath, folder, self.outputChannel);
                    self.clients.set(serverKey, client);

                } else {
                    // All untitled documents share a server started from home folder
                    if (document.uri.scheme === 'untitled') {
                        console.log(`Starting language server for untitled documents`);
                        const documentSelector: DocumentFilter[] = [
                            { scheme: 'untitled', language: 'r' },
                            { scheme: 'untitled', language: 'rmd' },
                        ];
                        const client = await self.createClient(self.config, documentSelector, 
                            os.homedir(), undefined, self.outputChannel);
                        self.clients.set(serverKey, client);
                        return;
                    }

                    // Each file outside workspace uses a server started from parent folder
                    if (document.uri.scheme === 'file') {
                        console.log(`Starting language server for standalone file: ${document.uri.toString(true)}`);
                        const dir = dirname(document.uri.fsPath);
                        const documentSelector: DocumentFilter[] = [
                            { scheme: 'file', pattern: `${dir}/**/*.{R,r,Rmd,rmd}` },
                        ];
                        const client = await self.createClient(self.config, documentSelector,
                            dir, undefined, self.outputChannel);
                        self.clients.set(serverKey, client);
                        return;
                    }
                }
            } finally {
                // Remove from initializing set
                self.initSet.delete(serverKey);
            }
        }

        function didCloseTextDocument(document: TextDocument): void {
            if (document.languageId !== 'r' && document.languageId !== 'rmd') {
                return;
            }

            const serverKey = self.getServerKey(document);
            if (!serverKey) {
                return;
            }

            // Untrack this document and check if we should stop the server
            const shouldStop = self.untrackDocument(serverKey, document.uri.toString(true));
            
            if (shouldStop) {
                const client = self.clients.get(serverKey);
                if (client) {
                    console.log(`Stopping language server for: ${serverKey}`);
                    self.clients.delete(serverKey);
                    self.initSet.delete(serverKey);
                    void client.stop();
                }
            }
        }

        workspace.onDidOpenTextDocument(didOpenTextDocument);
        workspace.onDidCloseTextDocument(didCloseTextDocument);
        workspace.textDocuments.forEach((doc) => void didOpenTextDocument(doc));
        
        workspace.onDidChangeWorkspaceFolders((event) => {
            for (const folder of event.removed) {
                const serverKey = folder.uri.toString(true);
                const client = self.clients.get(serverKey);
                if (client) {
                    console.log(`Stopping language server for removed workspace: ${folder.name}`);
                    self.clients.delete(serverKey);
                    self.initSet.delete(serverKey);
                    self.openDocuments.delete(serverKey);
                    void client.stop();
                }
            }
        });
    }

    private async startLanguageService(self: LanguageService): Promise<void> {
        if (self.config.get<boolean>('lsp.multiServer')) {
            return this.startMultiLanguageService(self);
        } else {
            // Single server mode - only start when R files are opened
            const startSingleServer = async () => {
                if (self.client) {
                    return; // Already started
                }

                const documentSelector: DocumentFilter[] = [
                    { language: 'r' },
                    { language: 'rmd' },
                ];

                const workspaceFolder = workspace.workspaceFolders?.[0];
                const cwd = workspaceFolder ? workspaceFolder.uri.fsPath : os.homedir();
                console.log(`Starting single language server in: ${cwd}`);
                self.client = await self.createClient(self.config, documentSelector, cwd, workspaceFolder, self.outputChannel);
            };

            const stopSingleServer = () => {
                // Check if any R files are still open
                const hasRFiles = workspace.textDocuments.some(doc => 
                    (doc.languageId === 'r' || doc.languageId === 'rmd')
                );

                if (!hasRFiles && self.client) {
                    console.log('Stopping single language server - no R files open');
                    const client = self.client;
                    self.client = undefined;
                    void client.stop();
                }
            };

            // Set up listeners for single server mode
            workspace.onDidOpenTextDocument(async (document) => {
                if (document.languageId === 'r' || document.languageId === 'rmd') {
                    await startSingleServer();
                }
            });

            workspace.onDidCloseTextDocument(() => {
                stopSingleServer();
            });

            // Start server if R files are already open
            const hasRFiles = workspace.textDocuments.some(doc => 
                (doc.languageId === 'r' || doc.languageId === 'rmd')
            );
            if (hasRFiles) {
                await startSingleServer();
            }
        }
    }

    private stopLanguageService(): Thenable<void> {
        const promises: Thenable<void>[] = [];
        if (this.client) {
            promises.push(this.client.stop());
        }
        for (const client of this.clients.values()) {
            promises.push(client.stop());
        }
        this.clients.clear();
        this.initSet.clear();
        this.openDocuments.clear();
        return Promise.all(promises).then(() => undefined);
    }
}