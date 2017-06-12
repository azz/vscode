/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

('use strict');

import 'vs/css!./minimap';
import {
	ViewPart,
	PartFingerprint,
	PartFingerprints
} from 'vs/editor/browser/view/viewPart';
import { ViewContext } from 'vs/editor/common/view/viewContext';
import {
	RenderingContext,
	RestrictedRenderingContext
} from 'vs/editor/common/view/renderingContext';
import { getOrCreateMinimapCharRenderer } from 'vs/editor/common/view/runtimeMinimapCharRenderer';
import * as dom from 'vs/base/browser/dom';
import {
	MinimapCharRenderer,
	MinimapTokensColorTracker,
	Constants
} from 'vs/editor/common/view/minimapCharRenderer';
import * as editorCommon from 'vs/editor/common/editorCommon';
import { CharCode } from 'vs/base/common/charCode';
import { ViewLineData } from 'vs/editor/common/viewModel/viewModel';
import { ColorId } from 'vs/editor/common/modes';
import { FastDomNode, createFastDomNode } from 'vs/base/browser/fastDomNode';
import { IDisposable } from 'vs/base/common/lifecycle';
import { EditorScrollbar } from 'vs/editor/browser/viewParts/editorScrollbar/editorScrollbar';
import {
	RenderedLinesCollection,
	ILine
} from 'vs/editor/browser/view/viewLayer';
import { Range } from 'vs/editor/common/core/range';
import { RGBA } from 'vs/base/common/color';
import * as viewEvents from 'vs/editor/common/view/viewEvents';
import {
	GlobalMouseMoveMonitor,
	IStandardMouseMoveEventData,
	standardMouseMoveMerger
} from 'vs/base/browser/globalMouseMoveMonitor';
import * as platform from 'vs/base/common/platform';
import { registerThemingParticipant } from 'vs/platform/theme/common/themeService';
import {
	scrollbarSliderBackground,
	scrollbarSliderHoverBackground,
	scrollbarSliderActiveBackground,
	scrollbarShadow
} from 'vs/platform/theme/common/colorRegistry';

const enum RenderMinimap {
	None = 0,
	Small = 1,
	Large = 2,
	SmallBlocks = 3,
	LargeBlocks = 4
}

function getMinimapLineHeight(renderMinimap: RenderMinimap): number {
	if (renderMinimap === RenderMinimap.Large) {
		return Constants.x2_CHAR_HEIGHT;
	}
	if (renderMinimap === RenderMinimap.LargeBlocks) {
		return Constants.x2_CHAR_HEIGHT + 2;
	}
	if (renderMinimap === RenderMinimap.Small) {
		return Constants.x1_CHAR_HEIGHT;
	}
	// RenderMinimap.SmallBlocks
	return Constants.x1_CHAR_HEIGHT + 1;
}

function getMinimapCharWidth(renderMinimap: RenderMinimap): number {
	if (renderMinimap === RenderMinimap.Large) {
		return Constants.x2_CHAR_WIDTH;
	}
	if (renderMinimap === RenderMinimap.LargeBlocks) {
		return Constants.x2_CHAR_WIDTH;
	}
	if (renderMinimap === RenderMinimap.Small) {
		return Constants.x1_CHAR_WIDTH;
	}
	// RenderMinimap.SmallBlocks
	return Constants.x1_CHAR_WIDTH;
}

/**
 * The orthogonal distance to the slider at which dragging "resets". This implements "snapping"
 */
const MOUSE_DRAG_RESET_DISTANCE = 140;

class MinimapOptions {
	public readonly renderMinimap: RenderMinimap;

	public readonly showSlider: 'always' | 'mouseover';

	public readonly pixelRatio: number;

	public readonly lineHeight: number;

	/**
	 * container dom node width (in CSS px)
	 */
	public readonly minimapWidth: number;
	/**
	 * container dom node height (in CSS px)
	 */
	public readonly minimapHeight: number;

