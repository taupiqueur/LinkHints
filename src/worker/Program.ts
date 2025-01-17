import type {
  ElementReport,
  ElementType,
  ElementTypes,
  VisibleElement,
} from "../shared/hints";
import {
  isModifierKey,
  keyboardEventToKeypress,
  KeyboardMapping,
  KeyboardModeWorker,
  KeyTranslations,
  normalizeKeypress,
} from "../shared/keyboard";
import {
  addEventListener,
  addListener,
  Box,
  CONTAINER_ID,
  decode,
  extractText,
  fireAndForget,
  getLabels,
  getTextRects,
  getViewport,
  LAST_NON_WHITESPACE,
  log,
  NON_WHITESPACE,
  Resets,
  walkTextNodes,
} from "../shared/main";
import type {
  FromBackground,
  FromWorker,
  ToBackground,
} from "../shared/messages";
import { TimeTracker } from "../shared/perf";
import { selectorString, tweakable, unsignedInt } from "../shared/tweakable";
import { FrameMessage } from "./decoders";
import ElementManager from "./ElementManager";

type CurrentElements = {
  elements: Array<VisibleElement>;
  frames: Array<HTMLFrameElement | HTMLIFrameElement>;
  viewports: Array<Box>;
  types: ElementTypes;
  indexes: Array<number>;
  words: Array<string>;
  waitId: WaitId;
};

type WaitId =
  | {
      tag: "NotWaiting";
    }
  | {
      tag: "RequestAnimationFrame";
      id: number;
    }
  | {
      tag: "RequestIdleCallback";
      id: IdleCallbackID;
    };

export const t = {
  // How long a copied element should be selected.
  FLASH_COPIED_ELEMENT_DURATION: unsignedInt(200), // ms
  // Elements that look bad when inverted.
  FLASH_COPIED_ELEMENT_NO_INVERT_SELECTOR: selectorString(
    "img, audio, video, object, embed, iframe, frame, input, textarea, select, progress, meter, canvas"
  ),
  HINTS_REFRESH_IDLE_CALLBACK_TIMEOUT: unsignedInt(100), // ms
};

export const tMeta = tweakable("Worker", t);

export default class WorkerProgram {
  isPinned = true;

  keyboardShortcuts: Array<KeyboardMapping> = [];

  keyboardMode: KeyboardModeWorker = "Normal";

  keyTranslations: KeyTranslations = {};

  current: CurrentElements | undefined = undefined;

  oneTimeWindowMessageToken: string | undefined = undefined;

  mac = false;

  suppressNextKeyup: { key: string; code: string } | undefined = undefined;

  resets = new Resets();

  elementManager = new ElementManager({
    onMutation: this.onMutation.bind(this),
  });

  async start(): Promise<void> {
    this.resets.add(
      addListener(
        browser.runtime.onMessage,
        this.onMessage.bind(this),
        "WorkerProgram#onMessage"
      ),
      addEventListener(
        window,
        "keydown",
        this.onKeydown.bind(this),
        "WorkerProgram#onKeydown",
        { passive: false }
      ),
      addEventListener(
        window,
        "keyup",
        this.onKeyup.bind(this),
        "WorkerProgram#onKeyup",
        { passive: false }
      ),
      addEventListener(
        window,
        "message",
        this.onWindowMessage.bind(this),
        "WorkerProgram#onWindowMessage"
      ),
      addEventListener(
        window,
        "pagehide",
        this.onPageHide.bind(this),
        "WorkerProgram#onPageHide"
      ),
      addEventListener(
        window,
        "pageshow",
        this.onPageShow.bind(this),
        "WorkerProgram#onPageShow"
      )
    );
    await this.elementManager.start();

    this.markTutorial();

    // See `RendererProgram#start`.
    try {
      await browser.runtime.sendMessage(
        wrapMessage({ type: "WorkerScriptAdded" })
      );
    } catch {
      return;
    }
    browser.runtime.connect().onDisconnect.addListener(() => {
      this.stop();
    });
  }

  stop(): void {
    log("log", "WorkerProgram#stop");
    this.resets.reset();
    this.elementManager.stop();
    this.oneTimeWindowMessageToken = undefined;
    this.suppressNextKeyup = undefined;
    this.clearCurrent();
  }

  sendMessage(message: FromWorker): void {
    log("log", "WorkerProgram#sendMessage", message.type, message);
    fireAndForget(
      browser.runtime.sendMessage(wrapMessage(message)).then(() => undefined),
      "WorkerProgram#sendMessage",
      message
    );
  }

