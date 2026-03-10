/* Copyright 2026 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { CanvasGraphics } from "./canvas.js";
import { FontLoader } from "./font_loader.js";
import { initGPU } from "./webgpu.js";
import { isNodeJS } from "../shared/util.js";
import { MessageHandler } from "../shared/message_handler.js";
import { ObjectHandler } from "./object_handler.js";
import { OffscreenCanvasFactory } from "./canvas_factory.js";
import { OptionalContentConfig } from "./optional_content_config.js";
import { PDFObjects } from "./pdf_objects.js";
import { WorkerFilterFactory } from "./filter_factory.js";

class RendererMessageHandler {
  static #commonObjs = new PDFObjects();

  static #objsMap = new Map();

  static #renderTaskStates = new Map();

  static #pendingOperatorLists = new Map(); // Queue for operator lists arriving before render task init

  static #canvasMap = new Map();

  static #cleanedPages = new Set();

  static #fontLoader = new FontLoader({
    ownerDocument: globalThis,
  });

  static #pdfWorkerHandlers = new Map();

  static {
    // Worker thread (and not Node.js)?
    if (
      typeof window === "undefined" &&
      !isNodeJS &&
      typeof self !== "undefined" &&
      /* isMessagePort = */
      typeof self.postMessage === "function" &&
      "onmessage" in self
    ) {
      this.initializeFromPort(self);
    }
  }

  static initializeFromPort(port) {
    const handler = new MessageHandler("renderer", "main", port);
    this.setup(handler);
    handler.send("ready", null);
  }

  static #getPageObjs(pageIndex) {
    let objs = this.#objsMap.get(pageIndex);
    if (!objs) {
      objs = new PDFObjects();
      this.#objsMap.set(pageIndex, objs);
    }
    return objs;
  }

  static #cleanupRenderTask(renderTaskId) {
    // Clean up any pending operator lists for this render task
    this.#pendingOperatorLists.delete(renderTaskId);

    const renderTaskState = this.#renderTaskStates.get(renderTaskId);
    if (!renderTaskState) {
      return;
    }
    renderTaskState.aborted = true;
    renderTaskState.waitCapability?.resolve();
    renderTaskState.waitCapability = null;

    renderTaskState.gfx.endDrawing();
    this.#renderTaskStates.delete(renderTaskId);
  }

  static #cleanupPage(pageIndex, keepCanvas = false) {
    this.#cleanedPages.add(pageIndex);
    this.#objsMap.delete(pageIndex);
    for (const [renderTaskId, renderTaskState] of this.#renderTaskStates) {
      if (renderTaskState.pageIndex === pageIndex) {
        this.#cleanupRenderTask(renderTaskId);
      }
    }
    if (!keepCanvas) {
      this.#canvasMap.delete(pageIndex);
    }
  }

  static #appendOperatorList(renderTaskState, fnArray, argsArray, lastChunk) {
    const { operatorList } = renderTaskState;
    if (fnArray) {
      operatorList.fnArray.push(...fnArray);
      operatorList.argsArray.push(...argsArray);
    }
    operatorList.lastChunk = lastChunk;
  }

  static async #executeOperatorList(renderTaskState, operationsFilter) {
    const { operatorList, gfx } = renderTaskState;
    // TODO(Aditi): Check FontFallback
    renderTaskState.running = true;
    try {
      while (!renderTaskState.aborted) {
        const waitCapability = Promise.withResolvers();
        renderTaskState.waitCapability = waitCapability;
        let continueCalled = false;

        const continueCallback = () => {
          if (!continueCalled) {
            continueCalled = true;
            waitCapability.resolve();
          }
        };

        renderTaskState.operatorListIdx = gfx.executeOperatorList(
          operatorList,
          renderTaskState.operatorListIdx,
          continueCallback,
          undefined,
          typeof operationsFilter === "function" ? operationsFilter : null
        );
        renderTaskState.waitCapability = null;

        if (renderTaskState.operatorListIdx === operatorList.argsArray.length) {
          // Processed all available operations
          if (operatorList.lastChunk) {
            // All done
            return renderTaskState.operatorListIdx;
          }
          // More chunks may arrive, exit loop and wait to be re-triggered
          return renderTaskState.operatorListIdx;
        }
        await waitCapability.promise;
      }
      return renderTaskState.operatorListIdx;
    } finally {
      renderTaskState.running = false;
    }
  }

  static #operatorListChanged(renderTaskState) {
    if (renderTaskState.running || renderTaskState.aborted) {
      // Already executing, loop will pick up new operations
      return;
    }
    // Start execution in background, track the promise
    renderTaskState.executionPromise = this.#executeOperatorList(
      renderTaskState,
      null
    ).finally(() => {
      renderTaskState.executionPromise = null;
    });
  }

  static #setupObjectHandler(handler) {
    const objectHandler = new ObjectHandler({
      messageHandler: handler,
      commonObjs: this.#commonObjs,
      fontLoader: this.#fontLoader,
      pageCache: this.#objsMap,
      shouldCreatePageObjs: true,
    });

    handler.on("commonobj", ([id, type, exportedData]) => {
      if (this.#commonObjs.has(id)) {
        return null;
      }
      return objectHandler.resolveCommonObject(id, type, exportedData);
    });

    handler.on("obj", ([id, pageIndex, type, imageData]) => {
      // The page may have been cleaned up before this message was processed;
      // drop the data and release any `ImageBitmap` instead of resurrecting
      // an empty object bag for a dead page.
      if (this.#cleanedPages.has(pageIndex)) {
        imageData?.bitmap?.close();
        return;
      }
      objectHandler.resolveObject(id, pageIndex, type, imageData);
    });
  }

  static setup(handler) {
    let testMessageProcessed = false;
    handler.on("test", data => {
      if (testMessageProcessed) {
        return;
      }
      testMessageProcessed = true;

      // Ensure that `TypedArray`s can be sent to the worker.
      handler.send("test", data instanceof Uint8Array);
    });

    this.#setupObjectHandler(handler);

    handler.on("cleanupPage", ({ pageIndex, keepCanvas }) => {
      this.#cleanupPage(pageIndex, keepCanvas);
    });

    handler.on("CleanupRenderTask", ({ renderTaskId }) => {
      this.#cleanupRenderTask(renderTaskId);
    });

    handler.on("InitializeGraphics", async data => {
      const {
        canvas,
        pageIndex,
        renderTaskId = pageIndex,
        enableHWA = false,
        enableWebGPU = false,
        optionalContentConfigData,
        optionalContentConfigState,
        optionalContentConfigRenderingIntent,
        annotationCanvasMap,
        transform,
        viewport,
        transparency,
        background,
      } = data;
      this.#cleanedPages.delete(pageIndex);
      if (enableWebGPU) {
        initGPU();
      }
      const objs = this.#getPageObjs(pageIndex);
      const optionalContentConfig = new OptionalContentConfig(
        optionalContentConfigData,
        optionalContentConfigRenderingIntent
      );

      if (optionalContentConfigState) {
        for (const [id, visible] of optionalContentConfigState) {
          optionalContentConfig.setVisibility(
            id,
            visible,
            /* preserveRB = */ false
          );
        }
      }
      const ctx = canvas.getContext("2d", {
        alpha: false,
        willReadFrequently: !enableHWA,
      });
      const canvasFactory = new OffscreenCanvasFactory({ enableHWA });
      const filterFactory = new WorkerFilterFactory();
      let annotationCanvases = null;
      if (annotationCanvasMap) {
        annotationCanvases =
          annotationCanvasMap instanceof Map
            ? annotationCanvasMap
            : new Map(annotationCanvasMap);
      }
      const gfx = new CanvasGraphics(
        ctx,
        this.#commonObjs,
        objs,
        canvasFactory,
        filterFactory,
        { optionalContentConfig },
        annotationCanvases
        /** Renderer worker doesn't support pageColors and dependencyTracker */
      );
      gfx.beginDrawing({
        transform,
        viewport,
        transparency,
        background,
      });

      // Store a reference to the OffscreenCanvas
      this.#canvasMap.set(pageIndex, canvas);

      this.#cleanupRenderTask(renderTaskId);
      this.#renderTaskStates.set(renderTaskId, {
        pageIndex,
        gfx,
        operatorList: {
          fnArray: [],
          argsArray: [],
          lastChunk: false,
        },
        operatorListIdx: 0,
        waitCapability: null,
        aborted: false,
        running: false,
        executionPromise: null,
      });

      // Process any chunks that arrived before InitializeGraphics
      const pendingChunks = this.#pendingOperatorLists.get(renderTaskId);
      if (pendingChunks) {
        const renderTaskState = this.#renderTaskStates.get(renderTaskId);
        for (const chunk of pendingChunks) {
          this.#appendOperatorList(
            renderTaskState,
            chunk.fnArray,
            chunk.argsArray,
            chunk.lastChunk
          );
          if (chunk.separateAnnots !== null) {
            renderTaskState.operatorList.separateAnnots = chunk.separateAnnots;
          }
        }
        this.#pendingOperatorLists.delete(renderTaskId);
        // Trigger execution (like operatorListChanged on main thread)
        this.#operatorListChanged(renderTaskState);
      }
    });

    handler.on("UpdateAnnotationCanvases", data => {
      const { renderTaskId, annotationCanvasMap } = data;
      if (!annotationCanvasMap) {
        return;
      }
      const renderTaskState = this.#renderTaskStates.get(renderTaskId);
      if (!renderTaskState || !renderTaskState.gfx.annotationCanvasMap) {
        return;
      }
      const map =
        annotationCanvasMap instanceof Map
          ? annotationCanvasMap
          : new Map(annotationCanvasMap);
      for (const [id, canvas] of map) {
        renderTaskState.gfx.annotationCanvasMap.set(id, canvas);
      }
    });

    handler.on("ExecuteOperatorList", async data => {
      const {
        renderTaskId,
        fnArray,
        argsArray,
        operatorListIdx,
        operationsFilter,
        lastChunk,
      } = data;
      const renderTaskState = this.#renderTaskStates.get(renderTaskId);
      if (!renderTaskState) {
        // A render task can be cleaned up before queued
        // ExecuteOperatorList messages for that task are processed.
        return operatorListIdx;
      }

      // Only append if we don't already have this data from direct streaming.
      // If direct streaming is active, the operator list will already be
      // populated.
      const currentLength = renderTaskState.operatorList.argsArray.length;
      const expectedLength = operatorListIdx + (fnArray?.length || 0);
      if (fnArray && currentLength < expectedLength) {
        this.#appendOperatorList(
          renderTaskState,
          fnArray,
          argsArray,
          lastChunk
        );
        // Trigger execution for new data from main thread fallback path
        this.#operatorListChanged(renderTaskState);
      } else if (lastChunk) {
        renderTaskState.operatorList.lastChunk = true;
      }

      // Wait for any ongoing execution to complete
      if (renderTaskState.executionPromise) {
        await renderTaskState.executionPromise;
      }

      // If execution was triggered, wait for it; otherwise trigger now
      if (
        !renderTaskState.running &&
        renderTaskState.operatorListIdx <
          renderTaskState.operatorList.argsArray.length
      ) {
        renderTaskState.executionPromise = this.#executeOperatorList(
          renderTaskState,
          operationsFilter
        ).finally(() => {
          renderTaskState.executionPromise = null;
        });
        await renderTaskState.executionPromise;
      }

      const currentOperatorListIdx = renderTaskState.operatorListIdx;
      if (
        renderTaskState.operatorList.lastChunk &&
        currentOperatorListIdx === renderTaskState.operatorList.argsArray.length
      ) {
        this.#cleanupRenderTask(renderTaskId);
      }
      return currentOperatorListIdx;
    });

    handler.on("ResetCanvas", ({ renderTaskId }) => {
      this.#cleanupRenderTask(renderTaskId);
    });

    handler.on("SetupWorkerChannel", data => this.setupWorkerChannel(data));
  }

  static setupWorkerChannel({ docId = null, port = null } = {}) {
    if (!port) {
      throw new Error("SetupWorkerChannel - expected a MessagePort.");
    }

    const bridgeId = docId || "default";
    const sourceName = `renderer_worker_${bridgeId}`;
    const targetName = `pdf_worker_${bridgeId}`;

    this.#pdfWorkerHandlers.get(bridgeId)?.destroy();

    const pdfWorkerHandler = new MessageHandler(sourceName, targetName, port);
    this.#pdfWorkerHandlers.set(bridgeId, pdfWorkerHandler);

    // Object handling forwarded from main thread - now handled by PDF worker
    // transferring to worker directly.
    this.#setupObjectHandler(pdfWorkerHandler);

    // Handle operator list chunks sent directly from PDF worker
    // (same streaming behavior as main thread)
    pdfWorkerHandler.on("RenderPageChunk", data => {
      const { pageIndex, fnArray, argsArray, lastChunk, separateAnnots } = data;
      const renderTaskId = pageIndex;

      const renderTaskState = this.#renderTaskStates.get(renderTaskId);
      if (!renderTaskState) {
        // Render task not yet initialized - queue chunk for later
        let queue = this.#pendingOperatorLists.get(renderTaskId);
        if (!queue) {
          queue = [];
          this.#pendingOperatorLists.set(renderTaskId, queue);
        }
        queue.push({ fnArray, argsArray, lastChunk, separateAnnots });
        return;
      }

      // Append chunk to operator list (like _renderPageChunk on main thread)
      this.#appendOperatorList(renderTaskState, fnArray, argsArray, lastChunk);
      if (separateAnnots !== null) {
        renderTaskState.operatorList.separateAnnots = separateAnnots;
      }

      // Trigger execution (like operatorListChanged on main thread)
      this.#operatorListChanged(renderTaskState);
    });

    // MessageHandler uses addEventListener, so we must call start() on
    // MessagePort. Call start() AFTER registering handlers to ensure all
    // handlers are in place before messages can be delivered.
    port.start();

    pdfWorkerHandler.send("ready", null);
    return { ok: true, docId: bridgeId };
  }
}

export { RendererMessageHandler };
