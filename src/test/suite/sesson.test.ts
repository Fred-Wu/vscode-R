import vscode = require('vscode');
import sinon = require('sinon');
import path = require('path');
import * as assert from 'assert';
import * as fs from 'fs-extra';

import { mockExtensionContext } from '../common';
import * as session from '../../session';
import * as workspace from '../../workspaceViewer';

const extension_root: string = path.join(__dirname, '..', '..', '..');
const workspaceFile = path.join(extension_root, 'src', 'test', 'testdata', 'session', 'workspace.json');

function mockWorkspaceData(sandbox: sinon.SinonSandbox) {
    const content = fs.readFileSync(workspaceFile, 'utf8');
    const workspaceData = JSON.parse(content) as session.WorkspaceData;
    return sandbox.stub(session, 'workspaceData').value(workspaceData);
}

suite('Workspace Viewer', () => {
    let sandbox: sinon.SinonSandbox;
    let workspaceViewer: workspace.WorkspaceDataProvider;
    let nodes: vscode.TreeItem[];

    setup(() => {
        sandbox = sinon.createSandbox();
    });
    teardown(() => {
        sandbox.restore();
    });

    test('has 3 nodes', async () => {
        mockExtensionContext(extension_root, sandbox);
        mockWorkspaceData(sandbox);
        workspaceViewer = new workspace.WorkspaceDataProvider();
        workspaceViewer.refresh();
        nodes = await workspaceViewer.getChildren();
        assert.strictEqual(nodes.length, 3);
    });

    test('search node', async () => {
        const search = await workspaceViewer.getChildren(nodes[0]);
        assert.strictEqual(search.length, 10);
    });

    test('attached node', async () => {
        const attached = await workspaceViewer.getChildren(nodes[1]);
        assert.strictEqual(attached.length, 14);
    });

    test('env node', async () => {
        const env: workspace.GlobalEnvItem[] = await workspaceViewer.getChildren(nodes[2]) as workspace.GlobalEnvItem[];
        assert.strictEqual(env.length, 9);
    });

    test('supported workspace objects show arrows when they have children', () => {
        const types = ['list', 'environment', 'pairlist', 'S4', 'list'];
        const classes = ['list', 'environment', 'pairlist', 'PlainS4', 'data.frame'];

        for (const [index, type] of types.entries()) {
            const item = new workspace.GlobalEnvItem(
                classes[index],
                classes[index],
                `${classes[index]}, length 1`,
                type,
                0,
                0,
                undefined,
                true
            );
            assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
        }

        const emptyList = new workspace.GlobalEnvItem(
            'empty',
            'list',
            'list, length 0',
            'list',
            0,
            0,
            undefined,
            false
        );
        assert.strictEqual(emptyList.collapsibleState, vscode.TreeItemCollapsibleState.None);
    });

    test('nested list child remains expandable', () => {
        const item = new workspace.GlobalEnvItem(
            '',
            'list',
            '$ a: List of 2',
            'list',
            0,
            1,
            undefined,
            true,
            'test',
            [{ kind: 'index', value: 1 }]
        );

        assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
        assert.strictEqual(item.rootName, 'test');
        assert.deepStrictEqual(item.objectPath, [{ kind: 'index', value: 1 }]);
    });

});