  onMessage(wrappedMessage: FromBackground): void {
    // See `RendererProgram#onMessage`.
    if (wrappedMessage.type === "FirefoxWorkaround") {
      this.sendMessage({ type: "WorkerScriptAdded" });
      return;
    }

    if (wrappedMessage.type !== "ToWorker") {
      return;
    }

    const { message } = wrappedMessage;

    log("log", "WorkerProgram#onMessage", message.type, message);

    switch (message.type) {
      case "StateSync":
        log.level = message.logLevel;
        this.isPinned = message.isPinned;
        this.keyboardShortcuts = message.keyboardShortcuts;
        this.keyboardMode = message.keyboardMode;
        this.keyTranslations = message.keyTranslations;
        this.oneTimeWindowMessageToken = message.oneTimeWindowMessageToken;
        this.mac = message.mac;

        if (message.clearElements) {
          this.clearCurrent();
        }
        break;

      case "StartFindElements": {
        const run = (types: ElementTypes): void => {
          const { oneTimeWindowMessageToken } = this;
          if (oneTimeWindowMessageToken === undefined) {
            log("error", "missing oneTimeWindowMessageToken", message);
            return;
          }
          const viewport = getViewport();
          this.reportVisibleElements(
            types,
            [viewport],
            oneTimeWindowMessageToken
          );
        };

        if (this.current === undefined) {
          run(message.types);
        } else {
          this.current.types = message.types;
          switch (this.current.waitId.tag) {
            case "NotWaiting": {
              const id1 = requestAnimationFrame(() => {
                if (this.current !== undefined) {
                  const id2 = requestIdleCallback(
                    () => {
                      if (this.current !== undefined) {
                        this.current.waitId = { tag: "NotWaiting" };
                        run(this.current.types);
                      }
                    },
                    { timeout: t.HINTS_REFRESH_IDLE_CALLBACK_TIMEOUT.value }
                  );
                  this.current.waitId = { tag: "RequestIdleCallback", id: id2 };
                }
              });
              this.current.waitId = { tag: "RequestAnimationFrame", id: id1 };
              break;
            }

            case "RequestAnimationFrame":
            case "RequestIdleCallback":
              break;
          }
        }
        break;
      }

      case "UpdateElements": {
        const { current, oneTimeWindowMessageToken } = this;
        if (current === undefined) {
          return;
        }

        current.viewports = [getViewport()];

        this.updateVisibleElements({
          current,
          oneTimeWindowMessageToken,
        });
        break;
      }

      case "GetTextRects": {
        const { current } = this;
        if (current === undefined) {
          return;
        }

        const { indexes, words } = message;
        current.indexes = indexes;
        current.words = words;

        const elements = current.elements.filter((_elementData, index) =>
          indexes.includes(index)
        );
        const wordsSet = new Set(words);
        const rects = elements.flatMap((elementData) =>
          getTextRectsHelper({
            element: elementData.element,
            type: elementData.type,
            viewports: current.viewports,
            words: wordsSet,
          })
        );

        this.sendMessage({
          type: "ReportTextRects",
          rects,
        });

        break;
      }

      case "FocusElement": {
        const elementData = this.getElement(message.index);
        if (elementData === undefined) {
          log("error", "FocusElement: Missing element", message, this.current);
          return;
        }

        const { element } = elementData;
        const activeElement = this.elementManager.getActiveElement(document);
        const textInputIsFocused =
          activeElement !== undefined && isTextInput(activeElement);

        // Allow opening links in new tabs without losing focus from a text
        // input.
        if (!textInputIsFocused) {
          element.focus();
        }

        break;
      }

      case "ClickElement": {
        const elementData = this.getElement(message.index);

        if (elementData === undefined) {
          log("error", "ClickElement: Missing element", message, this.current);
          return;
        }

        log("log", "WorkerProgram: ClickElement", elementData);

        const { element } = elementData;

        const defaultPrevented = this.clickElement(element);

        if (
          !defaultPrevented &&
          elementData.type === "link" &&
          element instanceof HTMLAnchorElement &&
          !isInternalHashLink(element)
        ) {
          // I think it’s fine to send this even if the link opened in a new tab.
          this.sendMessage({ type: "ClickedLinkNavigatingToOtherPage" });
        }

        break;
      }

      case "SelectElement": {
        const elementData = this.getElement(message.index);
        if (elementData === undefined) {
          log("error", "SelectElement: Missing element", message, this.current);
          return;
        }

        log("log", "WorkerProgram: SelectElement", elementData);

        const { element } = elementData;

        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
        ) {
          // Focus and, if possible, select the text inside. There are two cases
          // here: "Text input" (`<textarea>`, `<input type="text">`, `<input
          // type="search">`, `<input type="unknown">`, etc) style elements
          // technically only need `.select()`, but it doesn't hurt calling
          // `.focus()` first. For all other types (`<input type="checkbox">`,
          // `<input type="color">`, etc) `.select()` seems to be a no-op, so
          // `.focus()` is strictly needed but calling `.select()` also doesn't
          // hurt.
          element.focus();
          element.select();
        } else if (
          // Text inside `<button>` elements can be selected and copied just
          // fine in Chrome, but not in Firefox. In Firefox,
          // `document.elementFromPoint(x, y)` returns the `<button>` for
          // elements nested inside, causing them not to get hints either.
          (BROWSER === "firefox" && element instanceof HTMLButtonElement) ||
          // `<select>` elements _can_ be selected, but you seem to get the
          // empty string when trying to copy them.
          element instanceof HTMLSelectElement ||
          // Frame elements can be selected in Chrome, but that just looks
          // weird. The reason to focus a frame element is to allow the arrow
          // keys to scroll them.
          element instanceof HTMLIFrameElement ||
          element instanceof HTMLFrameElement
        ) {
          element.focus();
        } else {
          // Focus the element, even if it isn't usually focusable.
          if (element !== this.elementManager.getActiveElement(document)) {
            focusElement(element);
          }

          // Try to select the text of the element, or the element itself.
          const selection = window.getSelection();
          if (selection !== null) {
            // Firefox won’t select text inside a ShadowRoot without this timeout.
            setTimeout(() => {
              const range = selectNodeContents(element);
              selection.removeAllRanges();
              selection.addRange(range);
            }, 0);
          }
        }

        break;
      }

      case "CopyElement": {
        const elementData = this.getElement(message.index);
        if (elementData === undefined) {
          log("error", "CopyElement: Missing element", message, this.current);
          return;
        }

        log("log", "WorkerProgram: CopyElement", elementData);

        const { element } = elementData;
        const text: string =
          element instanceof HTMLAnchorElement
            ? element.href
            : element instanceof HTMLImageElement ||
              element instanceof HTMLMediaElement
            ? element.currentSrc
            : element instanceof HTMLObjectElement
            ? element.data
            : element instanceof HTMLEmbedElement ||
              element instanceof HTMLIFrameElement ||
              element instanceof HTMLFrameElement
            ? element.src
            : element instanceof HTMLInputElement ||
              element instanceof HTMLTextAreaElement ||
              element instanceof HTMLSelectElement
            ? element.value
            : element instanceof HTMLProgressElement ||
              element instanceof HTMLMeterElement
            ? element.value.toString()
            : element instanceof HTMLCanvasElement
            ? element.toDataURL()
            : element instanceof HTMLPreElement
            ? extractText(element)
            : // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
              normalizeWhitespace(extractText(element)) || element.outerHTML;

        fireAndForget(
          navigator.clipboard.writeText(text),
          "WorkerProgram#onMessage->CopyElement->clipboard.writeText",
          message,
          text
        );

        flashElement(element);

        break;
      }

      // Used instead of `browser.tabs.create` in Chrome, to have the opened tab
      // end up in the same position as if you'd clicked a link with the mouse.
      // This technique does not seem to work in Firefox, but it's not needed
      // there anyway (see background/Program.ts).
      case "OpenNewTab": {
        const { url, foreground } = message;
        const link = document.createElement("a");
        link.href = url;
        link.dispatchEvent(
          new MouseEvent("click", {
            ctrlKey: true,
            metaKey: true,
            shiftKey: foreground,
          })
        );
        break;
      }

      case "Escape": {
        const activeElement = this.elementManager.getActiveElement(document);
        if (activeElement !== undefined) {
          activeElement.blur();
        }
        const selection = window.getSelection();
        if (selection !== null) {
          selection.removeAllRanges();
        }
        break;
      }

      case "ReverseSelection": {
        const selection = window.getSelection();
        if (selection !== null) {
          reverseSelection(selection);
        }
        break;
      }
    }
  }

  onWindowMessage(event: MessageEvent): void {
    const { oneTimeWindowMessageToken } = this;

    if (
      oneTimeWindowMessageToken !== undefined &&
      typeof event.data === "object" &&
      event.data !== null &&
      !Array.isArray(event.data) &&
      (event.data as Record<string, unknown>).token ===
        oneTimeWindowMessageToken &&
      typeof (event.data as Record<string, unknown>).type === "string"
    ) {
      let message = undefined;
      try {
        message = decode(FrameMessage, event.data);
      } catch (error) {
        log(
          "warn",
          "Ignoring bad window message",
          oneTimeWindowMessageToken,
          event,
          error
        );
        return;
      }

      this.oneTimeWindowMessageToken = undefined;
      log("log", "WorkerProgram#onWindowMessage", message);

      switch (message.type) {
        case "FindElements":
          this.sendMessage({ type: "ReportVisibleFrame" });
          this.reportVisibleElements(
            message.types,
            message.viewports,
            oneTimeWindowMessageToken
          );
          break;

        case "UpdateElements": {
          const { current } = this;
          if (current === undefined) {
            return;
          }

          current.viewports = message.viewports;
          this.updateVisibleElements({
            current,
            oneTimeWindowMessageToken,
          });
          break;
        }
      }
    }
  }

  // This is run in the capture phase of the keydown event, overriding any site
  // shortcuts. The initial idea was to run in the bubble phase (mostly) and let
  // sites use `event.preventDefault()` to override the extension shortcuts
  // (just like any other browser shortcut). However, duckduckgo.com has "j/k"
  // shortcuts for navigation, but don't check for the alt key and don't call
  // `event.preventDefault()`, making it impossible to use alt-j as an extension
  // shortcut without causing side-effects. This feels like a common thing, so
  // (at least for now) the extension shortcuts always do their thing (making it
  // impossible to trigger a site shortcut using the same keys).
  onKeydown(event: KeyboardEvent): void {
    if (!event.isTrusted) {
      log("log", "WorkerProgram#onKeydown", "ignoring untrusted event", event);
      return;
    }

    const keypress = normalizeKeypress({
      keypress: keyboardEventToKeypress(event),
      keyTranslations: this.keyTranslations,
    });

    const match = this.keyboardShortcuts.find((mapping) => {
      const { shortcut } = mapping;
      return (
        keypress.key === shortcut.key &&
        keypress.alt === shortcut.alt &&
        keypress.cmd === shortcut.cmd &&
        keypress.ctrl === shortcut.ctrl &&
        (keypress.shift === undefined || keypress.shift === shortcut.shift)
      );
    });

    const suppress =
      // If we matched one of our keyboard shortcuts, always suppress.
      match !== undefined ||
      // Just after activating a hint, suppress everything for a short while.
      this.keyboardMode === "PreventOverTyping" ||
      // When capturing keypresses in the Options UI, always suppress.
      this.keyboardMode === "Capture" ||
      // Allow ctrl and cmd system shortcuts in hints mode (but always suppress
      // pressing modifier keys _themselves_ in case the page does unwanted
      // things when holding down alt for example). ctrl and cmd can't safely be
      // combined with hint chars anyway, due to some keyboard shortcuts not
      // being suppressible (such as ctrl+n, ctrl+q, ctrl+t, ctrl+w) (and
      // ctrl+alt+t opens a terminal by default in Ubuntu).
      // This always uses `event.key` since we are looking for _actual_ modifier
      // keypresses (keys may be rebound).
      // Note: On mac, alt/option is used to type special characters, while most
      // (if not all) ctrl shortcuts are up for grabs by extensions, so on mac
      // ctrl is used to activate hints in a new tab instead of alt.
      // In hints mode…
      (this.keyboardMode === "Hints" &&
        // …suppress lone modifier keypresses (as mentioned above)…
        (isModifierKey(event.key) ||
          // …or any other keypress really, with a few exceptions:
          (this.mac
            ? // On mac, allow cmd shortcuts (option is not used for shortcuts
              // but for typing special characters, and ctrl is used to
              // activate hints in new tabs):
              !event.metaKey
            : // On Windows and Linux, allow ctrl and win/super system shortcuts
              // (alt is used to activate hints in new tabs):
              !event.ctrlKey && !event.metaKey)));

    if (suppress) {
      suppressEvent(event);
      // `keypress` events are automatically suppressed when suppressing
      // `keydown`, but `keyup` needs to be manually suppressed. Note that if a
      // keyboard shortcut is alt+j it's possible to either release the alt key
      // first or the J key first, so we have to store _which_ key we want to
      // suppress the `keyup` event for.
      this.suppressNextKeyup = {
        key: event.key,
        code: event.code,
      };
      log("log", "WorkerProgram#onKeydown", "suppressing event", {
        key: event.key,
        code: event.code,
        event,
        match,
        keyboardMode: this.keyboardMode,
        suppressNextKeyup: this.suppressNextKeyup,
      });
    }

    // The "keydown" event fires at an interval while it is pressed. We're only
    // interested in the event where the key was actually pressed down. Ignore
    // the rest. Don't log this since it results in a _lot_ of logs. This is
    // done _after_ suppression – we still want to consistently suppress the key,
    // but don't want it to trigger more actions.
    if (event.repeat) {
      return;
    }

    if (this.keyboardMode === "Capture") {
      if (!isModifierKey(event.key)) {
        this.sendMessage({
          type: "KeypressCaptured",
          keypress,
        });
      }
    } else if (match !== undefined) {
      this.sendMessage({
        type: "KeyboardShortcutMatched",
        action: match.action,
        timestamp: Date.now(),
      });
    } else if (this.keyboardMode === "Hints" && suppress) {
      this.sendMessage({
        type: "NonKeyboardShortcutKeypress",
        keypress,
        timestamp: Date.now(),
      });
    }
  }

  onKeyup(event: KeyboardEvent): void {
    if (!event.isTrusted) {
      log("log", "WorkerProgram#onKeyup", "ignoring untrusted event", event);
      return;
    }

    if (this.suppressNextKeyup !== undefined) {
      const { key, code } = this.suppressNextKeyup;
      if (event.key === key && event.code === code) {
        log("log", "WorkerProgram#onKeyup", "suppressing event", {
          event,
          keyboardMode: this.keyboardMode,
          suppressNextKeyup: this.suppressNextKeyup,
        });
        suppressEvent(event);
        this.suppressNextKeyup = undefined;
      }
    }
  }

  onMutation(records: Array<MutationRecord>): void {
    const { current } = this;
    if (current === undefined) {
      return;
    }

    const newElements = this.getAllNewElements(records);
    updateElementsWithEqualOnes(current, newElements);

    // In addition to the "UpdateElements" polling, update as soon as possible
    // when elements are removed/added/changed for better UX. For example, if a
    // modal closes it looks nicer if the hints for elements in the modal
    // disappear immediately rather than after a small delay.
    // Just after entering hints mode a mutation _always_ happens – inserting
    // the div with the hints. Don’t let that trigger an update.
    if (!(newElements.length === 1 && newElements[0].id === CONTAINER_ID)) {
      this.updateVisibleElements({
        current,
        // Skip updating child frames since we only know that things changed in
        // _this_ frame. Child frames will be updated during the next poll.
        oneTimeWindowMessageToken: undefined,
      });
    }
  }

  onPageHide(event: Event): void {
    if (!event.isTrusted) {
      log("log", "WorkerProgram#onPageHide", "ignoring untrusted event", event);
      return;
    }

    if (window.top === window) {
      // The top page is about to be “die.”
      this.sendMessage({ type: "TopPageHide" });
    }
  }

  onPageShow(event: PageTransitionEvent): void {
    if (!event.isTrusted) {
      log("log", "WorkerProgram#onPageShow", "ignoring untrusted event", event);
      return;
    }

    if (event.persisted) {
      // We have returned to the page via the back/forward buttons.
      this.sendMessage({ type: "PersistedPageShow" });
    }
  }

  getAllNewElements(records: Array<MutationRecord>): Array<HTMLElement> {
    const elements = new Set<HTMLElement>();

    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement && !elements.has(node)) {
          elements.add(node);
          const children = this.elementManager.getAllElements(node);
          for (const child of children) {
            elements.add(child);
          }
        }
      }
    }

    return Array.from(elements);
  }

  getElement(index: number): VisibleElement | undefined {
    return this.current === undefined
      ? undefined
      : this.current.elements[index];
  }

  reportVisibleElements(
    types: ElementTypes,
    viewports: Array<Box>,
    oneTimeWindowMessageToken: string
  ): void {
    const time = new TimeTracker();

    const [elementsWithNulls, timeLeft]: [
      Array<VisibleElement | undefined>,
      number
    ] = this.elementManager.getVisibleElements(types, viewports, time);
    const elements = elementsWithNulls.flatMap((elementData) =>
      elementData === undefined ? [] : elementData
    );

    time.start("frames");
    const frames = this.elementManager.getVisibleFrames(viewports);
    for (const frame of frames) {
      if (frame.contentWindow !== null) {
        const message: FrameMessage = {
          type: "FindElements",
          token: oneTimeWindowMessageToken,
          types,
          viewports: viewports.concat(getFrameViewport(frame)),
        };
        frame.contentWindow.postMessage(message, "*");
      }
    }

    time.start("element reports");
    const elementReports = makeElementReports(elements, {
      maxDuration: timeLeft,
      prefix: "WorkerProgram#reportVisibleElements",
    });

    time.start("send results");
    this.sendMessage({
      type: "ReportVisibleElements",
      elements: elementReports,
      numFrames: frames.length,
      stats: this.elementManager.makeStats(time.export()),
    });

    this.current = {
      elements,
      frames,
      viewports,
      types,
      indexes: [],
      words: [],
      waitId: { tag: "NotWaiting" },
    };
  }

  updateVisibleElements({
    current,
    oneTimeWindowMessageToken,
  }: {
    current: CurrentElements;
    oneTimeWindowMessageToken: string | undefined;
  }): void {
    const [elements, timeLeft]: [Array<VisibleElement | undefined>, number] =
      this.elementManager.getVisibleElements(
        current.types,
        current.viewports,
        new TimeTracker(),
        current.elements.map(({ element }) => element)
      );

    const { words } = current;

    if (oneTimeWindowMessageToken !== undefined) {
      for (const frame of current.frames) {
        // Removing an iframe from the DOM nukes its page (this will be detected
        // by the port disconnecting). Re-inserting it causes the page to be
        // loaded anew.
        if (frame.contentWindow !== null) {
          const message: FrameMessage = {
            type: "UpdateElements",
            token: oneTimeWindowMessageToken,
            viewports: current.viewports.concat(getFrameViewport(frame)),
          };
          frame.contentWindow.postMessage(message, "*");
        }
      }
    }

    const wordsSet = new Set(words);
    const rects =
      words.length === 0
        ? []
        : elements.flatMap((maybeItem, index) => {
            if (maybeItem === undefined || !current.indexes.includes(index)) {
              return [];
            }
            const { element, type } = maybeItem;
            return getTextRectsHelper({
              element,
              type,
              viewports: current.viewports,
              words: wordsSet,
            });
          });

    const elementReports = makeElementReports(elements, {
      maxDuration: timeLeft,
      prefix: "WorkerProgram#updateVisibleElements",
    });

    this.sendMessage({
      type: "ReportUpdatedElements",
      elements: elementReports,
      rects,
    });
  }

  // Let the tutorial page know that Link Hints is installed, so it can toggle
  // some content.
  markTutorial(): void {
    if (
      (window.location.origin + window.location.pathname === META_TUTORIAL ||
        (!PROD && document.querySelector(`.${META_SLUG}Tutorial`) !== null)) &&
      document.documentElement !== null
    ) {
      document.documentElement.classList.add("is-installed");
    }
  }

  clickElement(element: HTMLElement): boolean {
    if (element instanceof HTMLMediaElement) {
      element.focus();
      if (element.paused) {
        fireAndForget(
          element.play(),
          "WorkerProgram#clickElement->play",
          element
        );
      } else {
        element.pause();
      }
      return false;
    }

    const targetElement = getTargetElement(element);

    const rect = targetElement.getBoundingClientRect();
    const options = {
      // Mimic real events as closely as possible.
      bubbles: true,
      cancelable: true,
      composed: true,
      detail: 1,
      view: window,
      // These seem to automatically set `x`, `y`, `pageX` and `pageY` as well.
      // There’s also `screenX` and `screenY`, but we can’t know those.
      clientX: Math.round(rect.left),
      clientY: Math.round(rect.top + rect.height / 2),
    };

    // Just calling `.click()` isn’t enough to open dropdowns in gmail. That
    // requires the full mousedown+mouseup+click event sequence.
    const mousedownEvent = new MouseEvent("mousedown", {
      ...options,
      buttons: 1,
    });
    const mouseupEvent = new MouseEvent("mouseup", options);
    const clickEvent = new MouseEvent("click", options);

    let cleanup = undefined;

    if (BROWSER === "firefox") {
      cleanup = firefoxPopupBlockerWorkaround({
        element,
        isPinned: this.isPinned,
        ourClickEvent: clickEvent,
      });
    }

    // When clicking a link for real the focus happens between the mousedown and
    // the mouseup, but moving this line between those two `.dispatchEvent` calls
    // below causes dropdowns in gmail not to be triggered anymore.
    // Note: The target element is clicked, but the original element is
    // focused. The idea is that the original element is a link or button, and
    // the target element might be a span or div.
    element.focus();

    targetElement.dispatchEvent(mousedownEvent);
    targetElement.dispatchEvent(mouseupEvent);
    let defaultPrevented = !targetElement.dispatchEvent(clickEvent);

    if (BROWSER === "firefox") {
      if (cleanup !== undefined) {
        const result = cleanup();
        if (result.pagePreventedDefault !== undefined) {
          defaultPrevented = result.pagePreventedDefault;
        }
        this.sendMessage({
          type: "OpenNewTabs",
          urls: result.urlsToOpenInNewTabs,
        });
      }
    }

    return defaultPrevented;
  }

  clearCurrent(): void {
    if (this.current !== undefined) {
      const { waitId } = this.current;
      switch (waitId.tag) {
        case "NotWaiting":
          break;

        case "RequestAnimationFrame":
          cancelAnimationFrame(waitId.id);
          break;

        case "RequestIdleCallback":
          cancelIdleCallback(waitId.id);
          break;
      }
      this.current = undefined;
    }
  }
}

