
import * as vscode from 'vscode';
import { PlotViewer, PlotManager } from './types';
import { HttpgdManager, HttpgdViewer } from './httpgdViewer';
export { HttpgdManager };
import { StandardPlotViewer } from './standardViewer';
import { JgdManager } from './jgdViewer';
import { extensionContext } from '../extension';
import { config } from '../util';
import { getMigratedSetting } from '../configuration';

export function resolveBackend(): 'auto' | 'standard' | 'httpgd' | 'jgd' {
    const selected = getMigratedSetting<string | boolean>(
        config(),
        'plot.backend',
        'plot.useHttpgd',
        value => value !== 'auto' && value !== false
    )?.value;
    if (selected === true) {
        return 'httpgd';
    }
    return typeof selected === 'string' ? selected as 'standard' | 'httpgd' | 'jgd' : 'auto';
}

export function jgdEnabled(backend = resolveBackend()): boolean {
    return backend === 'jgd' || backend === 'auto';
}

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

export class CommonPlotManager implements PlotManager {
    public httpgdManager: HttpgdManager;
    public standardPlotViewer: StandardPlotViewer;
    public jgdManager: JgdManager;
    private standardPlotViewers = new Map<string, StandardPlotViewer>();
    private activeSessionId: string | undefined;
    private restoredPanels = new Map<vscode.WebviewPanel, string | undefined>();

    constructor() {
        this.httpgdManager = new HttpgdManager();
        this.standardPlotViewer = new StandardPlotViewer();
        this.jgdManager = new JgdManager();
        this.jgdManager.setOnViewerShown(sessionId => this.consumeRestoredPanels(sessionId));
    }

    private getStandardPlotViewer(sessionId?: string): StandardPlotViewer {
        if (!sessionId) {
            return this.standardPlotViewer;
        }
        let viewer = this.standardPlotViewers.get(sessionId);
        if (!viewer) {
            viewer = new StandardPlotViewer(sessionId);
            this.standardPlotViewers.set(sessionId, viewer);
        }
        return viewer;
    }

    get viewers(): PlotViewer[] {
        const sessionId = this.activeSessionId;
        const viewers: PlotViewer[] = [...this.httpgdManager.getViewers(sessionId)];
        const jgdViewer = this.jgdManager.getViewer(sessionId);
        if (jgdViewer) viewers.push(jgdViewer);
        viewers.push(this.getStandardPlotViewer(sessionId));
        return viewers;
    }

    get activeViewer(): PlotViewer | undefined {
        const sessionId = this.activeSessionId;
        if (jgdEnabled()) {
            return this.jgdManager.getViewer(sessionId) ||
                this.httpgdManager.getRecentViewer(sessionId) ||
                this.getStandardPlotViewer(sessionId);
        }
        return this.httpgdManager.getRecentViewer(sessionId) || this.getStandardPlotViewer(sessionId);
    }