	/**
	 * canvas backing store width (in device px)
	 */
	public readonly canvasInnerWidth: number;
	/**
	 * canvas backing store height (in device px)
	 */
	public readonly canvasInnerHeight: number;

	/**
	 * canvas width (in CSS px)
	 */
	public readonly canvasOuterWidth: number;
	/**
	 * canvas height (in CSS px)
	 */
	public readonly canvasOuterHeight: number;

	constructor(configuration: editorCommon.IConfiguration) {
		const pixelRatio = configuration.editor.pixelRatio;
		const layoutInfo = configuration.editor.layoutInfo;
		const viewInfo = configuration.editor.viewInfo;

		this.renderMinimap = layoutInfo.renderMinimap | 0;
		this.showSlider = viewInfo.minimap.showSlider;
		this.pixelRatio = pixelRatio;
		this.lineHeight = configuration.editor.lineHeight;
		this.minimapWidth = layoutInfo.minimapWidth;
		this.minimapHeight = layoutInfo.height;

		this.canvasInnerWidth = Math.floor(pixelRatio * this.minimapWidth);
		this.canvasInnerHeight = Math.floor(pixelRatio * this.minimapHeight);

		this.canvasOuterWidth = this.canvasInnerWidth / pixelRatio;
		this.canvasOuterHeight = this.canvasInnerHeight / pixelRatio;
	}

	public equals(other: MinimapOptions): boolean {
		return (
			this.renderMinimap === other.renderMinimap &&
			this.showSlider === other.showSlider &&
			this.pixelRatio === other.pixelRatio &&
			this.lineHeight === other.lineHeight &&
			this.minimapWidth === other.minimapWidth &&
			this.minimapHeight === other.minimapHeight &&
			this.canvasInnerWidth === other.canvasInnerWidth &&
			this.canvasInnerHeight === other.canvasInnerHeight &&
			this.canvasOuterWidth === other.canvasOuterWidth &&
			this.canvasOuterHeight === other.canvasOuterHeight
		);
	}
}

class MinimapLayout {
	/**
	 * The given editor scrollTop (input).
	 */
	public readonly scrollTop: number;

	private readonly _computedSliderRatio: number;

	/**
	 * slider dom node top (in CSS px)
	 */
	public readonly sliderTop: number;
	/**
	 * slider dom node height (in CSS px)
	 */
	public readonly sliderHeight: number;

	/**
	 * minimap render start line number.
	 */
	public readonly startLineNumber: number;
	/**
	 * minimap render end line number.
	 */
	public readonly endLineNumber: number;

	constructor(
		scrollTop: number,
		computedSliderRatio: number,
		sliderTop: number,
		sliderHeight: number,
		startLineNumber: number,
		endLineNumber: number
	) {
		this.scrollTop = scrollTop;
		this._computedSliderRatio = computedSliderRatio;
		this.sliderTop = sliderTop;
		this.sliderHeight = sliderHeight;
		this.startLineNumber = startLineNumber;
		this.endLineNumber = endLineNumber;
	}

	/**
	 * Compute a desired `scrollPosition` such that the slider moves by `delta`.
	 */
	public getDesiredScrollTopFromDelta(delta: number): number {
		let desiredSliderPosition = this.sliderTop + delta;
		return Math.round(desiredSliderPosition / this._computedSliderRatio);
	}

