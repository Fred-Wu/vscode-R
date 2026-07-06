'use strict';

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { Agent } from 'http';
import fetch from 'node-fetch';
import { commands, StatusBarItem, Uri, ViewColumn, Webview, window, workspace, env, WebviewPanelOnDidChangeViewStateEvent, WebviewPanel, Tab } from 'vscode';

import { runTextInTerm } from './rTerminal';
import { FSWatcher } from 'fs-extra';
import { config, readContent, setContext, UriIcon} from './util';
import { purgeAddinPickerItems, dispatchRStudioAPICall } from './rstudioapi';

import { IRequest } from './liveShare/shareSession';
import { homeExtDir, rWorkspace, globalRHelp, globalHttpgdManager, extensionContext, sessionStatusBarItem } from './extension';
import { UUID, rHostService, rGuestService, isLiveShare, isHost, isGuestSession, closeBrowser, browserDisposables, guestResDir, shareBrowser, openVirtualDoc, shareWorkspace } from './liveShare';


export interface GlobalEnv {
    [key: string]: {
        class: string[] | string;
        type: string;
        length: number;
        str: string;
        size?: number;
        dim?: number[],
        names?: string[],
        slots?: string[],
        has_children?: boolean
    }
}

export interface WorkspaceData {
    search: string[];
    loaded_namespaces: string[];
    globalenv: GlobalEnv;
}

export interface SessionServer {
    host: string;
    port: number;
    token: string;
}

interface WebviewMessage {
    command: string;
    start?: number;
    end?: number;
}

interface PanelWithFetchFlag {
  _hasFetchHandler?: boolean;
  _hasViewStateHandler?: boolean;
}

export let workspaceData: WorkspaceData;
let resDir: string;
export let requestFile: string;
export let requestLockFile: string;
let requestTimeStamp: number;
let responseTimeStamp: number;
export let sessionDir: string;
export let workingDir: string;
let rVer: string;
let pid: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let info: any;
const httpAgent = new Agent({ keepAlive: true });
export let server: SessionServer | undefined;
let workspaceLockFile: string;
let workspaceTimeStamp: number;
let plotFile: string;
let plotLockFile: string;
let plotTimeStamp: number;
let workspaceWatcher: FSWatcher;
let plotWatcher: FSWatcher;
let workspaceRefreshTimer: NodeJS.Timeout | undefined;
let workspaceRefreshInProgress = false;
let workspaceRefreshPending = false;
let activeBrowserPanel: WebviewPanel | undefined;
let activeBrowserUri: Uri | undefined;
let activeBrowserExternalUri: Uri | undefined;

// Add a map to track dataview panels by UUID
const dataviewPanels = new Map<string, WebviewPanel>();
const dataviewPanelInfo = new Map<WebviewPanel, {
    title: string;
    source: string;
    viewId: string;
    generation?: number;
    pid?: string;
    server?: SessionServer;
}>();
const sessionServers = new Map<string, SessionServer>();
let activeDataViewPanel: WebviewPanel | undefined;

export function disposeDataViewPanels(): void {
    for (const panel of dataviewPanels.values()) {
        try {
            panel.dispose();
        } catch (error) {
            console.error('[disposeDataViewPanels] dispose failed', error);
        }
    }
    dataviewPanels.clear();
}

async function closeSessionViewers(options?: { includeHelp?: boolean }): Promise<void> {
    const includeHelp = options?.includeHelp ?? false;
    const tabsToClose: Tab[] = [];
    for (const group of window.tabGroups.all) {
        for (const tab of group.tabs) {
            const input = tab.input as { viewType?: string } | undefined;
            const viewType = input?.viewType;
            const normalizedViewType = viewType?.split('-').pop()?.toLowerCase();
            if (
                normalizedViewType === 'dataview' ||
                normalizedViewType === 'rplot' ||
                (includeHelp && normalizedViewType === 'rhelp')
            ) {
                tabsToClose.push(tab);
            }
        }
    }
    if (tabsToClose.length) {
        await window.tabGroups.close(tabsToClose, true);
    }
}

let tabCleanupDisposable: { dispose(): void } | undefined;

function scheduleSessionViewerCleanup(): void {
    if (tabCleanupDisposable || isLiveShare()) {
        return;
    }
    tabCleanupDisposable = window.tabGroups.onDidChangeTabs(() => {
        if (pid) {
            tabCleanupDisposable?.dispose();
            tabCleanupDisposable = undefined;
            return;
        }
        void closeSessionViewers({ includeHelp: true });
    });
    void closeSessionViewers({ includeHelp: true });
}

export function deploySessionWatcher(extensionPath: string): void {
    console.info(`[deploySessionWatcher] extensionPath: ${extensionPath}`);
    resDir = path.join(extensionPath, 'dist', 'resources');

    const initPath = path.join(extensionPath, 'R', 'session', 'init.R');
    const linkPath = path.join(homeExtDir(), 'init.R');
    fs.writeFileSync(linkPath, `local(source("${initPath.replace(/\\/g, '\\\\')}", chdir = TRUE, local = TRUE))\n`);

    writeSettings();
    workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('r')) {
            writeSettings();
        }
    });
}

export function startRequestWatcher(sessionStatusBarItem: StatusBarItem): void {
    if (!isLiveShare()) {
        scheduleSessionViewerCleanup();
    }
    console.info('[startRequestWatcher] Starting');
    requestFile = path.join(homeExtDir(), 'request.log');
    requestLockFile = path.join(homeExtDir(), 'request.lock');
    requestTimeStamp = 0;
    responseTimeStamp = 0;
    if (!fs.existsSync(requestLockFile)) {
        fs.createFileSync(requestLockFile);
    }
    fs.watch(requestLockFile, {}, () => {
        void updateRequest(sessionStatusBarItem);
    });
    console.info('[startRequestWatcher] Done');
}

export function attachActive(): void {
    if (config().get<boolean>('sessionWatcher')) {
        console.info('[attachActive]');
        void runTextInTerm('.vsc.attach()');
        if (isLiveShare() && shareWorkspace) {
            rHostService?.notifyRequest(requestFile, true);
        }
    } else {
        void window.showInformationMessage('This command requires that r.sessionWatcher be enabled.');
    }
}

