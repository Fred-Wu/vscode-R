/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-explicit-any */


import * as vscode from 'vscode';
import { Httpgd } from 'httpgd';
import { HttpgdPlot, IHttpgdViewer, HttpgdViewerOptions } from './httpgdTypes';
import * as path from 'path';
import * as fs from 'fs';
import * as ejs from 'ejs';

import { asViewColumn, config, readContent, setContext, UriIcon, makeWebviewCommandUriString } from '../util';

import { extensionContext } from '../extension';

import { FocusPlotMessage, InMessage, OutMessage, ToggleStyleMessage, UpdatePlotMessage, HidePlotMessage, AddPlotMessage, PreviewPlotLayout, PreviewPlotLayoutMessage, ToggleFullWindowMessage } from './webviewMessages';
import { HttpgdIdResponse, HttpgdPlotId, HttpgdRendererId } from 'httpgd/lib/types';
import { Response } from 'node-fetch';
import { autoShareBrowser, isGuest, isHost, rHostService, shareServer, isGuestAttached } from '../liveShare';
import { requestFile, server } from '../session';

const commands = [
    'showViewers',
    'openUrl',
    'openExternal',
    'showIndex',
    'toggleStyle',
    'toggleFullWindow',
    'togglePreviewPlots',
    'exportPlot',
    'nextPlot',
    'prevPlot',
    'lastPlot',
    'firstPlot',
    'hidePlot',
    'closePlot',
    'resetPlots',
    'zoomIn',
    'zoomOut'
] as const;

type CommandName = typeof commands[number];

export function initializeHttpgd(): HttpgdManager {
    const httpgdManager = new HttpgdManager();
    for (const cmd of commands) {
        const fullCommand = `r.plot.${cmd}`;
        const cb = httpgdManager.getCommandHandler(cmd);
        extensionContext.subscriptions.push(
            vscode.commands.registerCommand(fullCommand, cb)
        );
    }
    return httpgdManager;
}

export class HttpgdManager {
    viewers: HttpgdViewer[] = [];

    viewerOptions: HttpgdViewerOptions;

    private recentlyActiveViewers = new Map<string, HttpgdViewer[]>();
    private sharedServers = new Map<string, vscode.Disposable>();

    private lastPlotUrl?: string;
    private lastPlotPid?: string;
    
    private static readonly MANUAL_PID = '__manual__';
    private static readonly GUEST_PID = '__guest__';

    constructor() {
        const htmlRoot = extensionContext.asAbsolutePath('html/httpgd');
        this.viewerOptions = {
            parent: this,
            htmlRoot: htmlRoot,
            preserveFocus: true
        };
    }

    public async showViewer(urlString: string, pid: string): Promise<void> {
        this.lastPlotUrl = urlString;
        this.lastPlotPid = pid;
        const url = new URL(urlString);
        const host = url.host;
        const token = url.searchParams.get('token') || undefined;
        const viewers = this.recentlyActiveViewers.get(pid) ?? [];
        const existingPidViewer = viewers.find((viewer) => viewer.host === host);
        const ind = this.viewers.findIndex(
            (viewer) => viewer.host === host
        );
        if (existingPidViewer) {
            const existingIndex = this.viewers.indexOf(existingPidViewer);
            if (existingIndex >= 0) {
                this.viewers.splice(existingIndex, 1);
            }
            this.viewers.unshift(existingPidViewer);
            existingPidViewer.show(true);
            if (pid === HttpgdManager.GUEST_PID) {
                void existingPidViewer.reconnect();
            }
        } else if (ind >= 0) {
            const viewer = this.viewers.splice(ind, 1)[0];
            this.viewers.unshift(viewer);
            viewer.show(true);
            if (pid === HttpgdManager.GUEST_PID) {
                void viewer.reconnect();
            }
            if (!viewers.includes(viewer)) {
                viewers.unshift(viewer);
            }
        } else {
            const conf = config();
            const colorTheme = conf.get('plot.defaults.colorTheme', 'vscode');
            this.viewerOptions.stripStyles = (colorTheme === 'vscode');
            this.viewerOptions.previewPlotLayout = conf.get<PreviewPlotLayout>('plot.defaults.plotPreviewLayout', 'multirow');
            this.viewerOptions.refreshTimeoutLength = conf.get('plot.timing.refreshInterval', 10);
            this.viewerOptions.resizeTimeoutLength = conf.get('plot.timing.resizeInterval', 100);
            this.viewerOptions.fullWindow = conf.get('plot.defaults.fullWindowMode', false);
            this.viewerOptions.token = token;
            const viewer = new HttpgdViewer(host, this.viewerOptions, pid);
            viewers.unshift(viewer);
            
            viewer.webviewPanel?.onDidDispose(() => {
            });
            
            if (isHost() && autoShareBrowser) {
                try {
                    const disposable = await shareServer(url, 'httpgd');
                    rHostService?.notifyGuestPlotManager(urlString);
                    this.trackSharedServer(urlString, disposable);
                } catch (error) {
                    console.error('[HttpgdManager] shareServer failed', error);
                }
            }
        }
        this.recentlyActiveViewers.set(pid, viewers);
    }