function wrapMessage(message: FromWorker): ToBackground {
  return {
    type: "FromWorker",
    message,
  };
}

function getFrameViewport(frame: HTMLFrameElement | HTMLIFrameElement): Box {
  const rect = frame.getBoundingClientRect();
  const computedStyle = window.getComputedStyle(frame);
  const border = {
    left: parseFloat(computedStyle.getPropertyValue("border-left-width")),
    right: parseFloat(computedStyle.getPropertyValue("border-right-width")),
    top: parseFloat(computedStyle.getPropertyValue("border-top-width")),
    bottom: parseFloat(computedStyle.getPropertyValue("border-bottom-width")),
  };
  const padding = {
    left: parseFloat(computedStyle.getPropertyValue("padding-left")),
    right: parseFloat(computedStyle.getPropertyValue("padding-right")),
    top: parseFloat(computedStyle.getPropertyValue("padding-top")),
    bottom: parseFloat(computedStyle.getPropertyValue("padding-bottom")),
  };
  return {
    x: rect.left + border.left + padding.left,
    y: rect.top + border.top + padding.top,
    width:
      rect.width - border.left - border.right - padding.left - padding.right,
    height:
      rect.height - border.top - border.bottom - padding.top - padding.bottom,
  };
}

// Focus any element. Temporarily alter tabindex if needed, and properly
// restore it again when blurring.
function focusElement(element: HTMLElement): void {
  const focusable = isFocusable(element);
  const tabIndexAttr = element.getAttribute("tabindex");

  if (!focusable) {
    element.setAttribute("tabindex", "-1");
  }

  element.focus();

  if (!focusable) {
    let tabIndexChanged = false;

    const stop = (): void => {
      element.removeEventListener("blur", stop, options);
      mutationObserver.disconnect();

      if (!tabIndexChanged) {
        if (tabIndexAttr === null) {
          element.removeAttribute("tabindex");
        } else {
          element.setAttribute("tabindex", tabIndexAttr);
        }
      }
    };

    const options = { capture: true, passive: true };
    element.addEventListener("blur", stop, options);

    const mutationObserver = new MutationObserver((records) => {
      const removed = !element.isConnected;
      tabIndexChanged = records.some((record) => record.type === "attributes");

      if (removed || tabIndexChanged) {
        stop();
      }
    });

    mutationObserver.observe(element, {
      attributes: true,
      attributeFilter: ["tabindex"],
    });

    for (const root of getRootNodes(element)) {
      mutationObserver.observe(root, {
        childList: true,
        subtree: true,
      });
    }
  }
}