export function getAttachedPid(): string | undefined {
    return pid;
}

export function removeDirectory(dir: string): void {
    console.info(`[removeDirectory] dir: ${dir}`);
    if (fs.existsSync(dir)) {
        console.info('[removeDirectory] dir exists');
        fs.readdirSync(dir)
            .forEach((file) => {
                const curPath = path.join(dir, file);
                console.info(`[removeDirectory] Remove ${curPath}`);
                fs.unlinkSync(curPath);
            });
        console.info(`[removeDirectory] Remove dir ${dir}`);
        fs.rmdirSync(dir);
    }
    console.info('[removeDirectory] Done');
}

export function sessionDirectoryExists(): boolean {
    return (fs.existsSync(sessionDir));
}

export function removeSessionFiles(): void {
    console.info('[removeSessionFiles] ', sessionDir);
    if (sessionDirectoryExists()) {
        removeDirectory(sessionDir);
    }
    console.info('[removeSessionFiles] Done');
}

function writeSettings() {
    const settingPath = path.join(homeExtDir(), 'settings.json');
    fs.writeFileSync(settingPath, JSON.stringify(config()));
}

function updateSessionWatcher() {
    console.info(`[updateSessionWatcher] PID: ${pid}`);
    console.info('[updateSessionWatcher] Create workspaceWatcher');
    workspaceLockFile = path.join(sessionDir, 'workspace.lock');
    workspaceTimeStamp = 0;
    if (workspaceWatcher !== undefined) {
        workspaceWatcher.close();
    }
    if (fs.existsSync(workspaceLockFile)) {
        workspaceWatcher = fs.watch(workspaceLockFile, {}, () => {
            scheduleWorkspaceRefresh();
        });
        scheduleWorkspaceRefresh(0);
    } else {
        console.info('[updateSessionWatcher] workspaceLockFile not found');
    }

    console.info('[updateSessionWatcher] Create plotWatcher');
    plotFile = path.join(sessionDir, 'plot.png');
    plotLockFile = path.join(sessionDir, 'plot.lock');
    plotTimeStamp = 0;
    if (plotWatcher !== undefined) {
        plotWatcher.close();
    }
    if (fs.existsSync(plotLockFile)) {
        plotWatcher = fs.watch(plotLockFile, {}, () => {
            void updatePlot();
        });
        void updatePlot();
    } else {
        console.info('[updateSessionWatcher] plotLockFile not found');
    }
    console.info('[updateSessionWatcher] Done');
}

async function updatePlot() {
    console.info(`[updatePlot] ${plotFile}`);
    const lockContent = await fs.readFile(plotLockFile, 'utf8');
    const newTimeStamp = Number.parseFloat(lockContent);
    if (newTimeStamp !== plotTimeStamp) {
        plotTimeStamp = newTimeStamp;
        if (fs.existsSync(plotFile) && fs.statSync(plotFile).size > 0) {
            void commands.executeCommand('vscode.open', Uri.file(plotFile), {
                preserveFocus: true,
                preview: true,
                viewColumn: ViewColumn[(config().get<string>('session.viewers.viewColumn.plot') || 'Two') as keyof typeof ViewColumn],
            });
            console.info('[updatePlot] Done');
            if (isLiveShare()) {
                void rHostService?.notifyPlot(plotFile);
            }
        } else {
            console.info('[updatePlot] File not found');
        }
    }
}

async function updateWorkspace() {
    if (!server) {
        console.info('[updateWorkspace] R server not available');
        return;
    }

    const lockContent = await fs.readFile(workspaceLockFile, 'utf8');
    const newTimeStamp = Number.parseFloat(lockContent);
    if (Number.isNaN(newTimeStamp)) {
        return;
    }
    if (newTimeStamp !== workspaceTimeStamp) {
        workspaceTimeStamp = newTimeStamp;
        const data = await sessionRequest(server, { type: 'workspace' }) as WorkspaceData | undefined;
        if (data) {
            workspaceData = data;
            void rWorkspace?.refresh();
            console.info('[updateWorkspace] Done');
            if (isLiveShare()) {
                rHostService?.notifyWorkspace(workspaceData);
            }
        } else {
            console.info('[updateWorkspace] No workspace data returned');
        }
    }
}

export function deferWorkspaceRefresh(): void {
    if (workspaceRefreshTimer) {
        clearTimeout(workspaceRefreshTimer);
        workspaceRefreshTimer = undefined;
    }
}

function scheduleWorkspaceRefresh(delayMs: number = 500): void {
    workspaceRefreshPending = true;
    if (workspaceRefreshTimer) {
        clearTimeout(workspaceRefreshTimer);
    }
    workspaceRefreshTimer = setTimeout(() => {
        workspaceRefreshTimer = undefined;
        void runWorkspaceRefresh();
    }, delayMs);
}

async function runWorkspaceRefresh(): Promise<void> {
    if (workspaceRefreshInProgress || !workspaceRefreshPending) {
        return;
    }
    workspaceRefreshPending = false;
    workspaceRefreshInProgress = true;
    try {
        await updateWorkspace();
    } finally {
        workspaceRefreshInProgress = false;
        if (workspaceRefreshPending) {
            scheduleWorkspaceRefresh();
        }
    }
}

export async function showBrowser(url: string, title: string, viewer: string | boolean): Promise<void> {
    console.info(`[showBrowser] uri: ${url}, viewer: ${viewer.toString()}`);
    const uri = Uri.parse(url);
    if (viewer === false) {
        void env.openExternal(uri);
    } else {
        const externalUri = await env.asExternalUri(uri);
        const panel = window.createWebviewPanel(
            'browser',
            title,
            {
                preserveFocus: true,
                viewColumn: ViewColumn[String(viewer) as keyof typeof ViewColumn],
            },
            {
                enableFindWidget: true,
                enableScripts: true,
                retainContextWhenHidden: true,
            });
        if (isHost()) {
            await shareBrowser(url, title);
        }
        panel.onDidChangeViewState((e: WebviewPanelOnDidChangeViewStateEvent) => {
            if (e.webviewPanel.active) {
                activeBrowserPanel = panel;
                activeBrowserUri = uri;
                activeBrowserExternalUri = externalUri;
            } else {
                activeBrowserPanel = undefined;
                activeBrowserUri = undefined;
                activeBrowserExternalUri = undefined;
            }
            void commands.executeCommand('setContext', 'r.browser.active', e.webviewPanel.active);
        });
        panel.onDidDispose(() => {
            activeBrowserPanel = undefined;
            activeBrowserUri = undefined;
            activeBrowserExternalUri = undefined;
            if (isHost()) {
                closeBrowser(url);
            }
            void commands.executeCommand('setContext', 'r.browser.active', false);
        });
        panel.iconPath = new UriIcon('globe');
        panel.webview.html = getBrowserHtml(externalUri);
    }
    console.info('[showBrowser] Done');
}