    public registerActiveViewer(viewer: HttpgdViewer): void {
        const ind = this.viewers.indexOf(viewer);
        if (ind >= 0) {
            this.viewers.splice(ind, 1);
        }
        this.viewers.unshift(viewer);
    }

    public getRecentViewer(): HttpgdViewer | undefined {
        return this.viewers.find((viewer) => !!viewer.webviewPanel);
    }

    public getNewestViewer(): HttpgdViewer | undefined {
        return this.viewers[0];
    }

    public getCommandHandler(command: CommandName): (...args: any[]) => void {
        return (...args: any[]) => {
            this.handleCommand(command, ...args);
        };
    }

    public setLastPlot(urlString: string, pid: string): void {
        this.lastPlotUrl = urlString;
        this.lastPlotPid = pid;
    }

    public getLastPlotUrl(): string | undefined {
        return this.lastPlotUrl;
    }

    public clearLastPlot(): void {
        this.lastPlotUrl = undefined;
        this.lastPlotPid = undefined;
    }

    public closeGuestViewers(): void {
        this.dropPid(HttpgdManager.GUEST_PID);
        if (this.lastPlotPid === HttpgdManager.GUEST_PID) {
            this.lastPlotUrl = undefined;
            this.lastPlotPid = undefined;
        }
    }

    private normalizeSharedKey(urlString: string): string {
        try {
            return new URL(urlString).host;
        } catch {
            try {
                return new URL(`http://${urlString}`).host;
            } catch {
                return urlString;
            }
        }
    }

    public trackSharedServer(urlString: string, disposable: vscode.Disposable): void {
        const key = this.normalizeSharedKey(urlString);
        const existing = this.sharedServers.get(key);
        if (existing) {
            existing.dispose();
        }
        const originalDispose = disposable.dispose.bind(disposable);
        disposable.dispose = () => {
            try {
                originalDispose();
            } finally {
                this.sharedServers.delete(key);
            }
        };
        this.sharedServers.set(key, disposable);
    }

    public disposeSharedServer(urlString: string): void {
        const key = this.normalizeSharedKey(urlString);
        const existing = this.sharedServers.get(key);
        if (existing) {
            existing.dispose();
        }
    }

    public disposeSharedServers(): void {
        for (const disposable of this.sharedServers.values()) {
            disposable.dispose();
        }
        this.sharedServers.clear();
    }

    public async openUrl(): Promise<void> {
        const clipText = await vscode.env.clipboard.readText();
        const val0 = clipText.trim().split(/[\n ]/)[0];
        const options: vscode.InputBoxOptions = {
            value: val0,
            prompt: 'Please enter the httpgd url'
        };
        const urlString = await vscode.window.showInputBox(options);
        if (urlString) {
            await this.showViewer(urlString, HttpgdManager.MANUAL_PID);
        }
    }
    
    public async showGuestViewer(urlString: string): Promise<void> {
      await this.showViewer(urlString, HttpgdManager.GUEST_PID);
    }
    
    public hasViewer(pid: string): boolean {
      const viewers = this.recentlyActiveViewers.get(pid);
      return !!viewers && viewers.some(v => v.webviewPanel);
    }
    
    public dropPid(pid: string): void {
        const viewers = this.recentlyActiveViewers.get(pid);
        if (!viewers) return;
        
        viewers.forEach(v => v.webviewPanel?.dispose());
        this.recentlyActiveViewers.delete(pid);
    }

