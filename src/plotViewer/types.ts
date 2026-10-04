
export interface PlotViewer {
    readonly id: string;
    show(preserveFocus?: boolean): void;
    dispose(): void;
    handleCommand(command: string, ...args: unknown[]): void | Promise<void>;
}

export interface PlotManager {
    viewers: PlotViewer[];
    activeViewer: PlotViewer | undefined;
    initialize(): void;
    setActiveSession(sessionId?: string): void;
    disposeSession(sessionId: string): void;
    showStandardPlot(sessionId?: string): Promise<void>;
    showHttpgdPlot(url: string, sessionId?: string): Promise<void>;
}