	public static create(
		options: MinimapOptions,
		viewportStartLineNumber: number,
		viewportEndLineNumber: number,
		viewportHeight: number,
		viewportContainsWhitespaceGaps: boolean,
		lineCount: number,
		scrollbarSliderCenter: number,
		scrollTop: number,
		scrollHeight: number
	): MinimapLayout {
		const pixelRatio = options.pixelRatio;
		const minimapLineHeight = getMinimapLineHeight(options.renderMinimap);
		const minimapLinesFitting = Math.floor(
			options.canvasInnerHeight / minimapLineHeight
		);
		const lineHeight = options.lineHeight;

		// The visible line count in a viewport can change due to a number of reasons:
		//  a) with the same viewport width, different scroll positions can result in partial lines being visible:
		//    e.g. for a line height of 20, and a viewport height of 600
		//          * scrollTop = 0  => visible lines are [1, 30]
		//          * scrollTop = 10 => visible lines are [1, 31] (with lines 1 and 31 partially visible)
		//          * scrollTop = 20 => visible lines are [2, 31]
		//  b) whitespace gaps might make their way in the viewport (which results in a decrease in the visible line count)
		//  c) we could be in the scroll beyond last line case (which also results in a decrease in the visible line count, down to possibly only one line being visible)

		// We must first establish a desirable slider height.
		let sliderHeight: number;
		if (viewportContainsWhitespaceGaps && viewportEndLineNumber !== lineCount) {
			// case b) from above: there are whitespace gaps in the viewport.
			// In this case, the height of the slider directly reflects the visible line count.
			const viewportLineCount =
				viewportEndLineNumber - viewportStartLineNumber + 1;
			sliderHeight = Math.floor(
				viewportLineCount * minimapLineHeight / pixelRatio
			);
		} else {
			// The slider has a stable height
			const expectedViewportLineCount = viewportHeight / lineHeight;
			sliderHeight = Math.floor(
				expectedViewportLineCount * minimapLineHeight / pixelRatio
			);
		}

		const maxMinimapSliderTop = Math.min(
			options.minimapHeight - sliderHeight,
			(lineCount - 1) * minimapLineHeight / pixelRatio
		);
		// The slider can move from 0 to `maxMinimapSliderTop`
		// in the same way `scrollTop` can move from 0 to `scrollHeight` - `viewportHeight`.
		const computedSliderRatio =
			maxMinimapSliderTop / (scrollHeight - viewportHeight);
		const sliderTop = scrollTop * computedSliderRatio;

		if (minimapLinesFitting >= lineCount) {
			// All lines fit in the minimap
			const startLineNumber = 1;
			const endLineNumber = lineCount;

			return new MinimapLayout(
				scrollTop,
				computedSliderRatio,
				sliderTop,
				sliderHeight,
				startLineNumber,
				endLineNumber
			);
		} else {
			const startLineNumber = Math.max(
				1,
				Math.floor(
					viewportStartLineNumber - sliderTop * pixelRatio / minimapLineHeight
				)
			);
			const endLineNumber = Math.min(
				lineCount,
				startLineNumber + minimapLinesFitting - 1
			);

			return new MinimapLayout(
				scrollTop,
				computedSliderRatio,
				sliderTop,
				sliderHeight,
				startLineNumber,
				endLineNumber
			);
		}
	}
}

class MinimapLine implements ILine {
	public static INVALID = new MinimapLine(-1);

	dy: number;

	constructor(dy: number) {
		this.dy = dy;
	}

	public onContentChanged(): void {
		this.dy = -1;
	}

	public onTokensChanged(): void {
		this.dy = -1;
	}
}

class RenderData {
	/**
	 * last rendered layout.
	 */
	public readonly renderedLayout: MinimapLayout;
	private readonly _imageData: ImageData;
	private readonly _renderedLines: RenderedLinesCollection<MinimapLine>;

	constructor(
		renderedLayout: MinimapLayout,
		imageData: ImageData,
		lines: MinimapLine[]
	) {
		this.renderedLayout = renderedLayout;
		this._imageData = imageData;
		this._renderedLines = new RenderedLinesCollection(
			() => MinimapLine.INVALID
		);
		this._renderedLines._set(renderedLayout.startLineNumber, lines);
	}

	_get(): {
		imageData: ImageData;
		rendLineNumberStart: number;
		lines: MinimapLine[];
	} {
		let tmp = this._renderedLines._get();
		return {
			imageData: this._imageData,
			rendLineNumberStart: tmp.rendLineNumberStart,
			lines: tmp.lines
		};
	}