    public initialize(): void {
        this.jgdManager.initialize(extensionContext.extensionUri);

        for (const viewType of ['RPlot', 'jgd.plotPane', 'r.standardPlot']) {
            extensionContext.subscriptions.push(
                vscode.window.registerWebviewPanelSerializer(viewType, {
                    deserializeWebviewPanel: async (panel) => {
                        this.restoredPanels.set(panel, this.activeSessionId);
                        panel.webview.html = '<!doctype html><html><body>Restoring R plot for the active session...</body></html>';
                        panel.onDidDispose(() => this.restoredPanels.delete(panel));
                    }
                })
            );
        }

        for (const cmd of commands) {
            const fullCommand = `r.plot.${cmd}`;
            extensionContext.subscriptions.push(
                vscode.commands.registerCommand(fullCommand, (hostOrWebviewUri?: string | vscode.Uri, ...args: unknown[]) => {
                    void this.handleCommand(cmd, hostOrWebviewUri, ...args);
                })
            );
        }

        this.applyBackend();
        extensionContext.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('r.plot.backend') || e.affectsConfiguration('r.plot.useHttpgd')) {
                    this.applyBackend();
                }
            })
        );
    }

    // Start the JGD server when the backend allows it, so switching to jgd
    // takes effect on the next R (re)start without reloading VS Code.
    private applyBackend(): void {
        const backend = resolveBackend();
        void vscode.commands.executeCommand('setContext', 'r.plot.backend', backend);
        if (!jgdEnabled(backend)) {
            return;
        }
        this.jgdManager.start();
        // Set JGD_SOCKET env var for R child processes
        const envCollection = extensionContext.environmentVariableCollection;
        envCollection.persistent = false;
        for (const [key, value] of Object.entries(this.getJgdEnvVars())) {
            envCollection.replace(key, value);
        }
    }

    public setActiveSession(sessionId?: string): void {
        this.activeSessionId = sessionId;
        this.jgdManager.setActiveSession(sessionId);
        for (const panel of this.restoredPanels.keys()) {
            this.restoredPanels.set(panel, sessionId);
        }
    }

    public disposeSession(sessionId: string): void {
        this.httpgdManager.disposeSession(sessionId);
        this.standardPlotViewers.get(sessionId)?.dispose();
        this.standardPlotViewers.delete(sessionId);
        this.jgdManager.disposeSession(sessionId);
        for (const [panel, owner] of [...this.restoredPanels]) {
            if (owner === sessionId) {
                this.restoredPanels.delete(panel);
                panel.dispose();
            }
        }
        if (this.activeSessionId === sessionId) {
            this.activeSessionId = undefined;
        }
    }

    private consumeRestoredPanels(sessionId?: string): void {
        if (!sessionId) return;
        for (const [panel, owner] of [...this.restoredPanels]) {
            if (owner === sessionId) {
                this.restoredPanels.delete(panel);
                panel.dispose();
            }
        }
    }

    public async showStandardPlot(sessionId = this.activeSessionId): Promise<void> {
        await this.getStandardPlotViewer(sessionId).update();
        this.consumeRestoredPanels(sessionId);
    }

    public async showHttpgdPlot(url: string, sessionId = this.activeSessionId): Promise<void> {
        await this.httpgdManager.showViewer(url, sessionId);
        this.consumeRestoredPanels(sessionId);
    }

    public getJgdEnvVars(): Record<string, string> {
        return this.jgdManager.getEnvVars();
    }

    public dispose(): void {
        this.httpgdManager.dispose();
        this.standardPlotViewer.dispose();
        for (const viewer of this.standardPlotViewers.values()) {
            viewer.dispose();
        }
        this.standardPlotViewers.clear();
        this.jgdManager.stop();
        for (const panel of this.restoredPanels.keys()) {
            panel.dispose();
        }
        this.restoredPanels.clear();
    }

    private async handleCommand(command: string, hostOrWebviewUri?: string | vscode.Uri, ...args: unknown[]): Promise<void> {
        if (command === 'showViewers') {
            if (!this.activeSessionId) {
                for (const viewer of this.viewers) {
                    viewer.show(true);
                }
                return;
            }
            const interactive: PlotViewer[] = [...this.httpgdManager.getViewers(this.activeSessionId)];
            const jgdViewer = this.jgdManager.getViewer(this.activeSessionId);
            if (jgdViewer) interactive.push(jgdViewer);
            if (interactive.length) {
                for (const viewer of interactive) {
                    viewer.show(true);
                }
                this.consumeRestoredPanels(this.activeSessionId);
            } else {
                await this.showStandardPlot(this.activeSessionId);
            }
            return;
        }

        if (command === 'openUrl') {
            await this.httpgdManager.openUrl(this.activeSessionId);
            return;
        }

        // Identify the correct viewer
        let viewer: PlotViewer | undefined;
        if (typeof hostOrWebviewUri === 'string') {
            viewer = this.httpgdManager.viewers.find((v: HttpgdViewer) => v.host === hostOrWebviewUri);
        } else if (hostOrWebviewUri instanceof vscode.Uri) {
            viewer = this.httpgdManager.viewers.find((v: HttpgdViewer) => v.getPanelPath() === hostOrWebviewUri.path);
        }

        // Fallback to active viewer
        viewer ||= this.activeViewer;

        if (viewer) {
            await viewer.handleCommand(command, ...args);
        }
    }
}

export function initializePlotManager(): PlotManager {
    const manager = new CommonPlotManager();
    manager.initialize();
    return manager;
}