function* getRootNodes(fromNode: Node): Generator<Node, void, void> {
  let node = fromNode;
  do {
    const root = node.getRootNode();
    yield root;
    if (root instanceof ShadowRoot) {
      node = root.host;
    } else {
      break;
    }
  } while (true);
}

// When triggering a click on an element, it might actually make more sense to
// trigger the click on one of its children. If `element` contains a single
// child element (and no non-blank text nodes), use that child element instead
// (recursively). Clicking an element _inside_ a link or button still triggers
// the link or button.
// This is because sites with bad markup might have links and buttons with an
// inner element with where the actual click listener is attached. When clicking
// the link or button with a real mouse, you actually click the inner element
// and as such trigger the click listener. The actual link or button has no
// click listener itself, so triggering a click there doesn’t do anything. Using
// this function, we can try to simulate a real mouse click. If a link or button
// has multiple children it is unclear which (if any!) child we should click, so
// then we use the original element.
function getTargetElement(element: HTMLElement): HTMLElement {
  const children = Array.from(element.childNodes).filter(
    (node) => !(node instanceof Text && node.data.trim() === "")
  );
  const onlyChild = children.length === 1 ? children[0] : undefined;
  return onlyChild instanceof HTMLElement
    ? getTargetElement(onlyChild)
    : element;
}