	public onLinesChanged(e: viewEvents.ViewLinesChangedEvent): boolean {
		return this._renderedLines.onLinesChanged(e.fromLineNumber, e.toLineNumber);
	}
	public onLinesDeleted(e: viewEvents.ViewLinesDeletedEvent): void {
		this._renderedLines.onLinesDeleted(e.fromLineNumber, e.toLineNumber);
	}
	public onLinesInserted(e: viewEvents.ViewLinesInsertedEvent): void {
		this._renderedLines.onLinesInserted(e.fromLineNumber, e.toLineNumber);
	}
	public onTokensChanged(e: viewEvents.ViewTokensChangedEvent): boolean {
		return this._renderedLines.onTokensChanged(e.ranges);
	}
}

/**
 * Some sort of double buffering.
 *
 * Keeps two buffers around that will be rotated for painting.
 * Always gives a buffer that is filled with the background color.
 */
class MinimapBuffers {
	private readonly _backgroundFillData: Uint8ClampedArray;
	private readonly _buffers: [ImageData, ImageData];
	private _lastUsedBuffer: number;

	constructor(
		ctx: CanvasRenderingContext2D,
		WIDTH: number,
		HEIGHT: number,
		background: RGBA
	) {
		this._backgroundFillData = MinimapBuffers._createBackgroundFillData(
			WIDTH,
			HEIGHT,
			background
		);
		this._buffers = [
			ctx.createImageData(WIDTH, HEIGHT),
			ctx.createImageData(WIDTH, HEIGHT)
		];
		this._lastUsedBuffer = 0;
	}

	public getBuffer(): ImageData {
		// rotate buffers
		this._lastUsedBuffer = 1 - this._lastUsedBuffer;
		let result = this._buffers[this._lastUsedBuffer];

		// fill with background color
		result.data.set(this._backgroundFillData);

		return result;
	}

	private static _createBackgroundFillData(
		WIDTH: number,
		HEIGHT: number,
		background: RGBA
	): Uint8ClampedArray {
		const backgroundR = background.r;
		const backgroundG = background.g;
		const backgroundB = background.b;

		let result = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
		let offset = 0;
		for (let i = 0; i < HEIGHT; i++) {
			for (let j = 0; j < WIDTH; j++) {
				result[offset] = backgroundR;
				result[offset + 1] = backgroundG;
				result[offset + 2] = backgroundB;
				result[offset + 3] = 255;
				offset += 4;
			}
		}

		return result;
	}
}

export class Minimap extends ViewPart {
	private readonly _editorScrollbar: EditorScrollbar;

	private readonly _domNode: FastDomNode<HTMLElement>;
	private readonly _shadow: FastDomNode<HTMLElement>;
	private readonly _canvas: FastDomNode<HTMLCanvasElement>;
	private readonly _slider: FastDomNode<HTMLElement>;
	private readonly _tokensColorTracker: MinimapTokensColorTracker;
	private readonly _mouseDownListener: IDisposable;
	private readonly _sliderMouseMoveMonitor: GlobalMouseMoveMonitor<
		IStandardMouseMoveEventData
	>;
	private readonly _sliderMouseDownListener: IDisposable;

	private readonly _minimapCharRenderer: MinimapCharRenderer;

	private _options: MinimapOptions;
	private _lastRenderData: RenderData;
	private _buffers: MinimapBuffers;

