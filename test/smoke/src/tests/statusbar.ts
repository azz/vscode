/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';

import {
	SpectronApplication,
	LATEST_PATH,
	WORKSPACE_PATH
} from '../spectron/application';
import { CommonActions } from '../areas/common';
import { StatusBarElement, StatusBar } from '../areas/statusbar';

let app: SpectronApplication;
let common: CommonActions;

export function testStatusbar() {
	context('Status Bar', () => {
		let statusBar: StatusBar;

		beforeEach(async function() {
			app = new SpectronApplication(
				LATEST_PATH,
				this.currentTest.fullTitle(),
				(this.currentTest as any).currentRetry(),
				[WORKSPACE_PATH]
			);
			common = new CommonActions(app);
			statusBar = new StatusBar(app);

			return await app.start();
		});
		afterEach(async function() {
			return await app.stop();
		});

		it('verifies presence of all default status bar elements', async function() {
			await app.wait();
			assert.ok(await statusBar.isVisible(StatusBarElement.BRANCH_STATUS));
			assert.ok(await statusBar.isVisible(StatusBarElement.FEEDBACK_ICON));
			assert.ok(await statusBar.isVisible(StatusBarElement.SYNC_STATUS));
			assert.ok(await statusBar.isVisible(StatusBarElement.PROBLEMS_STATUS));

			await common.openFirstMatchFile('app.js');
			assert.ok(await statusBar.isVisible(StatusBarElement.ENCODING_STATUS));
			assert.ok(await statusBar.isVisible(StatusBarElement.EOL_STATUS));
			assert.ok(await statusBar.isVisible(StatusBarElement.INDENTATION_STATUS));
			assert.ok(await statusBar.isVisible(StatusBarElement.LANGUAGE_STATUS));
			assert.ok(await statusBar.isVisible(StatusBarElement.SELECTION_STATUS));
		});

		it(`verifies that 'quick open' opens when clicking on 'Branch', 'Indentation Status, 'Encoding', 'EOL' and 'Language' status elements`, async function() {
			await app.wait();
			await statusBar.clickOn(StatusBarElement.BRANCH_STATUS);
			assert.ok(await statusBar.isQuickOpenWidgetVisible());
			await common.closeQuickOpen();

			await common.openFirstMatchFile('app.js');
			await statusBar.clickOn(StatusBarElement.INDENTATION_STATUS);
			assert.ok(await statusBar.isQuickOpenWidgetVisible());
			await common.closeQuickOpen();
			await statusBar.clickOn(StatusBarElement.ENCODING_STATUS);
			assert.ok(await statusBar.isQuickOpenWidgetVisible());
			await common.closeQuickOpen();
			await statusBar.clickOn(StatusBarElement.EOL_STATUS);
			assert.ok(await statusBar.isQuickOpenWidgetVisible());
			await common.closeQuickOpen();
			await statusBar.clickOn(StatusBarElement.LANGUAGE_STATUS);
			assert.ok(await statusBar.isQuickOpenWidgetVisible());
			await common.closeQuickOpen();
		});

		it(`verifies that 'Problems View' appears when clicking on 'Problems' status element`, async function() {
			await statusBar.clickOn(StatusBarElement.PROBLEMS_STATUS);
			assert.ok(await statusBar.getProblemsView());
		});

		it(`verifies that 'Tweet us feedback' pop-up appears when clicking on 'Feedback' icon`, async function() {
			await statusBar.clickOn(StatusBarElement.FEEDBACK_ICON);
			assert.ok(await statusBar.getFeedbackView());
		});

		it(`checks if 'Go to Line' works if called from the status bar`, async function() {
			await common.openFirstMatchFile('app.js');
			await statusBar.clickOn(StatusBarElement.SELECTION_STATUS);
			const lineNumber = 15;
			await common.type(lineNumber.toString());
			await common.enter();
			assert.ok(await statusBar.getEditorHighlightedLine(lineNumber));
		});

		it(`verifies if changing EOL is reflected in the status bar`, async function() {
			await common.openFirstMatchFile('app.js');
			await statusBar.clickOn(StatusBarElement.EOL_STATUS);
			await common.selectNextQuickOpenElement();
			await common.enter();
			const currentEOL = await statusBar.getEOLMode();
			assert.equal(currentEOL, 'CRLF');
		});
	});
}