    // generic command handler
    public handleCommand(command: CommandName, hostOrWebviewUri?: string | vscode.Uri, ...args: any[]): void {
        // the number and type of arguments given to a command can vary, depending on where it was called from:
        // - calling from the title bar menu provides two arguments, the first of which identifies the webview
        // - calling from the command palette provides no arguments
        // - calling from a command uri provides a flexible number/type of arguments
        // below  is an attempt to handle these different combinations efficiently and (somewhat) robustly
        //

        if (command === 'showViewers') {
            void (async () => {
                if (isGuest() && !isGuestAttached()) {
                    void vscode.window.showWarningMessage('Attach to the host R session before showing plot viewers.');
                    return;
                }
                if (!server && !isGuest()) {
                    for (const viewers of this.recentlyActiveViewers.values()) {
                        viewers.forEach(v => v.show(true));
                    }
                    return;
                }
                if (this.recentlyActiveViewers.size === 0 && requestFile) {
                    const requestContent = await readContent(requestFile, 'utf8');
                    if (typeof requestContent === 'string') {
                        try {
                            const request = JSON.parse(requestContent) as { plot_url?: string; pid?: string };
                            if (request.plot_url && request.pid) {
                                const url = new URL(request.plot_url);
                                const token = url.searchParams.get('token') || undefined;
                                const probe = new Httpgd(url.host, token, true);
                                try {
                                    await probe.connect();
                                } catch {
                                    void vscode.window.showWarningMessage('No active shared plot server.');
                                    return;
                                } finally {
                                    probe.disconnect();
                                }
                                const pidToUse = isGuest() ? HttpgdManager.GUEST_PID : String(request.pid);
                                await this.showViewer(request.plot_url, pidToUse);
                                return;
                            }
                        } catch {
                            // Ignore malformed request content.
                        }
                    }
                }
                if (this.recentlyActiveViewers.size === 0 && this.lastPlotUrl && this.lastPlotPid) {
                    try {
                        const url = new URL(this.lastPlotUrl);
                        const token = url.searchParams.get('token') || undefined;
                        const probe = new Httpgd(url.host, token, true);
                        try {
                            await probe.connect();
                        } catch {
                            void vscode.window.showWarningMessage('No active shared plot server.');
                            return;
                        } finally {
                            probe.disconnect();
                        }
                    } catch {
                        void vscode.window.showWarningMessage('No active shared plot server.');
                        return;
                    }
                    await this.showViewer(this.lastPlotUrl, this.lastPlotPid);
                    return;
                }
                for (const viewers of this.recentlyActiveViewers.values()) {
                    viewers.forEach(v => v.show(true));
                }
            })();
            return;
        } else if (command === 'openUrl') {
            void this.openUrl();
            return;
        }

        // Identify the correct viewer
        let viewer: HttpgdViewer | undefined;
        if (typeof hostOrWebviewUri === 'string') {
            const host = hostOrWebviewUri;
            viewer = this.viewers.find((viewer) => viewer.host === host);
        } else if (hostOrWebviewUri instanceof vscode.Uri) {
            const uri = hostOrWebviewUri;
            viewer = this.viewers.find((viewer) => viewer.getPanelPath() === uri.path);
        }

        // fall back to most recent viewer
        viewer ||= this.getRecentViewer();

        // Abort if no viewer identified
        if (!viewer) {
            return;
        }

        // Get possible arguments for commands:
        const stringArg = findItemOfType(args, 'string');
        const boolArg = findItemOfType(args, 'boolean');

        // Call corresponding method, possibly with an argument:
        switch (command) {
            case 'showIndex': {
                void viewer.focusPlot(stringArg);
                break;
            } case 'nextPlot': {
                void viewer.nextPlot(boolArg);
                break;
            } case 'prevPlot': {
                void viewer.prevPlot(boolArg);
                break;
            } case 'lastPlot': {
                void viewer.nextPlot(true);
                break;
            } case 'firstPlot': {
                void viewer.prevPlot(true);
                break;
            } case 'resetPlots': {
                viewer.resetPlots();
                break;
            } case 'toggleStyle': {
                void viewer.toggleStyle(boolArg);
                break;
            } case 'togglePreviewPlots': {
                void viewer.togglePreviewPlots(stringArg as PreviewPlotLayout);
                break;
            } case 'closePlot': {
                void viewer.closePlot(stringArg);
                break;
            } case 'hidePlot': {
                void viewer.hidePlot(stringArg);
                break;
            } case 'exportPlot': {
                void viewer.exportPlot(stringArg);
                break;
            } case 'zoomIn': {
                void viewer.zoomIn();
                break;
            } case 'zoomOut': {
                void viewer.zoomOut();
                break;
            } case 'openExternal': {
                void viewer.openExternal();
                break;
            } case 'toggleFullWindow': {
                void viewer.toggleFullWindow();
                break;
            } default: {
                break;
            }
        }
    }
}