function getBrowserHtml(uri: Uri): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
    html, body {
        height: 100%;
        padding: 0;
        overflow: hidden;
    }
    </style>
</head>
<body>
    <iframe src="${uri.toString(true)}" width="100%" height="100%" frameborder="0" />
</body>
</html>
`;
}

export function refreshBrowser(): void {
    console.log('[refreshBrowser]');
    if (activeBrowserPanel) {
        activeBrowserPanel.webview.html = '';
        if (activeBrowserExternalUri) {
            activeBrowserPanel.webview.html = getBrowserHtml(activeBrowserExternalUri);
        }
    }
}

export function openExternalBrowser(): void {
    console.log('[openExternalBrowser]');
    if (activeBrowserUri) {
        void env.openExternal(activeBrowserUri);
    }
}
export async function refreshDataViewPanel(): Promise<void> {
    const panel = activeDataViewPanel;
    if (!panel) {
        void window.showWarningMessage('No active data viewer to refresh.');
        return;
    }
    const info = dataviewPanelInfo.get(panel);
    if (!info || info.source !== 'table') {
        void window.showWarningMessage('Active data viewer cannot be refreshed.');
        return;
    }
    const panelServer = info.server ?? server;
    if (!panelServer && !isGuestSession) {
        void window.showWarningMessage('R server not available.');
        return;
    }
    try {
        const response: unknown = await sessionRequest(panelServer, {
            type: 'dataview_refresh',
            varname: info.title,
            view_id: info.viewId
        });
        if (typeof response !== 'object' || response === null || !('file' in response)) {
            throw new Error('Invalid response from R server');
        }
        const file: unknown = (response as { file: string }).file;
        if (typeof file !== 'string' || !file) {
            throw new Error('Invalid file path from R server');
        }
        const content = await getTableHtml(panel.webview, file);
        const generation: unknown = (response as { generation?: number }).generation;
        if (typeof generation === 'number') {
            info.generation = generation;
        }
        panel.webview.html = '';
        panel.webview.html = content;
    } catch (error) {
        console.error('[refreshDataViewPanel] Error:', error);
        void window.showErrorMessage('Failed to refresh data viewer.');
    }
}

export async function showWebView(file: string, title: string, viewer: string | boolean): Promise<void> {
    console.info(`[showWebView] file: ${file}, viewer: ${viewer.toString()}`);
    if (viewer === false) {
        void env.openExternal(Uri.file(file));
    } else {
        const dir = path.dirname(file);
        const webviewDir = extensionContext.asAbsolutePath('html/session/webview/');
        const panel = window.createWebviewPanel('webview', title,
            {
                preserveFocus: true,
                viewColumn: ViewColumn[String(viewer) as keyof typeof ViewColumn],
            },
            {
                enableScripts: true,
                enableFindWidget: true,
                retainContextWhenHidden: true,
                localResourceRoots: [Uri.file(dir), Uri.file(webviewDir)],
            });
        panel.iconPath = new UriIcon('globe');
        panel.webview.html = await getWebviewHtml(panel.webview, file, title, dir, webviewDir);
    }
    console.info('[showWebView] Done');
}

export async function showDataView(source: string, type: string, title: string, file: string, viewer: string,
    dataview_uuid?: string, dataview_generation?: number, pidArg?: string,
    dataviewServer?: SessionServer): Promise<void> {
    const displayTitle = pidArg ? `${title} (${pidArg})` : title;
    const viewId = dataview_uuid ?? title;
    console.info(`[showDataView] source: ${source}, type: ${type}, title: ${title}, file: ${file}, 
                 viewer: ${viewer}, dataview_uuid: ${String(dataview_uuid)}, pid: ${String(pidArg)}`);

    if (isGuestSession) {
        resDir = guestResDir;
    }

    // Check if we have an existing panel with this UUID
    let panel: WebviewPanel | undefined;
    if (dataview_uuid && dataviewPanels.has(dataview_uuid)) {
        panel = dataviewPanels.get(dataview_uuid);
        // Panel might have been closed, check if it's still valid
        if (panel) {
            try {
                dataviewPanelInfo.set(panel, {
                    title, source, viewId, generation: dataview_generation,
                    pid: pidArg, server: dataviewServer
                });
                panel.title = displayTitle;
                panel.reveal(ViewColumn[viewer as keyof typeof ViewColumn]);
                
                await panel?.webview.postMessage({ command: 'refreshDataview' });
                
            } catch (e) {
                console.log(`Panel was disposed, creating new one: ${String(e)}`);
                dataviewPanels.delete(dataview_uuid);
                panel = undefined;
            }
        }
    }

    if (!panel) {
        if (source === 'table' || source === 'list') {
            panel = window.createWebviewPanel('dataview', displayTitle,
                {
                    preserveFocus: true,
                    viewColumn: ViewColumn[viewer as keyof typeof ViewColumn],
                },
                {
                    enableScripts: true,
                    enableFindWidget: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [Uri.file(resDir)],
                });

            panel.iconPath = new UriIcon('open-preview');

            if (dataview_uuid) {
                dataviewPanels.set(dataview_uuid, panel);
                panel.onDidDispose(() => {
                    dataviewPanels.delete(dataview_uuid);
                });
            }
        } else {
            if (isGuestSession) {
                const fileContent = await rGuestService?.requestFileContent(file, 'utf8');
                if (fileContent) {
                    await openVirtualDoc(file, fileContent, true, true, ViewColumn[viewer as keyof typeof ViewColumn]);
                }
            } else {
                await commands.executeCommand('vscode.open', Uri.file(file), {
                    preserveFocus: true,
                    preview: true,
                    viewColumn: ViewColumn[viewer as keyof typeof ViewColumn],
                });
            }
        }
    }

    if (panel) {
        const panelRef = panel;
        dataviewPanelInfo.set(panelRef, {
            title, source, viewId, generation: dataview_generation,
            pid: pidArg, server: dataviewServer
        });
        const panelState = panelRef as PanelWithFetchFlag;
        if (!panelState._hasViewStateHandler) {
            panelRef.onDidChangeViewState((event: WebviewPanelOnDidChangeViewStateEvent) => {
                if (event.webviewPanel.active) {
                    activeDataViewPanel = event.webviewPanel;
                    void setContext('r.dataview.active', true);
                } else if (activeDataViewPanel === event.webviewPanel) {
                    activeDataViewPanel = undefined;
                    void setContext('r.dataview.active', false);
                }
            });
            panelRef.onDidDispose(() => {
                const disposedInfo = dataviewPanelInfo.get(panelRef);
                if (disposedInfo?.source === 'table' && disposedInfo.server && !isGuestSession && !isLiveShare()) {
                    void sessionRequest(disposedInfo.server, {
                        type: 'dataview_dispose',
                        view_id: disposedInfo.viewId,
                        generation: disposedInfo.generation
                    });
                }
                dataviewPanelInfo.delete(panelRef);
                if (activeDataViewPanel === panelRef) {
                    activeDataViewPanel = undefined;
                    void setContext('r.dataview.active', false);
                }
            });
            panelState._hasViewStateHandler = true;
        }
        if (panelRef.active) {
            activeDataViewPanel = panelRef;
            void setContext('r.dataview.active', true);
        }
    }

    // Register the message handler after panel is created or retrieved, but only once per panel
    const p = panel as PanelWithFetchFlag;
    if (panel && !p._hasFetchHandler) {
        const panelRef = panel;
        panelRef.webview.onDidReceiveMessage(async (message: WebviewMessage & {
          requestId?: string;
          generation?: number;
          sortModel?: Array<{ colId: string; sort: 'asc' | 'desc' }>;
          filterModel?: {[colId: string]: unknown};
        }) => {
            if (message.command === 'fetchRows') {
                try {
                    const { start, end, generation, sortModel, filterModel, requestId } = message;
                    const info = dataviewPanelInfo.get(panelRef);
                    const requestServer = info?.server ?? server;
                    const request = {
                        type: 'dataview_fetch_rows',
                        varname: info?.title ?? title,
                        view_id: info?.viewId ?? viewId,
                        start,
                        end,
                        generation,
                        sortModel,
                        filterModel
                    };

                    console.log('[fetchRows] Sending to R:', request);

                    if (!requestServer && !isGuestSession) {
                        throw new Error('R server not available');
                    }

                    const response: unknown = await sessionRequest(requestServer, request);
                    
                    if (typeof response !== 'object' || 
                        response === null || 
                        !('rows' in response) || 
                        !('totalRows' in response) ||
                        !('totalUnfiltered' in response) ||
                        !('generation' in response)) {
                        throw new Error('Invalid response from R server');
                    }
                    
                    const rows: unknown = (response as {rows: object[]}).rows;
                    const totalRows: unknown = (response as {totalRows: number}).totalRows;
                    const totalUnfiltered: unknown = (response as {totalUnfiltered: number}).totalUnfiltered;
                    const responseGeneration: unknown = (response as {generation: number}).generation;
                    
                    if (!Array.isArray(rows) || typeof totalRows !== 'number' ||
                        typeof totalUnfiltered !== 'number' || typeof responseGeneration !== 'number') {
                        throw new Error('Fetched rows or totalRows invalid');
                    }
                    
                    await panelRef.webview.postMessage({
                        command: 'fetchedRows',
                        rows: rows as object[],
                        totalRows,
                        totalUnfiltered,
                        generation: responseGeneration,
                        requestId
                    });
                } catch (error) {
                    console.error('[fetchRows] Error:', error);
                    await panelRef.webview.postMessage({
                        command: 'fetchError',
                        requestId: message.requestId
                    });
                }
            }
        });
        p._hasFetchHandler = true;
    }

    if (panel) {
        if (source === 'table') {
            const content = await getTableHtml(panel.webview, file);
            panel.webview.html = content;
        } else if (source === 'list') {
            const content = await getListHtml(panel.webview, file);
            panel.webview.html = content;
        }
    }

    console.info('[showDataView] Done');
}

export async function getTableHtml(webview: Webview, file: string): Promise<string> {
    try {
        resDir = isGuestSession ? guestResDir : resDir;
        const content = await readContent(file, 'utf8');
        if (!content) {
            console.error('[getTableHtml] Empty content');
            throw new Error('Empty content in getTableHtml');
        }

        try {
            JSON.parse(content);
        } catch (e) {
            throw new Error('Failed to parse JSON from R dataview');
        }

        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style media="only screen">
    html, body {
        height: 100%;
        width: 100%;
        margin: 0;
        box-sizing: border-box;
        -webkit-overflow-scrolling: touch;
        position: relative;
    }

    [class*="vscode"] div.ag-root-wrapper {
        background-color: var(--vscode-editor-background);
    }
    [class*="vscode"] div.ag-header {
        background-color: var(--vscode-sideBar-background);
    }
    [class*="vscode"] div.ag-header-cell[aria-sort="ascending"], 
    [class*="vscode"] div.ag-header-cell[aria-sort="descending"] {
        color: var(--vscode-textLink-activeForeground);
    }
    [class*="vscode"] div.ag-header-cell.ag-header-cell-filtered {
      color: var(--vscode-textLink-activeForeground);
    }
    [class*="vscode"] div.ag-row {
        color: var(--vscode-editor-foreground);
    }
    [class*="vscode"] .ag-row-hover {
        background-color: var(--vscode-list-hoverBackground) !important;
        color: var(--vscode-list-hoverForeground);
    }
    [class*="vscode"] .ag-row-selected {
        background-color: var(--vscode-editor-selectionBackground) !important;
        color: var(--vscode-editor-selectionForeground) !important;
    }
    [class*="vscode"] div.ag-row-even {
        border: 0px;
        background-color: var(--vscode-editor-background);
    }
    [class*="vscode"] div.ag-row-odd {
        border: 0px;
        background-color: var(--vscode-sideBar-background);
    }
    [class*="vscode"] div.ag-ltr div.ag-has-focus div.ag-cell-focus:not(div.ag-cell-range-selected) {
        border-color: var(--vscode-editorCursor-foreground);
    }
    [class*="vscode"] div.ag-menu {
        background-color: var(--vscode-notifications-background);
        color: var(--vscode-notifications-foreground);
        border-color: var(--vscode-notifications-border);
    }
    [class*="vscode"] div.ag-filter-apply-panel-button {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: 0;
        padding: 5px 10px;
        font-size: 12px;
    }
    [class*="vscode"] div.ag-picker-field-wrapper {
        background-color: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
        border-color: var(--vscode-notificationCenter-border);
    }
    [class*="vscode"] input[class^=ag-] {
        border-color: var(--vscode-notificationCenter-border) !important;
    }

    #gridContainer {
        position: relative;
        height: 100%;
    }

    #fetchStatus {
        position: absolute;
        top: var(--fetch-status-top, 52px);
        right: 8px;
        z-index: 20;
        display: none;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
        background-color: var(--vscode-editorWidget-background);
        color: var(--vscode-editorWidget-foreground);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
        font-size: 12px;
        max-width: min(68vw, 560px);
    }

    #fetchStatus.visible {
        display: flex;
    }

    #fetchStatus[data-state="warning"] {
        border-color: var(--vscode-inputValidation-warningBorder);
    }

    #fetchStatus[data-state="error"] {
        border-color: var(--vscode-inputValidation-errorBorder);
    }

    #fetchStatusText {
        word-break: break-word;
    }

    #fetchRetryBtn {
        display: none;
        border: 0;
        padding: 3px 8px;
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        cursor: pointer;
        white-space: nowrap;
    }

    #fetchStatus.show-retry #fetchRetryBtn {
        display: inline-block;
    }

    #scrollPosition {
        position: absolute;
        top: 52px;
        right: 24px;
        z-index: 21;
        display: none;
        padding: 4px 8px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
        background-color: var(--vscode-editorWidget-background);
        color: var(--vscode-editorWidget-foreground);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
        font-size: 12px;
        pointer-events: none;
        white-space: nowrap;
    }

    #scrollPosition.visible {
        display: block;
    }

    .dataview-na {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
        opacity: 0.75;
    }
    </style>
    <script src="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'ag-grid-community.min.noStyle.js'))))}"></script>
    <script>

    const vscode = acquireVsCodeApi();
    let gridApi;
    let filteredRows = 0;
    let totalRows = 0;
    let isFiltered = false;
    const bigintFields = [];
    let activeFetches = 0;
    let longFetchTimer;
    let verticalScrollbar;
    let scrollbarPositionAttached = false;
    let scrollbarPressed = false;
    const LONG_FETCH_DELAY_MS = 2000;
    const rowNumberFormatter = new Intl.NumberFormat();

    const dateFilterParams = {
        browserDatePicker: true
    };

    function getAgTheme() {
        if (document.body.classList.contains('vscode-light')) {
            return window.agGrid.themeBalham.withPart(window.agGrid.colorSchemeLight);
        }
        return window.agGrid.themeBalham.withPart(window.agGrid.colorSchemeDark);
    }

    // Inject raw JSON data from R
    const data = ${content};
    const emptyCellRenderer = () => '';
    const naCellRenderer = () => {
        const element = document.createElement('span');
        element.className = 'dataview-na';
        element.textContent = 'NA';
        return element;
    };

    function clearLongFetchTimer() {
        if (longFetchTimer) {
            clearTimeout(longFetchTimer);
            longFetchTimer = undefined;
        }
    }

    function setFetchStatus(state, message, showRetry) {
        const statusElement = document.querySelector('#fetchStatus');
        const textElement = document.querySelector('#fetchStatusText');
        if (!statusElement || !textElement) {
            return;
        }
        if (state === 'hidden') {
            statusElement.classList.remove('visible', 'show-retry');
            statusElement.dataset.state = '';
            textElement.textContent = '';
            return;
        }
        statusElement.dataset.state = state;
        textElement.textContent = message;
        statusElement.classList.add('visible');
        statusElement.classList.toggle('show-retry', Boolean(showRetry));
    }

    function updateFetchStatusPosition() {
        const containerElement = document.querySelector('#gridContainer');
        if (!containerElement) {
            return;
        }
        let headerHeight = 0;
        if (gridApi && typeof gridApi.getSizesForCurrentTheme === 'function') {
            const sizes = gridApi.getSizesForCurrentTheme();
            if (sizes && Number.isFinite(sizes.headerHeight)) {
                headerHeight = Number(sizes.headerHeight);
            }
        }
        if (!headerHeight) {
            const headerElement = document.querySelector('#myGrid .ag-header');
            if (headerElement) {
                headerHeight = headerElement.getBoundingClientRect().height;
            }
        }
        const topOffset = Math.max(8, Math.round(headerHeight) + 8);
        containerElement.style.setProperty('--fetch-status-top', String(topOffset) + 'px');
    }

    function beginFetch(message) {
        activeFetches += 1;
        if (activeFetches !== 1) {
            return;
        }
        setFetchStatus('loading', message || 'Fetching data...', false);
        clearLongFetchTimer();
        longFetchTimer = setTimeout(() => {
            if (activeFetches > 0) {
                setFetchStatus(
                    'warning',
                    'Still waiting for R session response. It may be busy running code.',
                    false
                );
            }
        }, LONG_FETCH_DELAY_MS);
    }

    function finishFetch(ok, errorMessage) {
        activeFetches = Math.max(0, activeFetches - 1);
        if (activeFetches !== 0) {
            return;
        }
        clearLongFetchTimer();
        if (ok) {
            setFetchStatus('hidden', '', false);
        } else {
            setFetchStatus(
                'error',
                errorMessage || 'Failed to fetch data from R session.',
                true
            );
        }
    }

    function retryCurrentPage() {
        if (!gridApi) {
            return;
        }
        setFetchStatus('loading', 'Retrying data fetch...', false);
        if (typeof gridApi.refreshInfiniteCache === 'function') {
            gridApi.refreshInfiniteCache();
        } else {
            gridApi.purgeInfiniteCache();
        }
    }

    function updateScrollPosition() {
        if (!scrollbarPressed || !verticalScrollbar) {
            return;
        }
        const positionElement = document.querySelector('#scrollPosition');
        const containerElement = document.querySelector('#gridContainer');
        if (!positionElement || !containerElement || filteredRows < 1) {
            return;
        }

        const trackHeight = verticalScrollbar.clientHeight;
        const maximumScroll = verticalScrollbar.scrollHeight - trackHeight;
        const scrollRatio = maximumScroll > 0
            ? Math.max(0, Math.min(1, verticalScrollbar.scrollTop / maximumScroll))
            : 0;
        const currentRow = Math.round(scrollRatio * (filteredRows - 1)) + 1;
        positionElement.textContent =
            rowNumberFormatter.format(currentRow) +
            ' of ' + rowNumberFormatter.format(filteredRows);

        const scrollbarRect = verticalScrollbar.getBoundingClientRect();
        const containerRect = containerElement.getBoundingClientRect();
        const labelHeight = positionElement.offsetHeight;
        const desiredTop = scrollbarRect.top - containerRect.top +
            scrollRatio * Math.max(0, scrollbarRect.height - labelHeight);
        const maximumTop = containerRect.height - labelHeight - 8;
        positionElement.style.top =
            String(Math.max(8, Math.min(desiredTop, maximumTop))) + 'px';
    }

    function attachScrollbarPositionIndicator() {
        if (scrollbarPositionAttached) {
            return;
        }
        verticalScrollbar = document.querySelector(
            '#myGrid .ag-body-vertical-scroll-viewport'
        );
        if (!verticalScrollbar) {
            return;
        }
        scrollbarPositionAttached = true;
        verticalScrollbar.addEventListener('pointerdown', () => {
            scrollbarPressed = true;
            const positionElement = document.querySelector('#scrollPosition');
            positionElement?.classList.add('visible');
            updateScrollPosition();
        });
        verticalScrollbar.addEventListener('scroll', updateScrollPosition, {
            passive: true
        });
        const hidePosition = () => {
            scrollbarPressed = false;
            document.querySelector('#scrollPosition')?.classList.remove('visible');
        };
        window.addEventListener('pointerup', hidePosition);
        window.addEventListener('pointercancel', hidePosition);
    }

    const displayDataSource = {
        getRows(params) {
            beginFetch('Fetching rows from R session...');
            const msg = {
                command: 'fetchRows',
                start: params.startRow,
                end: params.endRow,
                generation: data.generation,
                sortModel: params.sortModel,
                filterModel: params.filterModel,
                requestId: Math.random().toString(36).substr(2, 9)
            };

            const handler = event => {
                const m = event.data;
                if (m.requestId !== msg.requestId) {
                    return;
                }

                if (m.command === 'fetchedRows') {
                    if (m.generation !== msg.generation) {
                        params.failCallback();
                        finishFetch(true);
                        window.removeEventListener('message', handler);
                        return;
                    }

                    filteredRows = m.totalRows;
                    totalRows = m.totalUnfiltered;
                    isFiltered = Object.keys(params.filterModel || {}).length > 0;
                    gridApi?.refreshHeader();
                    updateScrollPosition();

                    m.rows.forEach(row => {
                        bigintFields.forEach(field => {
                            if (row[field] != null) {
                                row[field] = BigInt(row[field]);
                            }
                        });
                    });
                    params.successCallback(m.rows, m.totalRows);
                    finishFetch(true);
                    window.removeEventListener('message', handler);
                } else if (m.command === 'fetchError') {
                    params.failCallback();
                    finishFetch(false, 'Failed to fetch rows from R session.');
                    window.removeEventListener('message', handler);
                }
            };
            window.addEventListener('message', handler);
            vscode.postMessage(msg);
        }
    };

    const columnDefs = data.columns.map(sourceColumn => {
        const column = { ...sourceColumn };
        column.cellRendererSelector = params => {
            if (params.data == null) {
                return { component: emptyCellRenderer };
            }
            return params.value == null
                ? { component: naCellRenderer }
                : undefined;
        };
        if (column.field === 'x1') {
            column.lockPosition = 'left';
            column.width = 150;
            column.headerValueGetter = () =>
                isFiltered
                    ? '(' + rowNumberFormatter.format(filteredRows) + '/' +
                        rowNumberFormatter.format(totalRows) + ')'
                    : '';
        } else if (column.field === 'x2') {
            column.hide = true;
        }

        if (column.type === 'dateColumn' ||
            column.type === 'datetimeColumn') {
            column.cellDataType =
                column.type === 'dateColumn' ? 'dateString' : 'dateTimeString';
            column.filter = 'agDateColumnFilter';
            column.filterParams = dateFilterParams;
            column.width = 200;
        } else if (column.type === 'bigintColumn') {
            column.cellDataType = 'bigint';
            column.filter = 'agBigIntColumnFilter';
            bigintFields.push(column.field);
        }
        if (column.type !== 'numericColumn') {
            delete column.type;
        }
        return column;
    });

    function getGridOptions() {
        return {
            theme: getAgTheme(),
            defaultColDef: {
                sortable: true,
                resizable: true,
                filter: true,
                width: 100,
                minWidth: 50,
                filterParams: {
                    buttons: ['reset', 'apply']
                }
            },

            columnDefs: columnDefs,
            getRowId: params => params.data.x2,
            rowModelType: 'infinite',
            datasource: displayDataSource,
            cacheBlockSize: 500,
            enableCellTextSelection: true,
            ensureDomOrder: true,
            tooltipShowDelay: 100,
            onBodyScroll: updateScrollPosition,
            onFirstDataRendered: params => {
                params.api.autoSizeAllColumns(false);
                updateFetchStatusPosition();
                attachScrollbarPositionIndicator();
            },
        };
    }
    
    function updateTheme() {
        if (gridApi) {
            gridApi.setGridOption('theme', getAgTheme());
        }
        updateFetchStatusPosition();
    }
    
    document.addEventListener('DOMContentLoaded', () => {
        const retryButton = document.querySelector('#fetchRetryBtn');
        if (retryButton) {
            retryButton.addEventListener('click', retryCurrentPage);
        }
        const gridDiv = document.querySelector('#myGrid');
        gridApi = window.agGrid.createGrid(gridDiv, getGridOptions());

        updateTheme();
        requestAnimationFrame(attachScrollbarPositionIndicator);

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.command === 'refreshDataview') {
              gridApi.setFilterModel(null);
              gridApi.onFilterChanged();            
              gridApi.purgeInfiniteCache();           
              gridApi.ensureIndexVisible(0, 'top');   
            }
        });
    });
    
    function onload() {
        updateTheme();
        const observer = new MutationObserver(updateTheme);
        observer.observe(document.body, {
            attributes: true,
            attributeFilter: ['class']
        });
    }
    </script>
</head>
<body onload='onload()'>
    <div id="gridContainer">
        <div id="fetchStatus" role="status" aria-live="polite">
            <span id="fetchStatusText"></span>
            <button id="fetchRetryBtn" type="button">Retry</button>
        </div>
        <div id="scrollPosition" role="status" aria-live="polite"></div>
        <div id="myGrid" style="height: 100%;"></div>
    </div>
</body>
</html>
`;
    } catch (error) {
        console.error('[getTableHtml] Error:', error);
        throw error;
    }
}

