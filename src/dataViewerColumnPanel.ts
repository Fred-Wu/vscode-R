'use strict';

export function getDataViewerColumnPanelStyle(): string {
    return `
    #columnPanelToggle {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 25;
        border: 1px solid var(--vscode-button-border, transparent);
        padding: 4px 10px;
        background-color: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        cursor: pointer;
    }

    #columnPanel {
        position: absolute;
        top: 0;
        right: 0;
        z-index: 30;
        display: none;
        width: min(320px, 42vw);
        height: 100%;
        box-sizing: border-box;
        border-left: 1px solid var(--vscode-panel-border);
        background-color: var(--vscode-sideBar-background);
        color: var(--vscode-sideBar-foreground);
        box-shadow: -4px 0 12px rgba(0, 0, 0, 0.2);
    }

    #columnPanel.visible {
        display: flex;
        flex-direction: column;
    }

    #columnPanelHeader {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        border-bottom: 1px solid var(--vscode-panel-border);
        font-weight: 600;
    }

    #columnPanelClose {
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
    }

    #columnPanelActions {
        display: flex;
        gap: 8px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--vscode-panel-border);
    }

    #columnPanelActions button {
        border: 0;
        padding: 4px 8px;
        background-color: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        cursor: pointer;
    }

    #columnPanelList {
        flex: 1;
        overflow-y: auto;
        padding: 4px 0;
    }

    .column-panel-item {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 30px;
        padding: 0 12px;
        cursor: grab;
        user-select: none;
    }

    .column-panel-item:hover {
        background-color: var(--vscode-list-hoverBackground);
        color: var(--vscode-list-hoverForeground);
    }

    .column-panel-item.dragging {
        opacity: 0.5;
    }

    .column-panel-item.drag-over {
        border-top: 2px solid var(--vscode-focusBorder);
    }

    .column-panel-item input {
        margin: 0;
        cursor: pointer;
    }

    .column-panel-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    `;
}

export function getDataViewerColumnPanelHtml(): string {
    return `
        <button id="columnPanelToggle" type="button">Columns</button>
        <div id="columnPanel" aria-label="Columns panel">
            <div id="columnPanelHeader">
                <span>Columns</span>
                <button id="columnPanelClose" type="button" aria-label="Close columns panel">×</button>
            </div>
            <div id="columnPanelActions">
                <button id="columnSelectAll" type="button">Select all</button>
                <button id="columnDeselectAll" type="button">Deselect all</button>
            </div>
            <div id="columnPanelList"></div>
        </div>
    `;
}

export function getDataViewerColumnPanelScript(): string {
    return `
    let columnPanelColumns = [];
    let draggedColumnId;

    function getSelectableGridColumns() {
        if (!gridApi || typeof gridApi.getAllGridColumns !== 'function') {
            return [];
        }
        return gridApi.getAllGridColumns().filter(column => column.getColId() !== '0');
    }

    function getColumnDisplayName(column) {
        const colDef = column.getColDef();
        return String(colDef.headerName || column.getColId());
    }

    function renderColumnPanel() {
        const list = document.querySelector('#columnPanelList');
        if (!list || !gridApi) {
            return;
        }

        list.replaceChildren();
        columnPanelColumns = getSelectableGridColumns();

        columnPanelColumns.forEach(column => {
            const colId = column.getColId();
            const item = document.createElement('div');
            item.className = 'column-panel-item';
            item.draggable = true;
            item.dataset.colId = colId;

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = column.isVisible();
            checkbox.setAttribute('aria-label', 'Show ' + getColumnDisplayName(column));
            checkbox.addEventListener('change', () => {
                gridApi.setColumnsVisible([colId], checkbox.checked);
            });

            const label = document.createElement('span');
            label.className = 'column-panel-label';
            label.textContent = getColumnDisplayName(column);
            label.title = label.textContent;

            item.append(checkbox, label);
            list.append(item);
        });
    }

    function applyPanelOrder() {
        const list = document.querySelector('#columnPanelList');
        if (!list || !gridApi) {
            return;
        }

        const orderedIds = Array.from(list.children)
            .map(item => item.dataset.colId)
            .filter(Boolean);

        gridApi.applyColumnState({
            state: orderedIds.map(colId => ({ colId })),
            applyOrder: true
        });
    }

    function setAllColumnVisibility(visible) {
        if (!gridApi) {
            return;
        }
        const ids = getSelectableGridColumns().map(column => column.getColId());
        gridApi.setColumnsVisible(ids, visible);
        renderColumnPanel();
    }

    function initializeColumnPanel() {
        const panel = document.querySelector('#columnPanel');
        const toggle = document.querySelector('#columnPanelToggle');
        const close = document.querySelector('#columnPanelClose');
        const selectAll = document.querySelector('#columnSelectAll');
        const deselectAll = document.querySelector('#columnDeselectAll');
        const list = document.querySelector('#columnPanelList');
        if (!panel || !toggle || !close || !selectAll || !deselectAll || !list) {
            return;
        }

        renderColumnPanel();

        toggle.addEventListener('click', () => {
            renderColumnPanel();
            panel.classList.toggle('visible');
        });
        close.addEventListener('click', () => panel.classList.remove('visible'));
        selectAll.addEventListener('click', () => setAllColumnVisibility(true));
        deselectAll.addEventListener('click', () => setAllColumnVisibility(false));

        list.addEventListener('dragstart', event => {
            const item = event.target.closest('.column-panel-item');
            if (!item) {
                return;
            }
            draggedColumnId = item.dataset.colId;
            item.classList.add('dragging');
            event.dataTransfer.effectAllowed = 'move';
        });

        list.addEventListener('dragend', event => {
            const item = event.target.closest('.column-panel-item');
            item?.classList.remove('dragging');
            list.querySelectorAll('.drag-over').forEach(element => element.classList.remove('drag-over'));
            draggedColumnId = undefined;
        });

        list.addEventListener('dragover', event => {
            event.preventDefault();
            const target = event.target.closest('.column-panel-item');
            list.querySelectorAll('.drag-over').forEach(element => element.classList.remove('drag-over'));
            if (target && target.dataset.colId !== draggedColumnId) {
                target.classList.add('drag-over');
            }
        });

        list.addEventListener('drop', event => {
            event.preventDefault();
            const target = event.target.closest('.column-panel-item');
            const dragged = draggedColumnId
                ? list.querySelector('[data-col-id="' + CSS.escape(draggedColumnId) + '"]')
                : undefined;
            if (!target || !dragged || target === dragged) {
                return;
            }

            const targetRect = target.getBoundingClientRect();
            const insertAfter = event.clientY > targetRect.top + targetRect.height / 2;
            list.insertBefore(dragged, insertAfter ? target.nextSibling : target);
            applyPanelOrder();
            renderColumnPanel();
        });
    }

    function syncColumnPanelFromGrid() {
        const panel = document.querySelector('#columnPanel');
        if (panel?.classList.contains('visible')) {
            renderColumnPanel();
        }
    }
    `;
}