	constructor(context: ViewContext, editorScrollbar: EditorScrollbar) {
		super(context);
		this._editorScrollbar = editorScrollbar;

		this._options = new MinimapOptions(this._context.configuration);
		this._lastRenderData = null;
		this._buffers = null;

		this._domNode = createFastDomNode(document.createElement('div'));
		PartFingerprints.write(this._domNode, PartFingerprint.Minimap);
		this._domNode.setClassName(this._getMinimapDomNodeClassName());
		this._domNode.setPosition('absolute');
		this._domNode.setAttribute('role', 'presentation');
		this._domNode.setAttribute('aria-hidden', 'true');
		this._domNode.setRight(
			this._context.configuration.editor.layoutInfo.verticalScrollbarWidth
		);

		this._shadow = createFastDomNode(document.createElement('div'));
		this._shadow.setClassName('minimap-shadow-hidden');
		this._domNode.appendChild(this._shadow);

		this._canvas = createFastDomNode(document.createElement('canvas'));
		this._canvas.setPosition('absolute');
		this._canvas.setLeft(0);
		this._domNode.appendChild(this._canvas);

		this._slider = createFastDomNode(document.createElement('div'));
		this._slider.setPosition('absolute');
		this._slider.setClassName('minimap-slider');
		this._domNode.appendChild(this._slider);

		this._tokensColorTracker = MinimapTokensColorTracker.getInstance();

		this._minimapCharRenderer = getOrCreateMinimapCharRenderer();

		this._applyLayout();

		this._mouseDownListener = dom.addStandardDisposableListener(
			this._canvas.domNode,
			'mousedown',
			e => {
				e.preventDefault();

				const renderMinimap = this._options.renderMinimap;
				if (renderMinimap === RenderMinimap.None) {
					return;
				}
				if (!this._lastRenderData) {
					return;
				}
				const minimapLineHeight = getMinimapLineHeight(renderMinimap);
				const internalOffsetY =
					this._options.pixelRatio * e.browserEvent.offsetY;
				const lineIndex = Math.floor(internalOffsetY / minimapLineHeight);

				let lineNumber =
					lineIndex + this._lastRenderData.renderedLayout.startLineNumber;
				lineNumber = Math.min(lineNumber, this._context.model.getLineCount());

				this._context.privateViewEventBus.emit(
					new viewEvents.ViewRevealRangeRequestEvent(
						new Range(lineNumber, 1, lineNumber, 1),
						viewEvents.VerticalRevealType.Center,
						false
					)
				);
			}
		);

		this._sliderMouseMoveMonitor = new GlobalMouseMoveMonitor<
			IStandardMouseMoveEventData
		>();

		this._sliderMouseDownListener = dom.addStandardDisposableListener(
			this._slider.domNode,
			'mousedown',
			e => {
				e.preventDefault();
				if (e.leftButton && this._lastRenderData) {
					const initialMousePosition = e.posy;
					const initialMouseOrthogonalPosition = e.posx;
					const initialSliderState = this._lastRenderData.renderedLayout;
					this._slider.toggleClassName('active', true);

					this._sliderMouseMoveMonitor.startMonitoring(
						standardMouseMoveMerger,
						(mouseMoveData: IStandardMouseMoveEventData) => {
							const mouseOrthogonalDelta = Math.abs(
								mouseMoveData.posx - initialMouseOrthogonalPosition
							);

							if (
								platform.isWindows &&
								mouseOrthogonalDelta > MOUSE_DRAG_RESET_DISTANCE
							) {
								// The mouse has wondered away from the scrollbar => reset dragging
								this._context.viewLayout.setScrollPosition({
									scrollTop: initialSliderState.scrollTop
								});
								return;
							}

							const mouseDelta = mouseMoveData.posy - initialMousePosition;
							this._context.viewLayout.setScrollPosition({
								scrollTop: initialSliderState.getDesiredScrollTopFromDelta(
									mouseDelta
								)
							});
						},
						() => {
							this._slider.toggleClassName('active', false);
						}
					);
				}
			}
		);
	}

	public dispose(): void {
		this._mouseDownListener.dispose();
		this._sliderMouseMoveMonitor.dispose();
		this._sliderMouseDownListener.dispose();
		super.dispose();
	}

	private _getMinimapDomNodeClassName(): string {
		if (this._options.showSlider === 'always') {
			return 'minimap slider-always';
		}
		return 'minimap slider-mouseover';
	}

	public getDomNode(): FastDomNode<HTMLElement> {
		return this._domNode;
	}