export async function getListHtml(webview: Webview, file: string): Promise<string> {
    resDir = isGuestSession ? guestResDir : resDir;
    const content = await readContent(file, 'utf8');

    return `
<!doctype HTML>
<html>
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <script src="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'jquery.min.js'))))}"></script>
    <script src="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'jquery.json-viewer.js'))))}"></script>
    <link href="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'jquery.json-viewer.css'))))}" rel="stylesheet">
    <style type="text/css">
    body {
        color: var(--vscode-editor-foreground);
        background-color: var(--vscode-editor-background);
    }

    .json-document {
        padding: 0 0;
    }

    pre#json-renderer {
        font-family: var(--vscode-editor-font-family);
        border: 0;
    }

    ul.json-dict, ol.json-array {
        color: var(--vscode-symbolIcon-fieldForeground);
        border-left: 1px dotted var(--vscode-editorLineNumber-foreground);
    }

    .json-literal {
        color: var(--vscode-symbolIcon-variableForeground);
    }

    .json-string {
        color: var(--vscode-symbolIcon-stringForeground);
    }

    a.json-toggle:before {
        color: var(--vscode-button-secondaryBackground);
    }

    a.json-toggle:hover:before {
        color: var(--vscode-button-secondaryHoverBackground);
    }

    a.json-placeholder {
        color: var(--vscode-input-placeholderForeground);
    }
    </style>
    <script>
    var data = ${String(content)};
    $(document).ready(function() {
      var options = {
        collapsed: false,
        rootCollapsable: false,
        withQuotes: false,
        withLinks: true
      };
      $("#json-renderer").jsonViewer(data, options);
    });
    </script>
</head>
<body>
    <pre id="json-renderer"></pre>
</body>
</html>
`;
}