interface EjsData {
    overwriteStyles: boolean;
    previewPlotLayout: PreviewPlotLayout;
    activePlot?: HttpgdPlotId;
    plots: HttpgdPlot<string>[];
    largePlot: HttpgdPlot<string>;
    host: string;
    asLocalPath: (relPath: string) => string;
    asWebViewPath: (localPath: string) => string;
    makeCommandUri: (command: string, ...args: any[]) => string;
    overwriteCssPath: string;

    // only used to render an individual smallPlot div:
    plot?: HttpgdPlot<string>;
}

interface ShowOptions {
    viewColumn: vscode.ViewColumn,
    preserveFocus?: boolean
}

export class HttpgdViewer implements IHttpgdViewer {

    readonly parent: HttpgdManager;

    readonly host: string;
    readonly token?: string;

    // Actual webview where the plot viewer is shown
    // Will have to be created anew, if the user closes it and the plot changes
    webviewPanel?: vscode.WebviewPanel;

    // Api that provides plot contents etc.
    readonly api: Httpgd;

    // active plots
    plots: HttpgdPlot<string>[] = [];

    // Id of the currently viewed plot
    activePlot?: HttpgdPlotId;

    // Ids of plots that are not shown, but not closed inside httpgd
    hiddenPlots: HttpgdPlotId[] = [];

    readonly defaultStripStyles: boolean = true;
    stripStyles: boolean;

    readonly defaultPreviewPlotLayout: PreviewPlotLayout = 'multirow';
    previewPlotLayout: PreviewPlotLayout;

    readonly defaultFullWindow: boolean = false;
    fullWindow: boolean;

    // Custom file to be used instead of `styleOverwrites.css`
    customOverwriteCssPath?: string;

    // Size of the view area:
    viewHeight: number = 600;
    viewWidth: number = 800;

    // Size of the shown plot (as computed):
    plotHeight: number = 600;
    plotWidth: number = 800;

    readonly zoom0: number = 1;
    zoom: number = this.zoom0;

    protected resizeTimeout?: NodeJS.Timeout;
    readonly resizeTimeoutLength: number = 1300;

    protected refreshTimeout?: NodeJS.Timeout;
    readonly refreshTimeoutLength: number = 10;

    private lastExportUri?: vscode.Uri;

    readonly htmlTemplate: string;
    readonly smallPlotTemplate: string;
    readonly htmlRoot: string;

    readonly showOptions: ShowOptions;
    readonly webviewOptions: vscode.WebviewPanelOptions & vscode.WebviewOptions;
    
    private pid?: string;
    private guestConnectionTimer?: NodeJS.Timeout;

    // Computed properties:

    // Get/set active plot by index instead of id:
    protected get activeIndex(): number {
        if(!this.activePlot){
            return -1;
        }
        return this.getIndex(this.activePlot);
    }
    protected set activeIndex(ind: number) {
        if (this.plots.length === 0) {
            this.activePlot = undefined;
        } else {
            ind = Math.max(ind, 0);
            ind = Math.min(ind, this.plots.length - 1);
            this.activePlot = this.plots[ind].id;
        }
    }

    // constructor called by the session watcher if a corresponding function was called in R
    // creates a new api instance itself
    constructor(host: string, options: HttpgdViewerOptions, pid?: string) {
        this.host = host;
        this.token = options.token;
        this.parent = options.parent;
        this.pid = pid;

        this.api = new Httpgd(this.host, this.token, true);
        this.api.onPlotsChanged((newState) => {
            void this.refreshPlotsDelayed(newState.plots);
        });
        this.api.onConnectionChanged(() => {
            // todo
        });
        this.api.onDeviceActiveChanged(() => {
            // todo
        });
        const conf = config();
        this.customOverwriteCssPath = conf.get('plot.customStyleOverwrites', '');
        const localResourceRoots = (
            this.customOverwriteCssPath ?
                [extensionContext.extensionUri, vscode.Uri.file(path.dirname(this.customOverwriteCssPath))] :
                undefined
        );
        this.htmlRoot = options.htmlRoot;
        this.htmlTemplate = fs.readFileSync(path.join(this.htmlRoot, 'index.ejs'), 'utf-8');
        this.smallPlotTemplate = fs.readFileSync(path.join(this.htmlRoot, 'smallPlot.ejs'), 'utf-8');
        this.showOptions = {
            viewColumn: options.viewColumn ?? asViewColumn(conf.get<string>('session.viewers.viewColumn.plot'), vscode.ViewColumn.Two),
            preserveFocus: !!options.preserveFocus
        };
        this.webviewOptions = {
            enableCommandUris: true,
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: localResourceRoots
        };
        this.defaultStripStyles = options.stripStyles ?? this.defaultStripStyles;
        this.stripStyles = this.defaultStripStyles;
        this.defaultPreviewPlotLayout = options.previewPlotLayout ?? this.defaultPreviewPlotLayout;
        this.previewPlotLayout = this.defaultPreviewPlotLayout;
        this.defaultFullWindow = options.fullWindow ?? this.defaultFullWindow;
        this.fullWindow = this.defaultFullWindow;
        this.resizeTimeoutLength = options.refreshTimeoutLength ?? this.resizeTimeoutLength;
        this.refreshTimeoutLength = options.refreshTimeoutLength ?? this.refreshTimeoutLength;
        void this.api.connect();
        this.startGuestHeartbeat();
        //void this.checkState();
    }