// https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#rules-for-parsing-integers
const TABINDEX = /^\s*([+-]?\d+)\s*$/;

// Returns whether `element.focus()` will do anything or not.
function isFocusable(element: HTMLElement): boolean {
  const propValue = element.tabIndex;

  // `<a>`, `<button>`, etc. are natively focusable (`.tabIndex === 0`).
  // `.tabIndex` can also be set if the HTML contains a valid `tabindex`
  // attribute.
  // `-1` means either that the element isn't focusable, or that
  // `tabindex="-1"` was set, so we have to use `.getAttribute` to
  // disambiguate.
  if (propValue !== -1) {
    return true;
  }

  // Contenteditable elements are always focusable.
  if (element.isContentEditable) {
    return true;
  }

  const attrValue = element.getAttribute("tabindex");

  if (attrValue === null) {
    return false;
  }

  // In Firefox, elements are focusable if they have the tabindex attribute,
  // regardless of whether it is valid or not.
  if (BROWSER === "firefox") {
    return true;
  }

  return TABINDEX.test(attrValue);
}

function isTextInput(element: HTMLElement): boolean {
  return (
    element.isContentEditable ||
    element instanceof HTMLTextAreaElement ||
    // `.selectionStart` is set to a number for all `<input>` types that you can
    // type regular text into (`<input type="text">`, `<input type="search">`,
    // `<input type="unknown">`, etc), but not for `<input type="email">` and
    // `<input type="number">` for some reason.
    (element instanceof HTMLInputElement &&
      (element.selectionStart !== null ||
        element.type === "email" ||
        element.type === "number"))
  );
}

function reverseSelection(selection: Selection): void {
  const direction = getSelectionDirection(selection);

  if (direction === undefined) {
    return;
  }

  const range = selection.getRangeAt(0);
  const [edgeNode, edgeOffset] = direction
    ? [range.startContainer, range.startOffset]
    : [range.endContainer, range.endOffset];

  range.collapse(!direction);
  selection.removeAllRanges();
  selection.addRange(range);
  selection.extend(edgeNode, edgeOffset);
}