export async function getWebviewHtml(webview: Webview, file: string, title: string, dir: string, webviewDir: string): Promise<string> {
    const observerPath = Uri.file(path.join(webviewDir, 'observer.js'));
    const body = (await readContent(file, 'utf8') || '').toString()
        .replace(/<(\w+)(.*)\s+(href|src)="(?!\w+:)/g,
            `<$1 $2 $3="${String(webview.asWebviewUri(Uri.file(dir)))}/`);

    // define the content security policy for the webview
    // * whilst it is recommended to be strict as possible,
    // * there are several packages that require unsafe requests
    const CSP = `
        upgrade-insecure-requests;
        default-src https: data: filesystem:;
        style-src https: data: filesystem: 'unsafe-inline';
        script-src https: data: filesystem: 'unsafe-inline' 'unsafe-eval';
        worker-src https: data: filesystem: blob:;
    `;

    return `
    <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="${CSP}">
                <title>${title}</title>
                <style>
                    body {
                        color: black;
                    }
                </style>
            </head>
            <body>
                <span id="webview-content">
                    ${body}
                </span>
            </body>
            <script src="${String(webview.asWebviewUri(observerPath))}"></script>
        </html>`;
}

function isFromWorkspace(dir: string) {
    if (workspace.workspaceFolders === undefined) {
        let rel = path.relative(os.homedir(), dir);
        if (rel === '') {
            return true;
        }
        rel = path.relative(fs.realpathSync(os.homedir()), dir);
        if (rel === '') {
            return true;
        }
    } else {
        for (const folder of workspace.workspaceFolders) {
            let rel = path.relative(folder.uri.fsPath, dir);
            if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
                return true;
            }
            rel = path.relative(fs.realpathSync(folder.uri.fsPath), dir);
            if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
                return true;
            }
        }
    }

    return false;
}