    private startGuestHeartbeat(): void {
        if (!isGuest() || this.guestConnectionTimer) {
            return;
        }
        this.guestConnectionTimer = setInterval(async () => {
            try {
                await this.api.updatePlots();
            } catch (error) {
                console.error('[HttpgdViewer] guest connection lost', error);
                if (this.guestConnectionTimer) {
                    clearInterval(this.guestConnectionTimer);
                    this.guestConnectionTimer = undefined;
                }
                this.dispose();
                this.parent.dropPid(this.pid ?? '__guest__');
            }
        }, 5000);
    }

    // Methods to interact with the webview
    // Can e.g. be called by vscode commands + menu items:

    // Called to create a new webview if the user closed the old one:
    public show(preserveFocus?: boolean): void {
        preserveFocus ??= this.showOptions.preserveFocus;
        if (!this.webviewPanel) {
            const showOptions = {
                ...this.showOptions,
                preserveFocus: preserveFocus
            };
            this.webviewPanel = this.makeNewWebview(showOptions, this.pid);
            this.refreshHtml();
        } else {
            this.webviewPanel.reveal(undefined, preserveFocus);
        }
        this.parent.registerActiveViewer(this);
        this.startGuestHeartbeat();
    }

    public async reconnect(): Promise<void> {
        try {
            this.api.disconnect();
            await this.api.connect();
            this.startGuestHeartbeat();
        } catch (error) {
            console.error('[HttpgdViewer] reconnect failed', error);
        }
    }

    public openExternal(): void {
        let urlString = `http://${this.host}/live`;
        if (this.token) {
            urlString += `?token=${this.token}`;
        }
        const uri = vscode.Uri.parse(urlString);
        void vscode.env.openExternal(uri);
    }

    // focus a specific plot id
    public async focusPlot(id?: HttpgdPlotId): Promise<void> {
        this.activePlot = id || this.activePlot;
        const plt = this.plots[this.activeIndex];
        if (plt.height !== this.viewHeight || plt.width !== this.viewHeight || plt.zoom !== this.zoom) {
            await this.refreshPlots(this.api.getPlots());
        } else {
            this._focusPlot();
        }
    }
    protected _focusPlot(plotId?: HttpgdPlotId): void {
        plotId ??= this.activePlot;
        if(!plotId){
            return;
        }
        const msg: FocusPlotMessage = {
            message: 'focusPlot',
            plotId: plotId
        };
        this.postWebviewMessage(msg);
        void this.setContextValues();
    }

    // navigate through plots (supply `true` to go to end/beginning of list)
    public async nextPlot(last?: boolean): Promise<void> {
        this.activeIndex = last ? this.plots.length - 1 : this.activeIndex + 1;
        await this.focusPlot();
    }
    public async prevPlot(first?: boolean): Promise<void> {
        this.activeIndex = first ? 0 : this.activeIndex - 1;
        await this.focusPlot();
    }

    // restore closed plots, reset zoom, redraw html
    public resetPlots(): void {
        this.hiddenPlots = [];
        this.zoom = this.zoom0;
        void this.refreshPlots(this.api.getPlots(), true, true);
    }

    public hidePlot(id?: HttpgdPlotId): void {
        id ??= this.activePlot;
        if (!id) { return; }
        const tmpIndex = this.activeIndex;
        this.hiddenPlots.push(id);
        this.plots = this.plots.filter((plt) => !this.hiddenPlots.includes(plt.id));
        if (id === this.activePlot) {
            this.activeIndex = tmpIndex;
            this._focusPlot();
        }
        this._hidePlot(id);
    }
    protected _hidePlot(id: HttpgdPlotId): void {
        const msg: HidePlotMessage = {
            message: 'hidePlot',
            plotId: id
        };
        this.postWebviewMessage(msg);
    }

    public async closePlot(id?: HttpgdPlotId): Promise<void> {
        id ??= this.activePlot;
        if (id) {
            this.hidePlot(id);
            await this.api.removePlot({ id: id });
        }
    }