// true → forward, false → backward, undefined → unknown
function getSelectionDirection(selection: Selection): boolean | undefined {
  if (selection.isCollapsed) {
    return undefined;
  }

  const { anchorNode, focusNode } = selection;

  if (anchorNode === null || focusNode === null) {
    return undefined;
  }

  const range = document.createRange();
  range.setStart(anchorNode, selection.anchorOffset);
  range.setEnd(focusNode, selection.focusOffset);
  return !range.collapsed;
}

// Select the text of an element (if any – otherwise select the whole element
// (such as an image)), ignoring leading and trailing whitespace.
function selectNodeContents(element: HTMLElement): Range {
  const range = document.createRange();
  let start = undefined;
  let end = undefined;

  for (const textNode of walkTextNodes(element)) {
    if (start === undefined) {
      const index = textNode.data.search(NON_WHITESPACE);
      if (index >= 0) {
        start = { textNode, index };
      }
    }
    if (start !== undefined) {
      const index = textNode.data.search(LAST_NON_WHITESPACE);
      if (index >= 0) {
        end = { textNode, index: index + 1 };
      }
    }
  }

  let method = undefined;
  if (start !== undefined && end !== undefined) {
    method = "text nodes";
    range.setStart(start.textNode, start.index);
    range.setEnd(end.textNode, end.index);
  } else if (element.childNodes.length === 0) {
    method = "selectNode";
    range.selectNode(element);
  } else {
    method = "selectNodeContents";
    range.selectNodeContents(element);
  }
  log("log", "selectNodeContents", { method, start, end, element });

  return range;
}

function getTextWeight(text: string, weight: number): number {
  // The weight used for hints after filtering by text is the number of
  // non-whitespace characters, plus a tiny bit of the regular hint weight in
  // case of ties.
  return Math.max(1, text.replace(/\s/g, "").length + Math.log10(weight));
}

function suppressEvent(event: Event): void {
  event.preventDefault();
  // `event.stopPropagation()` prevents the event from propagating further
  // up and down the DOM tree. `event.stopImmediatePropagation()` also
  // prevents additional listeners on the same node (`window` in this case)
  // from being called.
  event.stopImmediatePropagation();

  // `event.preventDefault()` doesn’t work for `accesskey="x"` in Chrome. See:
  // https://stackoverflow.com/a/34008999/2010616
  // Instead, temporarily remove all accesskeys.
  if (BROWSER === "chrome") {
    const elements = document.querySelectorAll<HTMLElement>("[accesskey]");
    const accesskeyMap = new Map<HTMLElement, string>();
    for (const element of elements) {
      const accesskey = element.getAttribute("accesskey");
      if (accesskey !== null) {
        accesskeyMap.set(element, accesskey);
        element.removeAttribute("accesskey");
      }
    }
    setTimeout(() => {
      for (const [element, accesskey] of accesskeyMap) {
        element.setAttribute("accesskey", accesskey);
      }
    }, 0);
  }
}

function makeElementReports(
  elements: Array<VisibleElement | undefined>,
  { maxDuration, prefix }: { maxDuration: number; prefix: string }
): Array<ElementReport> {
  const startTime = Date.now();

  const elementReports = elements.flatMap((elementData, index) =>
    elementData !== undefined
      ? visibleElementToElementReport(elementData, {
          index,
          textContent: Date.now() - startTime > maxDuration,
        })
      : []
  );

  const skipped = elementReports.filter((report) => report.textContent);
  if (skipped.length > 0) {
    log(
      "warn",
      prefix,
      `Used .textContent for ${skipped.length} element(s) due to timeout`,
      {
        duration: Date.now() - startTime,
        max: maxDuration,
        skipped,
      }
    );
  }

  return elementReports;
}

function visibleElementToElementReport(
  { element, type, measurements, hasClickListener }: VisibleElement,
  { index, textContent }: { index: number; textContent: boolean }
): ElementReport {
  const text = textContent
    ? element.textContent ?? ""
    : extractTextHelper(element, type);
  return {
    type,
    index,
    url:
      type === "link" && element instanceof HTMLAnchorElement
        ? element.href
        : undefined,
    urlWithTarget:
      type === "link" && element instanceof HTMLAnchorElement
        ? getUrlWithTarget(element)
        : undefined,
    text,
    textContent,
    textWeight: getTextWeight(text, measurements.weight),
    isTextInput: isTextInput(element),
    hasClickListener,
    hintMeasurements: measurements,
  };
}

function updateElementsWithEqualOnes(
  current: CurrentElements,
  newElements: Array<HTMLElement>
): void {
  if (newElements.length === 0) {
    return;
  }

  for (const item of current.elements) {
    // If an element with a hint has been removed, try to find a new element
    // that seems to be equal. If only one is found – go for it and use the new
    // one. Some sites, like Gmail and GitHub, replace elements with new,
    // identical ones shortly after things load. That caused hints to disappear
    // for seemingly no reason (one cannot tell with one’s eyes that the hint’s
    // element had _technically_ been removed). This is an attempt to give such
    // hints new elements.
    if (!item.element.isConnected) {
      const equalElements = newElements.filter((element) =>
        item.element.isEqualNode(element)
      );
      if (equalElements.length === 1) {
        item.element = equalElements[0];
      }
    }
  }
}

function extractTextHelper(element: HTMLElement, type: ElementType): string {
  // Scrollable elements do have `.textContent`, but it’s not intuitive to
  // filter them by text (especially since the matching text might be scrolled
  // away). Treat them more like frames (where you can’t look inside).
  if (type === "scrollable") {
    return "";
  }

  // For text inputs, textareas, checkboxes, selects, etc, use their label text
  // for filtering. For buttons with a label, use both the button text and the
  // label text.
  const labels = getLabels(element);
  if (labels !== undefined) {
    return normalizeWhitespace(
      [extractText(element)]
        .concat(Array.from(labels, (label) => extractText(label)))
        .join(" ")
    );
  }

  return normalizeWhitespace(extractText(element));
}

function normalizeWhitespace(string: string): string {
  return string.trim().replace(/\s+/g, " ");
}

export function getTextRectsHelper({
  element,
  type,
  viewports,
  words,
  checkElementAtPoint,
}: {
  element: HTMLElement;
  type: ElementType;
  viewports: Array<Box>;
  words: Set<string>;
  checkElementAtPoint?: boolean;
}): Array<Box> {
  // See `extractTextHelper`.
  if (type === "scrollable") {
    return [];
  }

  // See `extractTextHelper`.
  const labels = getLabels(element);
  if (labels !== undefined) {
    return [element].concat(Array.from(labels)).flatMap((element2) =>
      getTextRects({
        element: element2,
        viewports,
        words,
        checkElementAtPoint,
      })
    );
  }

  return getTextRects({ element, viewports, words, checkElementAtPoint });
}