	private _applyLayout(): void {
		this._domNode.setWidth(this._options.minimapWidth);
		this._domNode.setHeight(this._options.minimapHeight);
		this._shadow.setHeight(this._options.minimapHeight);
		this._canvas.setWidth(this._options.canvasOuterWidth);
		this._canvas.setHeight(this._options.canvasOuterHeight);
		this._canvas.domNode.width = this._options.canvasInnerWidth;
		this._canvas.domNode.height = this._options.canvasInnerHeight;
		this._slider.setWidth(this._options.minimapWidth);
	}

	private _getBuffer(): ImageData {
		if (!this._buffers) {
			this._buffers = new MinimapBuffers(
				this._canvas.domNode.getContext('2d'),
				this._options.canvasInnerWidth,
				this._options.canvasInnerHeight,
				this._tokensColorTracker.getColor(ColorId.DefaultBackground)
			);
		}
		return this._buffers.getBuffer();
	}

	private _onOptionsMaybeChanged(): boolean {
		let opts = new MinimapOptions(this._context.configuration);
		if (this._options.equals(opts)) {
			return false;
		}
		this._options = opts;
		this._lastRenderData = null;
		this._buffers = null;
		this._applyLayout();
		this._domNode.setClassName(this._getMinimapDomNodeClassName());
		return true;
	}

	// ---- begin view event handlers

	public onConfigurationChanged(
		e: viewEvents.ViewConfigurationChangedEvent
	): boolean {
		return this._onOptionsMaybeChanged();
	}
	public onFlushed(e: viewEvents.ViewFlushedEvent): boolean {
		this._lastRenderData = null;
		return true;
	}
	public onLinesChanged(e: viewEvents.ViewLinesChangedEvent): boolean {
		if (this._lastRenderData) {
			return this._lastRenderData.onLinesChanged(e);
		}
		return false;
	}
	public onLinesDeleted(e: viewEvents.ViewLinesDeletedEvent): boolean {
		if (this._lastRenderData) {
			this._lastRenderData.onLinesDeleted(e);
		}
		return true;
	}
	public onLinesInserted(e: viewEvents.ViewLinesInsertedEvent): boolean {
		if (this._lastRenderData) {
			this._lastRenderData.onLinesInserted(e);
		}
		return true;
	}
	public onScrollChanged(e: viewEvents.ViewScrollChangedEvent): boolean {
		return true;
	}
	public onTokensChanged(e: viewEvents.ViewTokensChangedEvent): boolean {
		if (this._lastRenderData) {
			return this._lastRenderData.onTokensChanged(e);
		}
		return false;
	}
	public onTokensColorsChanged(
		e: viewEvents.ViewTokensColorsChangedEvent
	): boolean {
		this._lastRenderData = null;
		this._buffers = null;
		return true;
	}
	public onZonesChanged(e: viewEvents.ViewZonesChangedEvent): boolean {
		this._lastRenderData = null;
		return true;
	}

	// --- end event handlers

	public prepareRender(ctx: RenderingContext): void {
		// Nothing to read
	}