    public toggleStyle(force?: boolean): void {
        this.stripStyles = force ?? !this.stripStyles;
        const msg: ToggleStyleMessage = {
            message: 'toggleStyle',
            useOverwrites: this.stripStyles
        };
        this.postWebviewMessage(msg);
    }

    public toggleFullWindow(force?: boolean): void {
        this.fullWindow = force ?? !this.fullWindow;
        const msg: ToggleFullWindowMessage = {
            message: 'toggleFullWindow',
            useFullWindow: this.fullWindow
        };
        this.postWebviewMessage(msg);
    }

    public togglePreviewPlots(force?: PreviewPlotLayout): void {
        if (force) {
            this.previewPlotLayout = force;
        } else if (this.previewPlotLayout === 'multirow') {
            this.previewPlotLayout = 'scroll';
        } else if (this.previewPlotLayout === 'scroll') {
            this.previewPlotLayout = 'hidden';
        } else if (this.previewPlotLayout === 'hidden') {
            this.previewPlotLayout = 'multirow';
        }
        const msg: PreviewPlotLayoutMessage = {
            message: 'togglePreviewPlotLayout',
            style: this.previewPlotLayout
        };
        this.postWebviewMessage(msg);
    }

    public zoomOut(): void {
        if (this.zoom > 0) {
            this.zoom -= 0.1;
            void this.resizePlot();
        }
    }

    public zoomIn(): void {
        this.zoom += 0.1;
        void this.resizePlot();
    }


    public async setContextValues(mightBeInBackground: boolean = false): Promise<void> {
        if (this.webviewPanel?.active) {
            this.parent.registerActiveViewer(this);
            await setContext('r.plot.active', true);
            await setContext('r.plot.canGoBack', this.activeIndex > 0);
            await setContext('r.plot.canGoForward', this.activeIndex < this.plots.length - 1);
        } else if (!mightBeInBackground) {
            await setContext('r.plot.active', false);
        }
    }

    public getPanelPath(): string | undefined {
        if (!this.webviewPanel) {
            return undefined;
        }
        const dummyUri = this.webviewPanel.webview.asWebviewUri(vscode.Uri.file(''));
        const m = /^[^.]*/.exec(dummyUri.authority);
        const webviewId = m?.[0] || '';
        return `webview-panel/webview-${webviewId}`;
    }

    protected getIndex(id: HttpgdPlotId): number {
        return this.plots.findIndex((plt: HttpgdPlot<string>) => plt.id === id);
    }

    protected handleResize(height: number, width: number, userTriggered: boolean = false): void {
        this.viewHeight = height;
        this.viewWidth = width;
        if (userTriggered || this.resizeTimeoutLength === 0) {
            if(this.resizeTimeout){
                clearTimeout(this.resizeTimeout);
            }
            this.resizeTimeout = undefined;
            void this.resizePlot();
        } else if (!this.resizeTimeout) {
            this.resizeTimeout = setTimeout(() => {
                void this.resizePlot().then(() =>
                    this.resizeTimeout = undefined
                );
            }, this.resizeTimeoutLength);
        }
    }

    protected async resizePlot(id?: HttpgdPlotId): Promise<void> {
        id ??= this.activePlot;
        if (!id) { return; }
        const plt = await this.getPlotContent(id, this.viewWidth, this.viewHeight, this.zoom);
        this.plotWidth = plt.width;
        this.plotHeight = plt.height;
        this.updatePlot(plt);
    }

    protected async refreshPlotsDelayed(plotsIdResponse: HttpgdIdResponse[], redraw: boolean = false, force: boolean = false): Promise<void> {
        if(this.refreshTimeoutLength === 0){
            await this.refreshPlots(plotsIdResponse, redraw, force);
        } else{
            clearTimeout(this.refreshTimeout);
            this.refreshTimeout = setTimeout(() => {
                void this.refreshPlots(plotsIdResponse, redraw, force).then(() =>
                    this.refreshTimeout = undefined
                );
            }, this.refreshTimeoutLength);
        }
    }