// Used to decide if two links can get the same hint. If they have the same href
// and target they can. For some targets the frame must be the same as well.
function getUrlWithTarget(link: HTMLAnchorElement): string {
  const target = link.target.toLowerCase();

  const [caseTarget, frameHref] =
    target === "" || target === "_blank" || target === "_top"
      ? [target, ""] // Case insensitive target, not frame specific.
      : target === "_self" || target === "_parent"
      ? [target, window.location.href] // Case insensitive target, frame specific.
      : [link.target, window.location.href]; // Case sensitive target, frame specific.

  // `|` is not a valid URL character, so it is safe to use as a separator.
  return `${encodeURIComponent(caseTarget)}|${frameHref}|${link.href}`;
}

// In Firefox, programmatically clicking on an `<a href="..."
// target="_blank">` (or on a link that goes to another site in a pinned
// tab) causes the popup blocker to block the new tab/window from opening.
// As a workaround, open such links in new tabs manually.
// `target="someName"` can also trigger a new tab/window, but it can also
// re-use `<iframe name="someName">` anywhere in the browsing context (not
// just in the current frame), or re-use a previously opened tab/window with
// "someName". Let’s not bother with those. They’re rare and it’s unclear
// what we should do with them (where should they open?).
// Similarly, `window.open` also triggers the popup blocker. It’s second
// argument is similar to the `target` attribute on links.
// Relevant bugzilla tickets: <bugzil.la/1615860>, <bugzil.la/1356309> and
// <bugzil.la/1348213>.
function firefoxPopupBlockerWorkaround({
  element,
  isPinned,
  ourClickEvent,
}: {
  element: HTMLElement;
  isPinned: boolean;
  ourClickEvent: MouseEvent;
}): () => {
  pagePreventedDefault: boolean | undefined;
  urlsToOpenInNewTabs: Array<string>;
} {
  const prefix = "firefoxPopupBlockerWorkaround";
  const { wrappedJSObject } = window;

  // In the Options page, `window.wrappedJSObject` does not exist.
  if (wrappedJSObject === undefined) {
    log("log", prefix, "No window.wrappedJSObject");
    return () => ({
      pagePreventedDefault: undefined,
      urlsToOpenInNewTabs: [],
    });
  }

  const resets = new Resets();
  let linkUrl: string | undefined = undefined;

  // If the link has `target="_blank"` (or the pinned tab stuff is true), then
  // `event.preventDefault()` must _always_ be called, no matter what. Either
  // the page or ourselves will do it. We have to wait doing it ourselves for as
  // long as possible, though, to be able to detect `return false` from inline
  // listeners.
  let defaultPrevented: "ByPage" | "ByUs" | "NotPrevented" = "NotPrevented";

  // Returns `element` if it is a link, or its first parent that is a link (if
  // any). Clicking on an element inside a link also activates the link.
  const linkElement = element.closest("a");
  const link =
    linkElement instanceof HTMLAnchorElement ? linkElement : undefined;

  const shouldWorkaroundLinks =
    link !== undefined &&
    (link.target.toLowerCase() === "_blank" ||
      (isPinned && link.hostname !== window.location.hostname));

  if (shouldWorkaroundLinks && link !== undefined) {
    // Default to opening this link in a new tab.
    linkUrl = link.href;

    const override = (
      method: "preventDefault" | "stopImmediatePropagation",
      fn: (original: () => void) => () => void
    ): (() => void) => {
      const { prototype } = wrappedJSObject.Event;
      const original = prototype[method];
      exportFunction(fn(original), prototype, {
        defineAs: method,
      });
      return () => {
        prototype[method] = original;
      };
    };

    const onPagePreventDefault = (): void => {
      defaultPrevented = "ByPage";
      // If the page prevents the default action, it does not want the link
      // opened at all, so clear out `linkUrl`.
      linkUrl = undefined;
    };

    // Since Firefox supports `event.cancelBubble = true` and `event.returnValue
    // = false` things become a little complicated. I tried overriding those
    // properties with getters/setters to be able to detect when they are set,
    // but the `get`/`set` callback never seem to have been called. Instead, I
    // came up with another solution.
    //
    // The browser goes through every event target from the top (`window`) down
    // to `element`, and then up again. When visiting an event target, the
    // browser calls all listeners registered on that target and calls them in
    // order. If one of the listeners were to stop propagation, all remaining
    // listeners for the current target will still be executed, but the browser
    // won’t move on to the next targets.
    //
    // So we add a listener to each target, which will be the last listener for
    // the target. This way we can inspect `event.defaultPrevented` to see if
    // any previous listeners prevented the default action, and
    // `event.cancelBubble` to see if any previous listeners stopped
    // propagation.
    for (const target of getAllEventTargetsUpwards(element)) {
      for (const capture of [true, false]) {
        resets.add(
          addEventListener(
            target,
            "click",
            // eslint-disable-next-line @typescript-eslint/no-loop-func
            (event: Event) => {
              if (event !== ourClickEvent) {
                log(
                  "log",
                  prefix,
                  "ignoring click event triggered by page while handling our click event",
                  event,
                  target
                );
                return;
              }

              // We’re already done – just skip remaining listeners.
              if (defaultPrevented !== "NotPrevented") {
                return;
              }

              // The page has prevented the default action via one of the following:
              // - `event.preventDefault()`
              // - `event.returnValue = false`
              // - `return false` in an inline listener
              if (event.defaultPrevented) {
                log("log", prefix, "page preventDefault", event, target);
                onPagePreventDefault();
                return;
              }

              // The page has stopped propagation using one of the following:
              // - `event.stopPropagation()`
              // - `event.cancelBubble = true`
              // We are the last listener to execute, so time to prevent default
              // ourselves.
              // (If the page uses `event.stopImmediatePropagation()` we never
              // end up here – see below.)
              if (event.cancelBubble || (target === window && !capture)) {
                log(
                  "log",
                  prefix,
                  "extension preventDefault because of stopPropagation",
                  event,
                  target
                );
                event.preventDefault();
                defaultPrevented = "ByUs";
                return;
              }

              // If the page never prevents the default action or stops
              // propagation, then the event will eventually bubble up to
              // `window` – the last target that the event visits. Then it’s
              // time to prevent default ourselves, to avoid the popup blocker.
              if (target === window && !capture) {
                log(
                  "log",
                  prefix,
                  "extension preventDefault because of bubbled to window",
                  event,
                  target
                );
                event.preventDefault();
                defaultPrevented = "ByUs";
              }
            },
            "firefoxPopupBlockerWorkaround click listener",
            { capture, passive: false }
          )
        );
      }
    }

    resets.add(
      // The above approach breaks down if `event.stopImmediatePropagation()` is
      // called. That method works just like `event.stopPropagation()`, but also
      // tells the browser not to run any remaining listeners for the current
      // target. This means that our listeners above won’t run. Instead, we have
      // to override the `stopImmediatePropagation` method to detect when it is
      // called.
      override(
        "stopImmediatePropagation",
        (originalStopImmediatePropagation) =>
          function stopImmediatePropagation(this: Event): void {
            if (this !== ourClickEvent) {
              log(
                "log",
                prefix,
                "ignoring stopImmediatePropagation for event triggered by page while handling our click event",
                this
              );
              return;
            }

            // We’re already done – just skip remaining listeners.
            if (defaultPrevented !== "NotPrevented") {
              originalStopImmediatePropagation.call(this);
              return;
            }

            log("log", prefix, "page stopImmediatePropagation");

            // If the page has already prevented the default action itself,
            // things are easy. Not much more to do.
            if (this.defaultPrevented) {
              log("log", prefix, "page preventDefault");
              onPagePreventDefault();
              originalStopImmediatePropagation.call(this);
              return;
            }

            // Otherwise, this is the last chance to prevent default, to make
            // sure that the popup blocker isn’t triggered.
            log(
              "log",
              prefix,
              "extension preventDefault because of stopImmediatePropagation"
            );
            this.preventDefault();
            defaultPrevented = "ByUs";

            // But the page might call `event.preventDefault()` itself just
            // after `event.stopImmediatePropagation()`. Override
            // `preventDefault` so we can detect this, and not open a new tab if
            // so. This won’t catch `event.returnValue = false` or `return
            // false` in an inline listener, but hopefully that’s rare.
            resets.add(
              override(
                "preventDefault",
                (originalPreventDefault) =>
                  function preventDefault(this: Event): void {
                    if (this !== ourClickEvent) {
                      log(
                        "log",
                        prefix,
                        "ignoring preventDefault for event triggered by page while handling our click event",
                        this
                      );
                      return;
                    }
                    log(
                      "log",
                      prefix,
                      "page preventDefault after stopImmediatePropagation",
                      this
                    );
                    onPagePreventDefault();
                    originalPreventDefault.call(this);
                  }
              )
            );

            originalStopImmediatePropagation.call(this);
          }
      )
    );
  }

  const urlsToOpenInNewTabs: Array<string> = [];

  // Temporarily override `window.open`. (If the page has overridden
  // `window.open` to something completely different, this breaks down a little.
  // Hopefully that’s rare.)
  // Note: The thing we triggered a click event on might call `window.open()`.
  // Right, that’s what we’re after. But it could just as well trigger a click
  // event on _another_ button that in turn calls `window.open()`. What should
  // happen then? That’s actually allowed (not blocked)! I think since the
  // `window.open()` happens synchronously within a trusted click, it’s ok.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalOpen = wrappedJSObject.open;
  exportFunction(
    function open(
      this: Window,
      url: unknown,
      target: unknown,
      features: unknown,
      ...args: Array<unknown>
    ): unknown {
      // These may throw exceptions: `{ toString() { throw new Error } }`;
      // If so – let that happen, just like standard `window.open`. If they
      // throw we simply don’t continue.
      // (If using just `String` rather than `window.wrappedJSObject.String`,
      // the errors would not show up in the console.)
      const toString = wrappedJSObject.String;
      const urlString: string = toString(url);
      const targetString = toString(target);
      toString(features);

      if (
        // When clicking something with the mouse, Firefox only allows one
        // `window.open` call – the rest are blocked by the popup blocker. This
        // sounds reasonable – one wouldn’t want a button to open up 100 popups.
        urlsToOpenInNewTabs.length < 1 &&
        // All of these mean opening in a new tab/window.
        (target === undefined ||
          targetString === "" ||
          targetString === "_blank")
      ) {
        const href =
          url === undefined || urlString === ""
            ? "about:blank"
            : new URL(urlString, window.location.href).toString();
        urlsToOpenInNewTabs.push(href);
        log("log", prefix, "window.open", href);
        // Since we don’t have access to the `window` of the to-be-opened tab,
        // lie to the page and say that the window couldn’t be opened.
        return null;
      }

      // @ts-expect-error Intentionally passing on the original, possibly invalid, arguments.
      return originalOpen.call(this, url, target, features, ...args);
    },
    window.wrappedJSObject,
    { defineAs: "open" }
  );

  return () => {
    resets.reset();
    wrappedJSObject.open = originalOpen;

    const result = {
      pagePreventedDefault: shouldWorkaroundLinks
        ? defaultPrevented === "ByPage"
        : undefined,
      urlsToOpenInNewTabs:
        linkUrl !== undefined
          ? [linkUrl, ...urlsToOpenInNewTabs]
          : urlsToOpenInNewTabs,
    };

    log("log", prefix, "result", result);
    return result;
  };
}