	public render(renderingCtx: RestrictedRenderingContext): void {
		const renderMinimap = this._options.renderMinimap;
		if (renderMinimap === RenderMinimap.None) {
			this._shadow.setClassName('minimap-shadow-hidden');
			return;
		}
		if (
			renderingCtx.scrollLeft + renderingCtx.viewportWidth >=
			renderingCtx.scrollWidth
		) {
			this._shadow.setClassName('minimap-shadow-hidden');
		} else {
			this._shadow.setClassName('minimap-shadow-visible');
		}

		const layout = MinimapLayout.create(
			this._options,
			renderingCtx.visibleRange.startLineNumber,
			renderingCtx.visibleRange.endLineNumber,
			renderingCtx.viewportHeight,
			renderingCtx.viewportData.whitespaceViewportData.length > 0,
			this._context.model.getLineCount(),
			this._editorScrollbar.getVerticalSliderVerticalCenter(),
			renderingCtx.scrollTop,
			renderingCtx.scrollHeight
		);
		this._slider.setTop(layout.sliderTop);
		this._slider.setHeight(layout.sliderHeight);

		const startLineNumber = layout.startLineNumber;
		const endLineNumber = layout.endLineNumber;
		const minimapLineHeight = getMinimapLineHeight(renderMinimap);

		const imageData = this._getBuffer();

		// Render untouched lines by using last rendered data.
		let needed = Minimap._renderUntouchedLines(
			imageData,
			startLineNumber,
			endLineNumber,
			minimapLineHeight,
			this._lastRenderData
		);

		// Fetch rendering info from view model for rest of lines that need rendering.
		const lineInfo = this._context.model.getMinimapLinesRenderingData(
			startLineNumber,
			endLineNumber,
			needed
		);
		const tabSize = lineInfo.tabSize;
		const background = this._tokensColorTracker.getColor(
			ColorId.DefaultBackground
		);
		const useLighterFont = this._tokensColorTracker.backgroundIsLight();

		// Render the rest of lines
		let dy = 0;
		let renderedLines: MinimapLine[] = [];
		for (
			let lineIndex = 0, lineCount = endLineNumber - startLineNumber + 1;
			lineIndex < lineCount;
			lineIndex++
		) {
			if (needed[lineIndex]) {
				Minimap._renderLine(
					imageData,
					background,
					useLighterFont,
					renderMinimap,
					this._tokensColorTracker,
					this._minimapCharRenderer,
					dy,
					tabSize,
					lineInfo.data[lineIndex]
				);
			}
			renderedLines[lineIndex] = new MinimapLine(dy);
			dy += minimapLineHeight;
		}

		// Save rendered data for reuse on next frame if possible
		this._lastRenderData = new RenderData(layout, imageData, renderedLines);

		// Finally, paint to the canvas
		const ctx = this._canvas.domNode.getContext('2d');
		ctx.putImageData(imageData, 0, 0);
	}

	private static _renderUntouchedLines(
		target: ImageData,
		startLineNumber: number,
		endLineNumber: number,
		minimapLineHeight: number,
		lastRenderData: RenderData
	): boolean[] {
		let needed: boolean[] = [];
		if (!lastRenderData) {
			for (let i = 0, len = endLineNumber - startLineNumber + 1; i < len; i++) {
				needed[i] = true;
			}
			return needed;
		}

		const _lastData = lastRenderData._get();
		const lastTargetData = _lastData.imageData.data;
		const lastStartLineNumber = _lastData.rendLineNumberStart;
		const lastLines = _lastData.lines;
		const lastLinesLength = lastLines.length;
		const WIDTH = target.width;
		const targetData = target.data;

		let copySourceStart = -1;
		let copySourceEnd = -1;
		let copyDestStart = -1;
		let copyDestEnd = -1;

		let dest_dy = 0;
		for (
			let lineNumber = startLineNumber;
			lineNumber <= endLineNumber;
			lineNumber++
		) {
			const lineIndex = lineNumber - startLineNumber;
			const lastLineIndex = lineNumber - lastStartLineNumber;
			const source_dy = lastLineIndex >= 0 && lastLineIndex < lastLinesLength
				? lastLines[lastLineIndex].dy
				: -1;

			if (source_dy === -1) {
				needed[lineIndex] = true;
				dest_dy += minimapLineHeight;
				continue;
			}

			let sourceStart = source_dy * WIDTH * 4;
			let sourceEnd = (source_dy + minimapLineHeight) * WIDTH * 4;
			let destStart = dest_dy * WIDTH * 4;
			let destEnd = (dest_dy + minimapLineHeight) * WIDTH * 4;

			if (copySourceEnd === sourceStart && copyDestEnd === destStart) {
				// contiguous zone => extend copy request
				copySourceEnd = sourceEnd;
				copyDestEnd = destEnd;
			} else {
				if (copySourceStart !== -1) {
					// flush existing copy request
					targetData.set(
						lastTargetData.subarray(copySourceStart, copySourceEnd),
						copyDestStart
					);
				}
				copySourceStart = sourceStart;
				copySourceEnd = sourceEnd;
				copyDestStart = destStart;
				copyDestEnd = destEnd;
			}

			needed[lineIndex] = false;
			dest_dy += minimapLineHeight;
		}

		if (copySourceStart !== -1) {
			// flush existing copy request
			targetData.set(
				lastTargetData.subarray(copySourceStart, copySourceEnd),
				copyDestStart
			);
		}

		return needed;
	}