    protected async refreshPlots(plotsIdResponse: HttpgdIdResponse[], redraw: boolean = false, force: boolean = false): Promise<void> {
        const nPlots = this.plots.length;
        let plotIds = plotsIdResponse.map((x) => x.id);
        plotIds = plotIds.filter((id) => !this.hiddenPlots.includes(id));
        const newPlotPromises = plotIds.map(async (id) => {
            const plot = this.plots.find((plt) => plt.id === id);
            if (force || !plot || id === this.activePlot) {
                return await this.getPlotContent(id, this.viewWidth, this.viewHeight, this.zoom);
            } else {
                return plot;
            }
        });
        const newPlots = await Promise.all(newPlotPromises);
        const oldPlotIds = this.plots.map(plt => plt.id);
        this.plots = newPlots;
        if (this.plots.length !== nPlots) {
            this.activePlot = this.plots[this.plots.length - 1]?.id;
        }
        if (redraw || !this.webviewPanel) {
            this.refreshHtml();
        } else {
            for (const plt of this.plots) {
                if (oldPlotIds.includes(plt.id)) {
                    this.updatePlot(plt);
                } else {
                    this.addPlot(plt);
                }
            }
            this._focusPlot();
        }
    }

    protected updatePlot(plt: HttpgdPlot<string>): void {
        const msg: UpdatePlotMessage = {
            message: 'updatePlot',
            plotId: plt.id,
            svg: plt.data
        };
        this.postWebviewMessage(msg);
    }

    protected addPlot(plt: HttpgdPlot<string>): void {
        const ejsData = this.makeEjsData();
        ejsData.plot = plt;
        const html = ejs.render(this.smallPlotTemplate, ejsData);
        const msg: AddPlotMessage = {
            message: 'addPlot',
            html: html
        };
        this.postWebviewMessage(msg);
        void this.focusPlot(plt.id);
        void this.setContextValues();
    }

    // get content of a single plot
    protected async getPlotContent(id: HttpgdPlotId, width: number, height: number, zoom: number): Promise<HttpgdPlot<string>> {

        const args = {
            id: id,
            height: height,
            width: width,
            zoom: zoom,
            renderer: 'svgp'
        };

        const plotContent = await this.api.getPlot(args);
        const svg = await plotContent?.text() || '';

        const plt: HttpgdPlot<string> = {
            id: id,
            data: svg,
            height: height,
            width: width,
            zoom: zoom,
        };

        this.viewHeight ??= plt.height;
        this.viewWidth ??= plt.width;
        return plt;
    }


    // functions for initial or re-drawing of html:

    protected refreshHtml(): void {
        this.webviewPanel ??= this.makeNewWebview(undefined, this.pid);
        this.webviewPanel.webview.html = '';
        this.webviewPanel.webview.html = this.makeHtml();
        // make sure that fullWindow is set correctly:
        this.toggleFullWindow(this.fullWindow);
        void this.setContextValues(true);
    }

    protected makeHtml(): string {
        const ejsData = this.makeEjsData();
        const html = ejs.render(this.htmlTemplate, ejsData);
        return html;
    }

    protected makeEjsData(): EjsData {
        const asLocalPath = (relPath: string) => {
            if (!this.webviewPanel) {
                return relPath;
            }
            const localUri = vscode.Uri.file(path.join(this.htmlRoot, relPath));
            return localUri.fsPath;
        };
        const asWebViewPath = (localPath: string) => {
            if (!this.webviewPanel) {
                return localPath;
            }
            const localUri = vscode.Uri.file(path.join(this.htmlRoot, localPath));
            const webViewUri = this.webviewPanel.webview.asWebviewUri(localUri);
            return webViewUri.toString();
        };
        let overwriteCssPath = '';
        if (this.customOverwriteCssPath) {
            const uri = vscode.Uri.file(this.customOverwriteCssPath);
            overwriteCssPath = this.webviewPanel?.webview.asWebviewUri(uri).toString() || '';
        } else {
            overwriteCssPath = asWebViewPath('styleOverwrites.css');
        }
        const ejsData: EjsData = {
            overwriteStyles: this.stripStyles,
            previewPlotLayout: this.previewPlotLayout,
            plots: this.plots,
            largePlot: this.plots[this.activeIndex],
            activePlot: this.activePlot,
            host: this.host,
            asLocalPath: asLocalPath,
            asWebViewPath: asWebViewPath,
            makeCommandUri: makeWebviewCommandUriString,
            overwriteCssPath: overwriteCssPath
        };
        return ejsData;
    }

    protected makeNewWebview(
      showOptions?: ShowOptions,
      titleSuffix?: string
    ): vscode.WebviewPanel {
        const title = titleSuffix ? `R Plot (${titleSuffix})` : 'R Plot';
        const webviewPanel = vscode.window.createWebviewPanel(
            'RPlot',
            title,
            showOptions || this.showOptions,
            this.webviewOptions
        );
        webviewPanel.iconPath = new UriIcon('graph');
        webviewPanel.onDidDispose(() => {
            if (this.guestConnectionTimer) {
                clearInterval(this.guestConnectionTimer);
                this.guestConnectionTimer = undefined;
            }
            this.webviewPanel = undefined;
        });
        webviewPanel.onDidChangeViewState(() => {
            void this.setContextValues();
        });
        webviewPanel.webview.onDidReceiveMessage((e: OutMessage) => {
            this.handleWebviewMessage(e);
        });
        return webviewPanel;
    }