export async function writeResponse(responseData: Record<string, unknown>, responseSessionDir: string): Promise<void> {

    const responseFile = path.join(responseSessionDir, 'response.log');
    const responseLockFile = path.join(responseSessionDir, 'response.lock');
    if (!fs.existsSync(responseFile) || !fs.existsSync(responseLockFile)) {
        throw ('Received a request from R for response' +
            'to a session directiory that does not contain response.log or response.lock: ' +
            responseSessionDir);
    }
    const responseString = JSON.stringify(responseData);
    console.info('[writeResponse] Started');
    console.info(`[writeResponse] responseData ${responseString}`);
    console.info(`[writeRespnse] responseFile: ${responseFile}`);
    await fs.writeFile(responseFile, responseString);
    responseTimeStamp = Date.now();
    await fs.writeFile(responseLockFile, `${responseTimeStamp}\n`);
}

export async function writeSuccessResponse(responseSessionDir: string): Promise<void> {
    await writeResponse({ result: true }, responseSessionDir);
}

async function updateRequest(sessionStatusBarItem: StatusBarItem) {
    console.info('[updateRequest] Started');
    console.info(`[updateRequest] requestFile: ${requestFile}`);

    const lockContent = await fs.readFile(requestLockFile, 'utf8');
    const newTimeStamp = Number.parseFloat(lockContent);
    if (newTimeStamp !== requestTimeStamp) {
        requestTimeStamp = newTimeStamp;
        const requestContent = await fs.readFile(requestFile, 'utf8');
        console.info(`[updateRequest] request: ${requestContent}`);
        const request = JSON.parse(requestContent) as IRequest;
        if (request.wd && isFromWorkspace(request.wd)) {
            if (request.uuid === null || request.uuid === undefined || String(request.uuid) === String(UUID)) {
                switch (request.command) {
                    case 'help': {
                        if (globalRHelp && request.requestPath) {
                            console.log(request.requestPath);
                            await globalRHelp.showHelpForPath(request.requestPath, request.viewer);
                        }
                        break;
                    }
                    case 'httpgd': {
                        pid = String(request.pid);
                        if (request.url) {
                            await globalHttpgdManager?.showViewer(request.url, pid);
                        }
                        break;
                    }
                    case 'attach': {
                        if (!request.tempdir || !request.wd) {
                            break;
                        }
                        rVer = String(request.version);
                        pid = String(request.pid);
                        info = request.info;
                        sessionDir = path.join(request.tempdir, 'vscode-R');
                        workingDir = request.wd;
                        console.info(`[updateRequest] attach PID: ${pid}`);
                        sessionStatusBarItem?.show();
                        sessionStatusBarItem.text = `R ${rVer}: ${pid}`;
                        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-unsafe-member-access
                        sessionStatusBarItem.tooltip = `${info?.version}\nProcess ID: ${pid}\nCommand: ${info?.command}\nStart time: ${info?.start_time}\nClick to attach to active terminal.`;
                        //sessionStatusBarItem.show();  

                        if (request.server) {
                            server = request.server;
                            sessionServers.set(pid, request.server);
                        }
                        updateSessionWatcher();

                        purgeAddinPickerItems();
                        await setContext('rSessionActive', true);
                        await globalHttpgdManager?.handleAttachedPlot(request.plot_url, pid);
                        void watchProcess(pid).then((v: string) => {
                            globalHttpgdManager?.dropPid(v);
                            void cleanupSession(v);
                        });
                        break;
                    }
                    case 'detach': {
                        if (request.pid) {
                            await cleanupSession(request.pid);
                        }
                        await setContext('rSessionActive', false);
                        break;
                    }
                    case 'browser': {
                        if (request.url && request.title && request.viewer !== undefined) {
                            await showBrowser(request.url, request.title, request.viewer);
                        }
                        break;
                    }
                    case 'webview': {
                        if (request.file && request.title && request.viewer !== undefined) {
                            await showWebView(request.file, request.title, request.viewer);
                        }
                        break;
                    }
                    case 'dataview': {
                        if (request.source && request.type && request.file && request.title && request.viewer !== undefined) {
                            // Use dataview_uuid for panel tracking, preserve uuid for LiveShare
                            const requestPid = request.pid ? String(request.pid) : pid;
                            const requestServer = sessionServers.get(requestPid) ??
                                (requestPid === pid ? server : undefined);
                            await showDataView(request.source, request.type, request.title, request.file, request.viewer,
                                request.dataview_uuid, request.dataview_generation, requestPid, requestServer);
                        }
                        break;
                    }
                    case 'rstudioapi': {
                        if (request.action && request.args && request.sd) {
                            await dispatchRStudioAPICall(request.action, request.args, request.sd);
                        }
                        break;
                    }
                    default:
                        console.error(`[updateRequest] Unsupported command: ${request.command}`);
                }
            }
        } else {
            console.info(`[updateRequest] Ignored request outside workspace`);
        }
        if (isLiveShare()) {
            void rHostService?.notifyRequest(requestFile);
        }
    }
}