function* getAllEventTargetsUpwards(
  fromNode: Node
): Generator<EventTarget, void, void> {
  let node: Node = fromNode;
  do {
    yield node;
    const parent = node.parentNode;
    if (parent instanceof ShadowRoot) {
      yield parent;
      node = parent.host;
    } else {
      // `parent` can be `null` here. That will end the loop. But at the start
      // of the loop we know that `node` is never `null`.
      node = parent as Node;
    }
  } while (node !== null);
  yield window;
}

function isInternalHashLink(element: HTMLAnchorElement): boolean {
  return (
    element.href.includes("#") &&
    stripHash(element.href) === stripHash(window.location.href)
  );
}

function stripHash(url: string): string {
  const index = url.indexOf("#");
  return index === -1 ? url : url.slice(0, index);
}

function flashElement(element: HTMLElement): void {
  const selector = t.FLASH_COPIED_ELEMENT_NO_INVERT_SELECTOR.value;
  const changes = [
    temporarilySetFilter(
      element,
      element.matches(selector) ? "contrast(0.5)" : "invert(0.75)"
    ),
    ...Array.from(element.querySelectorAll<HTMLElement>(selector), (image) =>
      temporarilySetFilter(image, "invert(1)")
    ),
  ];
  for (const { apply } of changes) {
    apply();
  }
  setTimeout(() => {
    for (const { reset } of changes) {
      reset();
    }
  }, t.FLASH_COPIED_ELEMENT_DURATION.value);
}

function temporarilySetFilter(
  element: HTMLElement,
  value: string
): { apply: () => void; reset: () => void } {
  const prop = "filter";
  const originalValue = element.style.getPropertyValue(prop);
  const important = element.style.getPropertyPriority(prop);
  const newValue = `${originalValue} ${value}`.trim();
  return {
    apply: () => {
      element.style.setProperty(prop, newValue, "important");
    },
    reset: () => {
      if (
        element.style.getPropertyValue(prop) === newValue &&
        element.style.getPropertyPriority(prop) === "important"
      ) {
        element.style.setProperty(prop, originalValue, important);
      }
    },
  };
}