    protected handleWebviewMessage(msg: OutMessage): void {
        if (msg.message === 'log') {
            console.log(msg.body);
        } else if (msg.message === 'resize') {
            const height = msg.height;
            const width = msg.width;
            const userTriggered = msg.userTriggered;
            void this.handleResize(height, width, userTriggered);
        }
    }

    protected postWebviewMessage(msg: InMessage): void {
        void this.webviewPanel?.webview.postMessage(msg);
    }


    // export plot
    // if no format supplied, show a quickpick menu etc.
    // if no filename supplied, show selector window
    public async exportPlot(id?: HttpgdPlotId, rendererId?: HttpgdRendererId, outFile?: string): Promise<void> {
        // make sure id is valid or return:
        id ||= this.activePlot || this.plots[this.plots.length - 1]?.id;
        const plot = this.plots.find((plt) => plt.id === id);
        if (!plot) {
            void vscode.window.showWarningMessage('No plot available for export.');
            return;
        }
        // make sure format is valid or return:
        if (!rendererId) {
            const renderers = this.api.getRenderers();
            const qpItems  = renderers.map(renderer => ({
                label: renderer.name,
                detail: renderer.descr,
                id: renderer.id
            }));
            const options: vscode.QuickPickOptions = {
                placeHolder: 'Please choose a file format'
            };
            // format = await vscode.window.showQuickPick(formats, options);
            const qpPick = await vscode.window.showQuickPick(qpItems, options);
            rendererId = qpPick?.id;
            if(!rendererId){
                return;
            }
        }
        // make sure outFile is valid or return:
        if (!outFile) {
            const options: vscode.SaveDialogOptions = {};

            // Suggest a file extension:
            const renderer = this.api.getRenderers().find(r => r.id === rendererId);
            const ext = renderer?.ext.replace(/^\./, '');

            // try to set default URI:
            if(this.lastExportUri){
                const noExtPath = this.lastExportUri.fsPath.replace(/\.[^.]*$/, '');
                const defaultPath = noExtPath + (ext ? `.${ext}` : '');
                options.defaultUri = vscode.Uri.file(defaultPath);
            } else {
                // construct default Uri
                const defaultFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if(defaultFolder){
                    const defaultName = 'plot' + (ext ? `.${ext}` : '');
                    options.defaultUri = vscode.Uri.file(path.join(defaultFolder, defaultName));
                }
            }
            // set file extension filter
            if(ext && renderer?.name){
                options.filters = {
                    [renderer.name]: [ext],
                    ['All']: ['*'],
                };
            }

            const outUri = await vscode.window.showSaveDialog(options);
            if(outUri){
                this.lastExportUri = outUri;
                outFile = outUri.fsPath;
            } else {
                return;
            }
        }
        // get plot:
        const plt = await this.api.getPlot({
            id: this.activePlot,
            renderer: rendererId
        }) as unknown as Response; // I am not sure why eslint thinks this is the
        // browser Response object and not the node-fetch one.
        // cross-fetch problem or config problem in vscode-r?

        const dest = fs.createWriteStream(outFile);
        dest.on('error', (err) => void vscode.window.showErrorMessage(
            `Export failed: ${err.message}`
        ));
        dest.on('close', () => void vscode.window.showInformationMessage(
            `Export done: ${outFile || ''}`
        ));
        void plt.body.pipe(dest);
    }

    // Dispose-function to clean up when vscode closes
    // E.g. to close connections etc., notify R, ...
    public dispose(): void {
        if (this.guestConnectionTimer) {
            clearInterval(this.guestConnectionTimer);
            this.guestConnectionTimer = undefined;
        }
        this.api.disconnect();
    }
}

// helper function to handle argument lists that might contain (useless) extra arguments
function findItemOfType(arr: any[], type: 'string'): string | undefined;
function findItemOfType(arr: any[], type: 'boolean'): boolean | undefined;
function findItemOfType(arr: any[], type: 'number'): number | undefined;
function findItemOfType<T = unknown>(arr: any[], type: string): T {
    const item = arr.find((elm) => typeof elm === type) as T;
    return item;
}