export async function cleanupSession(pidArg: string): Promise<void> {
    sessionServers.delete(pidArg);
    if (pid === pidArg) {
        if (workspaceRefreshTimer) {
            clearTimeout(workspaceRefreshTimer);
            workspaceRefreshTimer = undefined;
        }
        workspaceRefreshPending = false;
        if (sessionStatusBarItem) {
            sessionStatusBarItem.text = 'R: (not attached)';
            sessionStatusBarItem.tooltip = 'Click to attach active terminal.';
        }
        server = undefined;
        if (isLiveShare()) {
            rHostService?.orderGuestDetach();
        }
        globalHttpgdManager?.dropPid(pid);
        globalHttpgdManager?.clearLastPlot(pid);
        disposeDataViewPanels();
        if (!isLiveShare()) {
            await closeSessionViewers();
        }
        globalHttpgdManager?.disposeSharedServers();
        if (isLiveShare()) {
            while (browserDisposables.length > 0) {
                closeBrowser(browserDisposables[0].url);
            }
        }
        workspaceData.globalenv = {};
        workspaceData.loaded_namespaces = [];
        workspaceData.search = [];
        rWorkspace?.refresh();
        removeSessionFiles();
        await setContext('rSessionActive', false);
    }
}

async function watchProcess(pid: string): Promise<string> {
    function pidIsRunning(pid: number) {
        try {
            process.kill(pid, 0);
            return true;
        } catch (e) {
            return false;
        }
    }

    const pidArg = Number(pid);

    let res = true;
    do {
        res = pidIsRunning(pidArg);
        await new Promise(resolve => {
            setTimeout(resolve, 1000);
        });

    } while (res);
    return pid;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function sessionRequest(server: SessionServer | undefined, data: any): Promise<any> {
    if (isGuestSession) {
        if (!rGuestService) {
            throw new Error('R server not available');
        }
        return rGuestService.requestDataViewRows(data);
    }
    if (!server) {
        throw new Error('R server not available');
    }
    try {
        const response = await fetch(`http://${server.host}:${server.port}`, {
            agent: httpAgent,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: server.token
            },
            body: JSON.stringify(data),
            follow: 0,
            timeout: 120000,
        });

        if (!response.ok) {
            throw new Error(`Error! status: ${response.status}`);
        }

        return response.json();
    } catch (error) {
        if (error instanceof Error) {
            console.log('error message: ', error.message);
        } else {
            console.log('unexpected error: ', error);
        }

        return undefined;
    }
}