	private static _renderLine(
		target: ImageData,
		backgroundColor: RGBA,
		useLighterFont: boolean,
		renderMinimap: RenderMinimap,
		colorTracker: MinimapTokensColorTracker,
		minimapCharRenderer: MinimapCharRenderer,
		dy: number,
		tabSize: number,
		lineData: ViewLineData
	): void {
		const content = lineData.content;
		const tokens = lineData.tokens;
		const charWidth = getMinimapCharWidth(renderMinimap);
		const maxDx = target.width - charWidth;

		let dx = 0;
		let charIndex = 0;
		let tabsCharDelta = 0;

		for (
			let tokenIndex = 0, tokensLen = tokens.length;
			tokenIndex < tokensLen;
			tokenIndex++
		) {
			const token = tokens[tokenIndex];
			const tokenEndIndex = token.endIndex;
			const tokenColorId = token.getForeground();
			const tokenColor = colorTracker.getColor(tokenColorId);

			for (; charIndex < tokenEndIndex; charIndex++) {
				if (dx > maxDx) {
					// hit edge of minimap
					return;
				}
				const charCode = content.charCodeAt(charIndex);

				if (charCode === CharCode.Tab) {
					let insertSpacesCount =
						tabSize - (charIndex + tabsCharDelta) % tabSize;
					tabsCharDelta += insertSpacesCount - 1;
					// No need to render anything since tab is invisible
					dx += insertSpacesCount * charWidth;
				} else if (charCode === CharCode.Space) {
					// No need to render anything since space is invisible
					dx += charWidth;
				} else {
					if (renderMinimap === RenderMinimap.Large) {
						minimapCharRenderer.x2RenderChar(
							target,
							dx,
							dy,
							charCode,
							tokenColor,
							backgroundColor,
							useLighterFont
						);
					} else if (renderMinimap === RenderMinimap.Small) {
						minimapCharRenderer.x1RenderChar(
							target,
							dx,
							dy,
							charCode,
							tokenColor,
							backgroundColor,
							useLighterFont
						);
					} else if (renderMinimap === RenderMinimap.LargeBlocks) {
						minimapCharRenderer.x2BlockRenderChar(
							target,
							dx,
							dy,
							tokenColor,
							backgroundColor,
							useLighterFont
						);
					} else {
						// RenderMinimap.SmallBlocks
						minimapCharRenderer.x1BlockRenderChar(
							target,
							dx,
							dy,
							tokenColor,
							backgroundColor,
							useLighterFont
						);
					}
					dx += charWidth;
				}
			}
		}
	}
}

registerThemingParticipant((theme, collector) => {
	let sliderBackground = theme.getColor(scrollbarSliderBackground);
	if (sliderBackground) {
		collector.addRule(
			`.monaco-editor .minimap-slider { background: ${sliderBackground}; }`
		);
	}
	let sliderHoverBackground = theme.getColor(scrollbarSliderHoverBackground);
	if (sliderHoverBackground) {
		collector.addRule(
			`.monaco-editor .minimap-slider:hover { background: ${sliderHoverBackground}; }`
		);
	}
	let sliderActiveBackground = theme.getColor(scrollbarSliderActiveBackground);
	if (sliderActiveBackground) {
		collector.addRule(
			`.monaco-editor .minimap-slider.active { background: ${sliderActiveBackground}; }`
		);
	}
	let shadow = theme.getColor(scrollbarShadow);
	if (shadow) {
		collector.addRule(
			`.monaco-editor .minimap-shadow-visible { box-shadow: ${shadow} -6px 0 6px -6px inset; }`
		);
	}
});
