import { Component, createRef, Fragment, h, Ref, VNode } from "preact";
import {
  array,
  boolean,
  chain,
  fieldsAuto,
  multi,
  number,
  optional,
  string,
} from "tiny-decoders";

import {
  CSS,
  MAX_Z_INDEX,
  SUGGESTION_FONT_SIZE,
  SUGGESTION_VIMIUM,
} from "../shared/css";
import {
  isModifierKey,
  keyboardEventToKeypress,
  KeyboardMapping,
  KeyPair,
  Keypress,
  KeyTranslations,
  NormalizedKeypress,
  normalizeKeypress,
} from "../shared/keyboard";
import {
  addEventListener,
  addListener,
  classlist,
  decode,
  deepEqual,
  fireAndForget,
  log,
  LOG_LEVELS,
  LogLevel,
  normalizeUnsignedInt,
  Resets,
} from "../shared/main";
import type {
  FromBackground,
  FromOptions,
  ToBackground,
} from "../shared/messages";
import {
  importOptions,
  normalizeChars,
  OptionsData,
  PartialOptions,
} from "../shared/options";
import type { TabsPerf } from "../shared/perf";
import Attachment from "./Attachment";
import ButtonWithPopup from "./ButtonWithPopup";
import CSSPreview from "./CSSPreview";
import Details from "./Details";
import Field from "./Field";
import ImportSummary from "./ImportSummary";
import KeyboardShortcut, { viewKey } from "./KeyboardShortcut";
import KeyboardShortcuts, {
  describeKeyboardAction,
  getConflictingKeyboardActions,
  getKeyboardActionId,
  isRecognized,
} from "./KeyboardShortcuts";
import Perf from "./Perf";
import TestLinks from "./TestLinks";
import TextInput from "./TextInput";
import Tweakable, {
  getTweakableExport,
  hasChangedTweakable,
  partitionTweakable,
  saveTweakable,
} from "./Tweakable";

type UpdateStatus =
  | "AlreadyFullyUpdated"
  | "AlreadyPartiallyUpdated"
  | "FullyUpdated"
  | "NotUpdated"
  | "PartiallyUpdated";

const CSS_SUGGESTIONS = [
  { name: "Base CSS", value: CSS },
  { name: "Font size", value: SUGGESTION_FONT_SIZE },
  { name: "Vimium", value: SUGGESTION_VIMIUM },
];

const getLayoutMap =
  navigator.keyboard !== undefined
    ? navigator.keyboard.getLayoutMap.bind(navigator.keyboard)
    : undefined;

type Props = {
  ref: Ref<OptionsProgram | null>;
};

type State = {
  options: OptionsData | undefined;
  hasSaved: boolean;
  customChars: string;
  keyTranslationsInput: {
    text: string;
    testOnly: boolean;
    lastKeypress: Keypress | undefined;
  };
  keyboardDetect:
    | Error
    | {
        numReceived: number;
        numFullyUpdated: number;
        numAlreadyFullyUpdated: number;
        numPartiallyUpdated: number;
        numAlreadyPartiallyUpdated: number;
        numNotUpdated: number;
      }
    | undefined;
  capturedKeypressWithTimestamp:
    | {
        timestamp: number;
        keypress: NormalizedKeypress;
      }
    | undefined;
  peek: boolean;
  cssSuggestion: string;
  importData: {
    successCount: number | undefined;
    tweakableCount: number | undefined;
    errors: Array<string>;
  };
  perf: TabsPerf;
  expandedPerfTabIds: Array<string>;
  expandedPerf: boolean;
  expandedDebug: boolean;
  localStorageCleared: Date | undefined;
};

export default class OptionsProgram extends Component<Props, State> {
  resets = new Resets();

  hiddenErrors: Array<string> = [];

  keysTableRef = createRef<HTMLDivElement>();

  hasRestoredPosition = false;

  override state: State = {
    options: undefined,
    hasSaved: false,
    customChars: "",
    keyTranslationsInput: {
      text: "",
      testOnly: false,
      lastKeypress: undefined,
    },
    keyboardDetect: undefined,
    capturedKeypressWithTimestamp: undefined,
    peek: false,
    cssSuggestion: CSS_SUGGESTIONS[0].value,
    importData: {
      successCount: undefined,
      tweakableCount: undefined,
      errors: [],
    },
    perf: {},
    expandedPerfTabIds: [],
    expandedPerf: false,
    expandedDebug: false,
    localStorageCleared: undefined,
  };

  start(): void {
    log("log", "OptionsProgram#start");

    this.resets.add(
      addListener(
        browser.runtime.onMessage,
        this.onMessage.bind(this),
        "OptionsProgram#onMessage"
      )
    );

    if (!PROD) {
      this.resets.add(
        addEventListener(
          window,
          "scroll",
          this.onScroll.bind(this),
          "OptionsProgram#onScroll"
        )
      );
    }

    document.documentElement.classList.add(BROWSER);

    this.sendMessage({ type: "OptionsScriptAdded" });
  }

  stop(): void {
    log("log", "OptionsProgram#stop");
    this.resets.reset();
  }

  override componentDidMount(): void {
    this.start();
  }

  override componentWillUnmount(): void {
    this.stop();
  }

  sendMessage(message: FromOptions): void {
    log("log", "OptionsProgram#sendMessage", message.type, message, this);
    fireAndForget(
      browser.runtime.sendMessage(wrapMessage(message)).then(() => undefined),
      "OptionsProgram#sendMessage",
      message
    );
  }

  onMessage(wrappedMessage: FromBackground): void {
    if (wrappedMessage.type !== "ToOptions") {
      return;
    }

    const { message } = wrappedMessage;

    log("log", "OptionsProgram#onMessage", message.type, message, this);

    switch (message.type) {
      case "StateSync": {
        log.level = message.logLevel;
        // If the options errors (if any) are the same as the ones shown when
        // clicking the X button for the errors, keep them hidden. Otherwise
        // show the new errors.
        const errorsHidden = deepEqual(
          this.hiddenErrors,
          message.options.errors
        );
        this.setState((state) => ({
          options: {
            ...message.options,
            errors: errorsHidden ? [] : message.options.errors,
          },
          customChars:
            state.options === undefined
              ? message.options.values.chars
              : state.customChars,
        }));
        if (!errorsHidden) {
          this.hiddenErrors = [];
        }
        break;
      }

      case "KeypressCaptured":
        this.setState({
          capturedKeypressWithTimestamp: {
            timestamp: Date.now(),
            keypress: message.keypress,
          },
        });
        break;

      case "PerfUpdate":
        this.setState(
          (state) => ({
            perf: {
              ...state.perf,
              ...message.perf,
            },
          }),
          () => {
            fireAndForget(
              this.savePerf(),
              "OptionsProgram#onMessage->savePerf"
            );
          }
        );
        break;
    }
  }

  async savePerf(): Promise<void> {
    if (!PROD) {
      await browser.storage.local.set({ perf: this.state.perf });
      await this.restorePosition();
    }
  }

  saveOptions(partialOptions: PartialOptions): void {
    this.setState((state) => ({
      options:
        state.options === undefined
          ? undefined
          : {
              ...state.options,
              values: {
                ...state.options.values,
                ...partialOptions,
              },
              errors: [],
            },
      hasSaved: true,
    }));
    this.sendMessage({
      type: "SaveOptions",
      partialOptions,
    });
  }

  resetOptions(): void {
    this.setState((state) => ({
      options:
        state.options === undefined
          ? undefined
          : {
              ...state.options,
              values: state.options.defaults,
              errors: [],
            },
      hasSaved: false,
    }));
    this.sendMessage({
      type: "ResetOptions",
    });
  }

  async importOptions(): Promise<void> {
    const { options: optionsData } = this.state;
    if (optionsData === undefined) {
      return;
    }
    const { values: options } = optionsData;
    try {
      const file = await selectFile("application/json");
      const data = await readAsJson(file);
      const [tweakableData, otherData] = partitionTweakable(
        multi({ object: (x) => x })(data)
      );
      const {
        options: newOptions,
        successCount,
        errors,
      } = importOptions(otherData, options);
      this.setState({
        importData: {
          successCount,
          tweakableCount: Object.keys(tweakableData).length,
          errors,
        },
      });
      if (newOptions !== undefined) {
        this.saveOptions(newOptions);
      }
      await saveTweakable(tweakableData);
    } catch (errorAny) {
      const error = errorAny as Error;
      this.setState((state) => ({
        importData: {
          ...state.importData,
          errors: [`The file is invalid: ${error.message}`],
        },
      }));
    }
  }

  exportOptions(): void {
    const { options: optionsData } = this.state;

    const tweakableExport = getTweakableExport();

    const data = {
      ...(optionsData !== undefined ? optionsData.raw : {}),
      ...tweakableExport,
    };

    saveFile(
      `${JSON.stringify(data, undefined, 2)}\n`,
      `${META_SLUG}-options-${toISODateString(new Date())}.json`,
      "application/json"
    );
  }

  async resetLocalStorage(): Promise<void> {
    await browser.storage.local.clear();
    this.setState({ localStorageCleared: new Date() });
  }

  render(): VNode | null {
    const {
      options: optionsData,
      hasSaved,
      customChars,
      keyTranslationsInput,
      keyboardDetect,
      capturedKeypressWithTimestamp,
      peek,
      cssSuggestion,
      importData,
      perf,
      expandedPerfTabIds,
      expandedPerf,
      expandedDebug,
      localStorageCleared,
    } = this.state;

    if (optionsData === undefined) {
      return null;
    }

    const { values: options, defaults, mac } = optionsData;
    const errors = importData.errors.concat(optionsData.errors);

    const usingDefaults =
      deepEqual(defaults, options) && !hasChangedTweakable();

    const charsPresets = [
      { name: "QWERTY (default)", value: defaults.chars },
      { name: "Dvorak", value: "hutenogacpridkmjw" },
      { name: "Colemak", value: "tnseriaoplfuwydhvmck" },
    ];

    const conflictingActions = getConflictingKeyboardActions(
      defaults.hintsKeyboardShortcuts,
      options.hintsKeyboardShortcuts,
      options.chars
    );

    const customIndex = charsPresets.length;

    const rawSelectedIndex = charsPresets.findIndex(
      (preset) => preset.value === options.chars
    );
    const selectedIndex =
      rawSelectedIndex >= 0 ? rawSelectedIndex : customIndex;

    const isLowerCase = options.chars === options.chars.toLowerCase();

    const keyTranslationsChanged = !deepEqual(
      options.keyTranslations,
      defaults.keyTranslations
    );

    const { lastKeypress } = keyTranslationsInput;

    return (
      <div className="Layout">
        <main className="Layout-main Paper">
          <Field
            key="chars"
            id="chars"
            label="Hint characters"
            description={
              <>
                {conflictingActions.length > 0 &&
                  conflictingActions.map(([action, chars]) => (
                    <p key={action} className="Error">
                      Overridden by{" "}
                      <a href={`#${getKeyboardActionId(action)}`}>
                        {describeKeyboardAction(action).name}
                      </a>
                      : {chars.join(", ")}
                    </p>
                  ))}
                <p>
                  Use the characters you find the easiest to type. Put the best
                  ones further to the left. All <em>other</em> characters are
                  used to match elements by their <em>text.</em> Lowercase vs
                  uppercase matters when typing <em>hint characters</em>, but
                  not when <em>filtering by text.</em>
                  {isLowerCase && (
                    <>
                      {" "}
                      <strong>Note:</strong>&nbsp;The&nbsp;hints are{" "}
                      <em>displayed</em> uppercase because it looks nicer. 😎
                    </>
                  )}
                </p>
              </>
            }
            changed={options.chars !== defaults.chars}
            render={({ id }) => (
              <div className="Spaced">
                <TextInput
                  id={id}
                  style={{ flex: "1 1 50%" }}
                  savedValue={options.chars}
                  normalize={(value) => normalizeChars(value, defaults.chars)}
                  save={(value, reason) => {
                    if (reason === "input") {
                      this.setState({ customChars: value });
                    }
                    this.saveOptions({ chars: value });
                  }}
                />

                <div className="Spaced" style={{ flex: "1 1 50%" }}>
                  <Attachment label="Presets" style={{ flex: "1 1 50%" }}>
                    <select
                      style={{ flexGrow: 1 }}
                      value={selectedIndex}
                      onChange={(event) => {
                        const index = Number(event.currentTarget.value);
                        const chars =
                          index >= 0 && index < charsPresets.length
                            ? charsPresets[index].value
                            : customChars;
                        this.saveOptions({ chars });
                      }}
                    >
                      {charsPresets.map(({ name }, index) => (
                        <option key={name} value={index}>
                          {name}
                        </option>
                      ))}
                      {charsPresets.every(
                        (preset) => preset.value !== customChars
                      ) && <option value={customIndex}>Custom</option>}
                    </select>
                  </Attachment>

                  <button
                    type="button"
                    style={{ flex: "1 1 50%", whiteSpace: "nowrap" }}
                    onClick={() => {
                      const chars = isLowerCase
                        ? options.chars.toUpperCase()
                        : options.chars.toLowerCase();
                      const unique = normalizeChars(chars, defaults.chars);
                      this.setState({ customChars: unique });
                      this.saveOptions({ chars: unique });
                    }}
                  >
                    {isLowerCase ? "→ UPPERCASE" : "→ lowercase"}
                  </button>
                </div>
              </div>
            )}
          />

          <Field
            key="autoActivate"
            id="autoActivate"
            label="Auto activate when filtering by text"
            description={
              <p>
                When <em>filtering by text</em> you can press{" "}
                <ActivateHighlightedKey
                  mac={mac}
                  mappings={options.hintsKeyboardShortcuts}
                  defaultMappings={defaults.hintsKeyboardShortcuts}
                />{" "}
                to activate the highlighted hint (green). With this option
                enabled, the highlighted hint is automatically activated if it
                is the only match. Many times one might type a few extra
                characters before realizing that a hint was automatically
                activated, so your key strokes are suppressed for a short period
                just after activation.
              </p>
            }
            changed={options.autoActivate !== defaults.autoActivate}
            changedRight={
              options.overTypingDuration !== defaults.overTypingDuration
            }
            render={({ id }) => (
              <div className="Spaced">
                <span
                  className="ShrinkwrapChildren"
                  style={{ flex: "1 1 50%" }}
                >
                  <label className="Spaced Spaced--center">
                    <input
                      type="checkbox"
                      id={id}
                      checked={options.autoActivate}
                      onChange={(event) => {
                        this.saveOptions({
                          autoActivate: event.currentTarget.checked,
                        });
                      }}
                    />
                    <span>Enabled</span>
                  </label>
                </span>

                <Attachment
                  label={`Over-typing duration${
                    options.overTypingDuration !== defaults.overTypingDuration
                      ? ` (default: ${defaults.overTypingDuration})`
                      : ""
                  }`}
                  style={{ flex: "1 1 50%" }}
                >
                  <div
                    className="Spaced Spaced--center"
                    style={{ flex: "1 1 100%" }}
                  >
                    <TextInput
                      style={{ flex: "1 1 50%" }}
                      disabled={!options.autoActivate}
                      savedValue={options.overTypingDuration.toString()}
                      normalize={(value) =>
                        normalizeUnsignedInt(value, defaults.overTypingDuration)
                      }
                      save={(value) => {
                        this.saveOptions({ overTypingDuration: Number(value) });
                      }}
                    />
                    <span style={{ flex: "1 1 50%" }}>milliseconds</span>
                  </div>
                </Attachment>
              </div>
            )}
          />

          <Field
            key="useKeyTranslations"
            id="useKeyTranslations"
            connected={options.useKeyTranslations}
            label="Keyboard layout"
            span
            description={
              options.useKeyTranslations ? (
                <p>
                  Browser extensions receive two things when you press a key:
                  The actual key according to your layout, as well as a{" "}
                  <em>code</em> which is a name for the <em>physical</em> key
                  you pressed and always stays the same regardless of which
                  layout you have enabled. Switch to your main layout and type
                  in the textarea to translate such <em>codes</em> to actual
                  keys.{" "}
                  {getLayoutMap !== undefined && (
                    <>
                      The “Detect” button below can do some of the translation
                      for you.
                    </>
                  )}
                </p>
              ) : null
            }
            changed={options.useKeyTranslations !== defaults.useKeyTranslations}
            render={({ id }) => (
              <div className="ShrinkwrapChildren">
                <label className="Spaced Spaced--center">
                  <input
                    type="radio"
                    name={id}
                    checked={!options.useKeyTranslations}
                    onChange={() => {
                      this.saveOptions({
                        useKeyTranslations: false,
                      });
                    }}
                  />
                  <span>I use a single keyboard layout</span>
                </label>

                <label
                  className="Spaced Spaced--center"
                  style={{ marginTop: 4 }}
                >
                  <input
                    type="radio"
                    name={id}
                    checked={options.useKeyTranslations}
                    onChange={() => {
                      this.saveOptions({
                        useKeyTranslations: true,
                      });
                    }}
                  />
                  <span>I use multiple keyboard layouts</span>
                </label>
              </div>
            )}
          />

          {options.useKeyTranslations && (
            <Field
              key="keyTranslations"
              id="keyTranslations"
              connected
              label={
                keyTranslationsInput.testOnly
                  ? "Type here to test your translations"
                  : "Type here to translate codes to keys"
              }
              changed={keyTranslationsChanged}
              render={({ id }) => (
                <div className="Spaced">
                  <div className="SpacedVertical" style={{ flex: "1 1 50%" }}>
                    <Attachment
                      style={{ flexGrow: "1" }}
                      contents={
                        <div className="TinyLabel Spaced">
                          <label
                            className="Spaced Spaced--center"
                            style={{ marginLeft: "auto" }}
                          >
                            <span>Test only</span>
                            <input
                              type="checkbox"
                              checked={keyTranslationsInput.testOnly}
                              onChange={(event) => {
                                this.setState({
                                  keyTranslationsInput: {
                                    ...keyTranslationsInput,
                                    testOnly: event.currentTarget.checked,
                                  },
                                });
                              }}
                            />
                          </label>
                        </div>
                      }
                    >
                      <textarea
                        id={id}
                        spellcheck={false}
                        className="TextSmall"
                        style={{ resize: "none" }}
                        placeholder={
                          keyTranslationsInput.testOnly
                            ? "Type with another layout…"
                            : "Type with your main layout…"
                        }
                        value={keyTranslationsInput.text}
                        onInput={(event) => {
                          event.currentTarget.value = keyTranslationsInput.text;
                        }}
                        onBlur={() => {
                          this.setState({
                            keyTranslationsInput: {
                              ...keyTranslationsInput,
                              text: "",
                            },
                          });
                        }}
                        onKeyDown={(event: KeyboardEvent) => {
                          event.preventDefault();
                          const keypress = keyboardEventToKeypress(event);
                          const { code, key, shift } = keypress;
                          if (isModifierKey(key)) {
                            return;
                          }
                          if (!isRecognized(key)) {
                            this.setState({
                              keyTranslationsInput: {
                                ...keyTranslationsInput,
                                lastKeypress: keypress,
                              },
                            });
                            return;
                          }
                          const keyTranslations = keyTranslationsInput.testOnly
                            ? undefined
                            : updateKeyTranslations(
                                { code, key, shift },
                                options.keyTranslations
                              );
                          const normalizedKeypress = normalizeKeypress({
                            keypress,
                            keyTranslations:
                              keyTranslations !== undefined
                                ? keyTranslations
                                : options.keyTranslations,
                          });
                          const finalKey =
                            normalizedKeypress.printableKey !== undefined
                              ? normalizedKeypress.printableKey
                              : normalizedKeypress.key;
                          if (keyTranslations !== undefined) {
                            this.saveOptions({ keyTranslations });
                          }
                          this.setState(
                            {
                              keyTranslationsInput: {
                                ...keyTranslationsInput,
                                text: `${keyTranslationsInput.text} ${finalKey}`.trimLeft(),
                                lastKeypress: keypress,
                              },
                            },
                            () => {
                              if (!keyTranslationsInput.testOnly) {
                                this.scrollKeyIntoView(code);
                              }
                            }
                          );
                        }}
                        onKeyUp={(event: KeyboardEvent) => {
                          const capslock = event.getModifierState("CapsLock");
                          if (
                            lastKeypress !== undefined &&
                            capslock !== lastKeypress.capslock
                          ) {
                            this.setState({
                              keyTranslationsInput: {
                                ...keyTranslationsInput,
                                lastKeypress: {
                                  ...lastKeypress,
                                  capslock,
                                },
                              },
                            });
                          }
                        }}
                      />
                    </Attachment>

                    {lastKeypress !== undefined && (
                      <div>
                        <p className="TinyLabel">Last received keypress data</p>

                        <table className="KeypressTable TextSmall">
                          <tbody>
                            <tr>
                              <th>Code</th>
                              <td>{lastKeypress.code}</td>
                            </tr>
                            <tr>
                              <th>Key</th>
                              <td>
                                {viewKey(lastKeypress.key)}
                                {!isRecognized(lastKeypress.key)
                                  ? " (ignored)"
                                  : null}
                              </td>
                            </tr>
                            <tr>
                              <th>Modifiers</th>
                              <td style={{ paddingTop: 0, paddingBottom: 0 }}>
                                <KeyboardShortcut
                                  mac={mac}
                                  shortcut={{
                                    alt: lastKeypress.alt,
                                    cmd: lastKeypress.cmd,
                                    ctrl: lastKeypress.ctrl,
                                    shift: lastKeypress.shift,
                                  }}
                                />
                              </td>
                            </tr>
                            {lastKeypress.capslock && (
                              <tr>
                                <th>Caps Lock</th>
                                <td>
                                  On{" "}
                                  {!keyTranslationsInput.testOnly && (
                                    <strong>– beware!</strong>
                                  )}
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  <Attachment
                    contents={
                      <div className="Spaced Spaced--end TinyLabel">
                        <span style={{ marginRight: "auto" }}>
                          Key translations
                        </span>

                        {getLayoutMap !== undefined && (
                          <ButtonWithPopup
                            buttonContent="Detect"
                            popupContent={() => (
                              <div style={{ width: 320 }}>
                                {keyboardDetect === undefined ? (
                                  <div className="SpacedVertical">
                                    <p>
                                      Your browser allows detecting{" "}
                                      <em>parts</em> of your <em>current</em>{" "}
                                      keyboard layout.
                                    </p>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        fireAndForget(
                                          this.detectKeyboard(),
                                          "OptionsProgram#render->detectKeyboard"
                                        );
                                      }}
                                    >
                                      Detect keyboard layout
                                    </button>
                                  </div>
                                ) : keyboardDetect instanceof Error ? (
                                  <div className="SpacedVertical Error">
                                    <p>Failed to detect keyboard layout:</p>
                                    <p>{keyboardDetect.message}</p>
                                  </div>
                                ) : (
                                  <div className="SpacedVertical">
                                    <p>
                                      Received keys from the browser:{" "}
                                      {keyboardDetect.numReceived}
                                    </p>
                                    <p>
                                      – Fully updated keys:{" "}
                                      {keyboardDetect.numFullyUpdated}
                                    </p>
                                    <p style={{ marginLeft: "1em" }}>
                                      – Already up-to-date:{" "}
                                      {keyboardDetect.numAlreadyFullyUpdated}
                                    </p>
                                    <p>
                                      – Partially updated keys (shift unknown):{" "}
                                      {keyboardDetect.numPartiallyUpdated}
                                    </p>
                                    <p style={{ marginLeft: "1em" }}>
                                      – Possibly already up-to-date:{" "}
                                      {
                                        keyboardDetect.numAlreadyPartiallyUpdated
                                      }
                                    </p>
                                  </div>
                                )}
                              </div>
                            )}
                            onOpenChange={(open) => {
                              if (!open) {
                                this.setState({
                                  keyboardDetect: undefined,
                                });
                              }
                            }}
                          />
                        )}

                        {keyTranslationsChanged ? (
                          <button
                            type="button"
                            onClick={() => {
                              this.saveOptions({
                                keyTranslations: defaults.keyTranslations,
                              });
                              if (this.keysTableRef.current !== null) {
                                this.keysTableRef.current.scrollTop = 0;
                              }
                            }}
                          >
                            Reset to defaults (en-US QWERTY)
                          </button>
                        ) : (
                          <em>Using defaults (en-US QWERTY)</em>
                        )}
                      </div>
                    }
                    style={{ flex: "1 1 50%" }}
                  >
                    <div
                      className={classlist("KeysTable", "TextSmall", {
                        "is-disabled": keyTranslationsInput.testOnly,
                      })}
                      ref={this.keysTableRef}
                    >
                      <table>
                        <thead>
                          <tr>
                            <th>Code</th>
                            <th>Actual key</th>
                            <th>Shifted</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {Object.keys(options.keyTranslations)
                            .sort()
                            .map((code) => {
                              const [unshifted, shifted] =
                                options.keyTranslations[code];
                              const {
                                [code]: [defaultUnshifted, defaultShifted] = [
                                  undefined,
                                  undefined,
                                ],
                              } = defaults.keyTranslations;
                              const changed =
                                unshifted !== defaultUnshifted ||
                                shifted !== defaultShifted;
                              return (
                                <tr key={code} id={makeKeysRowId(code)}>
                                  <td
                                    className={classlist({
                                      "is-changed": changed,
                                    })}
                                  >
                                    {code}
                                  </td>
                                  <td>{viewKey(unshifted)}</td>
                                  <td>{viewKey(shifted)}</td>
                                  <td>
                                    <button
                                      type="button"
                                      title="Remove this key translation"
                                      className="RemoveButton"
                                      disabled={keyTranslationsInput.testOnly}
                                      onClick={() => {
                                        const {
                                          // eslint-disable-next-line @typescript-eslint/no-unused-vars
                                          [code]: _removed,
                                          ...newKeyTranslations
                                        } = options.keyTranslations;
                                        this.saveOptions({
                                          keyTranslations: newKeyTranslations,
                                        });
                                      }}
                                    >
                                      ×
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                    </div>
                  </Attachment>
                </div>
              )}
            />
          )}

          <KeyboardShortcuts
            key="normal"
            id="normal"
            mode="Normal"
            mac={mac}
            useKeyTranslations={options.useKeyTranslations}
            name="Main keyboard shortcuts"
            description={
              <>
                <p>
                  <strong>Tip:</strong> Hold{" "}
                  <KeyboardShortcut
                    mac={mac}
                    shortcut={{ alt: !mac, ctrl: mac }}
                  />{" "}
                  while activating a hint (typing the last character) to force
                  links to open in a new tab!
                </p>
                <p>
                  For “{describeKeyboardAction("EnterHintsMode_Select").name},”
                  holding{" "}
                  <KeyboardShortcut
                    mac={mac}
                    shortcut={{ alt: !mac, ctrl: mac }}
                  />{" "}
                  instead copies the text or link address of the element.
                </p>
              </>
            }
            chars=""
            mappings={options.normalKeyboardShortcuts}
            defaultMappings={defaults.normalKeyboardShortcuts}
            capturedKeypressWithTimestamp={capturedKeypressWithTimestamp}
            onChange={(newMappings) => {
              this.saveOptions({
                normalKeyboardShortcuts: newMappings,
              });
            }}
            onAddChange={this.onKeyboardShortcutAddChange}
          />

          <KeyboardShortcuts
            key="hints"
            id="hints"
            mode="Hints"
            mac={mac}
            useKeyTranslations={options.useKeyTranslations}
            name="Hints mode keyboard shortcuts"
            chars={options.chars}
            mappings={options.hintsKeyboardShortcuts}
            defaultMappings={defaults.hintsKeyboardShortcuts}
            capturedKeypressWithTimestamp={capturedKeypressWithTimestamp}
            onChange={(newMappings) => {
              this.saveOptions({
                hintsKeyboardShortcuts: newMappings,
              });
            }}
            onAddChange={this.onKeyboardShortcutAddChange}
          />

          <Field
            key="css"
            id="css"
            label="Appearance"
            changed={options.css !== defaults.css}
            render={({ id }) => (
              <div className="SpacedVertical">
                <div className="Spaced">
                  <TextInput
                    textarea
                    className="TextSmall"
                    placeholder="Write or copy and paste CSS overrides here…"
                    style={{ flex: "1 1 50%", height: 310 }}
                    id={id}
                    savedValue={options.css}
                    save={(value) => {
                      this.saveOptions({ css: value });
                    }}
                  />

                  <Attachment
                    contents={
                      <div className="Spaced TinyLabel">
                        <select
                          value={cssSuggestion}
                          onChange={(event) => {
                            this.setState({
                              cssSuggestion: event.currentTarget.value,
                            });
                          }}
                        >
                          {CSS_SUGGESTIONS.map(({ name, value }) => (
                            <option key={name} value={value}>
                              {name}
                            </option>
                          ))}
                        </select>

                        <button
                          type="button"
                          onClick={() => {
                            this.saveOptions({
                              css:
                                options.css.trim() === ""
                                  ? cssSuggestion
                                  : `${options.css.replace(
                                      /\n\s*$/,
                                      ""
                                    )}\n\n${cssSuggestion}`,
                            });
                          }}
                        >
                          Copy over
                        </button>
                      </div>
                    }
                    style={{ flex: "1 1 50%" }}
                  >
                    <TextInput
                      textarea
                      className="TextSmall"
                      savedValue={cssSuggestion}
                    />
                  </Attachment>
                </div>

                <p className="TextSmall">
                  To the left, you can add or copy and paste CSS overrides to
                  change the look of things. To the right, you’ll find the base
                  CSS for reference, as well as some inspiration through the
                  dropdown.
                </p>

                <div>
                  <div className="TinyLabel Spaced">
                    <p>Preview</p>

                    <label
                      className="Spaced Spaced--center"
                      style={{ marginLeft: "auto" }}
                    >
                      <span>Peek</span>
                      <input
                        type="checkbox"
                        checked={peek}
                        onChange={(event) => {
                          this.setState({ peek: event.currentTarget.checked });
                        }}
                      />
                    </label>
                  </div>

                  <CSSPreview
                    chars={options.chars}
                    css={options.css}
                    peek={peek}
                  />
                </div>
              </div>
            )}
          />

          <div className="SpacedVertical SpacedVertical--large">
            <Details
              summary="Performance"
              open={expandedPerf}
              onChange={(newOpen) => {
                this.setState({ expandedPerf: newOpen }, () => {
                  this.savePosition();
                });
              }}
            >
              <Perf
                perf={perf}
                expandedPerfTabIds={expandedPerfTabIds}
                onExpandChange={(newExpandedPerfTabIds) => {
                  this.setState(
                    { expandedPerfTabIds: newExpandedPerfTabIds },
                    () => {
                      this.savePosition();
                    }
                  );
                }}
                onReset={() => {
                  this.sendMessage({ type: "ResetPerf" });
                  this.setState({ perf: {} });
                }}
              />
            </Details>

            <Details
              summary="Debug"
              open={expandedDebug}
              onChange={(newOpen) => {
                this.setState({ expandedDebug: newOpen }, () => {
                  this.savePosition();
                });
              }}
            >
              <div className="Intro">
                <p>
                  <strong>Change only if you know what you’re doing!</strong>
                </p>
                <p>
                  Changing some of these options might require refreshing tabs
                  or restarting the browser to take effect.
                </p>
              </div>

              <Tweakable
                onUpdate={() => {
                  this.forceUpdate();
                }}
                before={
                  <>
                    <div />

                    <Field
                      id="clearLocal"
                      label="Local storage"
                      changed={false}
                      render={() => (
                        <div className="Spaced Spaced--center">
                          <button
                            type="button"
                            onClick={() => {
                              fireAndForget(
                                this.resetLocalStorage(),
                                "OptionsProgram#render->resetLocalStorage"
                              );
                            }}
                          >
                            Clear
                          </button>
                          {localStorageCleared !== undefined && (
                            <p>
                              Last cleared:{" "}
                              {localStorageCleared.toLocaleString()}
                            </p>
                          )}
                        </div>
                      )}
                      onReset={() => {
                        this.saveOptions({ logLevel: defaults.logLevel });
                      }}
                    />

                    <Field
                      id="logLevel"
                      label="Log level"
                      changed={options.logLevel !== defaults.logLevel}
                      render={({ id }) => (
                        <select
                          id={id}
                          value={options.logLevel}
                          style={{ width: "50%" }}
                          onChange={(event) => {
                            const { value } = event.currentTarget;
                            try {
                              const logLevel = decode(LogLevel, value);
                              this.saveOptions({ logLevel });
                            } catch (error) {
                              log(
                                "error",
                                "OptionsProgram#render",
                                "Failed to decode logLevel.",
                                error
                              );
                            }
                          }}
                        >
                          {Object.keys(LOG_LEVELS).map((level) => (
                            <option key={level} value={level}>
                              {level.slice(0, 1).toUpperCase() + level.slice(1)}
                            </option>
                          ))}
                        </select>
                      )}
                      onReset={() => {
                        this.saveOptions({ logLevel: defaults.logLevel });
                      }}
                    />
                  </>
                }
              />
            </Details>
          </div>

          <div
            id="errors"
            className={classlist({ ErrorsSpacing: !expandedDebug })}
          />
          {errors.length > 0 && (
            <div className="ErrorsHeading" style={{ zIndex: MAX_Z_INDEX }}>
              <a href="#errors" className="ErrorsHeading-link">
                {importData.errors.length > 0
                  ? "Errors were encountered while importing your options."
                  : hasSaved
                  ? "Errors were encountered while saving your options."
                  : "Errors were encountered while reading your saved options."}
              </a>
              <button
                type="button"
                title="Hide errors"
                className="ErrorsHeading-removeButton RemoveButton"
                onClick={() => {
                  this.setState({
                    options: {
                      ...optionsData,
                      errors: [],
                    },
                    importData: {
                      ...importData,
                      errors: [],
                    },
                  });
                  this.hiddenErrors = optionsData.errors;
                }}
              >
                ×
              </button>
            </div>
          )}
          {errors.length > 0 && (
            <pre className="Errors SpacedVertical TextSmall">
              {errors.join("\n\n")}
            </pre>
          )}
        </main>

        <aside className="Layout-sidebar">
          <div className="Paper">
            <div className="Branding">
              <img
                src={browser.runtime.getURL(META_ICON)}
                alt=""
                className="Branding-image"
              />
              <div>
                <p className="Branding-name">
                  {META_NAME} {META_VERSION}
                </p>
                <p className="TextSmall">
                  <a
                    href={META_HOMEPAGE}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Homepage
                  </a>
                </p>
              </div>
            </div>
          </div>

          <div className="Paper">
            <Field
              id="allOptions"
              label="All options"
              span
              changed={false}
              render={() => (
                <div className="SpacedVertical" style={{ maxWidth: 320 }}>
                  <div className="Spaced">
                    <button
                      type="button"
                      style={{ flex: "1 1 50%" }}
                      disabled={usingDefaults}
                      onClick={() => {
                        this.exportOptions();
                      }}
                    >
                      Export
                    </button>
                    <div className="SpacedVertical" style={{ flex: "1 1 50%" }}>
                      <ButtonWithPopup
                        open={importData.successCount !== undefined}
                        buttonContent="Import"
                        popupContent={() => (
                          <div style={{ whiteSpace: "nowrap" }}>
                            <ImportSummary
                              success={importData.successCount ?? 0}
                              tweakable={importData.tweakableCount ?? 0}
                              errors={importData.errors.length}
                            />
                          </div>
                        )}
                        onOpenChange={(open) => {
                          if (open) {
                            fireAndForget(
                              this.importOptions(),
                              "OptionsProgram#render->importOptions"
                            );
                          } else {
                            this.setState({
                              importData: {
                                ...importData,
                                successCount: undefined,
                              },
                            });
                          }
                        }}
                      />
                    </div>
                  </div>
                  <ButtonWithPopup
                    disabled={usingDefaults}
                    buttonContent="Reset to defaults"
                    popupContent={({ close }) => (
                      <div className="SpacedVertical">
                        <p>
                          <strong>
                            This will reset all options to their defaults.
                          </strong>
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            this.resetOptions();
                            close();
                          }}
                        >
                          Yes, reset all options
                        </button>
                      </div>
                    )}
                  />
                </div>
              )}
            />
          </div>

          <div className="Paper">
            <Field
              id="testLinks"
              label="Test links"
              span
              changed={false}
              render={() => <TestLinks />}
            />
          </div>
        </aside>
      </div>
    );
  }

  onKeyboardShortcutAddChange = (isAdding: boolean): void => {
    this.setState({ capturedKeypressWithTimestamp: undefined });
    this.sendMessage({
      type: "ToggleKeyboardCapture",
      capture: isAdding,
    });
  };

  scrollKeyIntoView(code: string): void {
    const id = makeKeysRowId(code);
    const element = document.getElementById(id);
    const keysTable = this.keysTableRef.current;

    if (keysTable === null || element === null) {
      return;
    }

    element.classList.remove("is-animated");

    const elementRect = element.getBoundingClientRect();
    const keysTableRect = keysTable.getBoundingClientRect();
    const headingsHeight = Math.max(
      0,
      ...Array.from(
        keysTable.querySelectorAll<HTMLElement>("thead th"),
        (th) => th.offsetHeight
      )
    );

    const diffTop = elementRect.top - keysTableRect.top - headingsHeight;
    const diffBottom = elementRect.bottom - keysTableRect.bottom;

    if (diffTop < 0) {
      keysTable.scrollTop += diffTop;
    } else if (diffBottom > 0) {
      keysTable.scrollTop += diffBottom;
    }

    element.classList.add("is-animated");
    // Remove the animation when finished to avoid it running again when
    // toggling the radio buttons back and forth.
    element.addEventListener(
      "animationend",
      () => {
        element.classList.remove("is-animated");
      },
      { once: true }
    );
  }

  onScroll(): void {
    if (!PROD) {
      if (this.hasRestoredPosition) {
        fireAndForget(
          browser.storage.local.set({ scrollY: window.scrollY }),
          "OptionsProgram#onScroll->storage.local.set"
        );
      }
    }
  }

  savePosition(): void {
    if (!PROD) {
      const { expandedPerfTabIds, expandedPerf, expandedDebug } = this.state;
      fireAndForget(
        browser.storage.local.set({
          expandedPerfTabIds,
          expandedPerf,
          expandedDebug,
        }),
        "OptionsProgram#savePosition->storage.local.set"
      );
    }
  }

  async restorePosition(): Promise<void> {
    if (!PROD) {
      if (this.hasRestoredPosition) {
        return;
      }
      this.hasRestoredPosition = true;
      const recordProps = {
        expandedPerfTabIds: optional(
          chain(array(string), (ids) =>
            ids.filter((id) =>
              Object.prototype.hasOwnProperty.call(this.state.perf, id)
            )
          ),
          []
        ),
        expandedPerf: optional(boolean, false),
        expandedDebug: optional(boolean, false),
        scrollY: optional(number, 0),
      };
      const data = await browser.storage.local.get(Object.keys(recordProps));
      const { scrollY, expandedPerfTabIds, ...state } = decode(
        fieldsAuto(recordProps),
        data
      );
      this.setState({ ...state, expandedPerfTabIds }, () => {
        window.scrollTo(0, scrollY);
      });
    }
  }

  async detectKeyboard(): Promise<void> {
    try {
      if (getLayoutMap === undefined) {
        throw new Error(
          "Your browser does not support detecting your keyboard layout after all."
        );
      }

      const layoutMap = await getLayoutMap();

      const { options: optionsData } = this.state;
      if (optionsData === undefined) {
        throw new Error("Failed to save key translations.");
      }

      const { keyTranslations } = optionsData.values;

      const codes = Object.keys(keyTranslations);
      const newCodes = Array.from(layoutMap.keys()).filter(
        (code) => !codes.includes(code)
      );

      const results: Array<[UpdateStatus, string, KeyPair]> = codes
        .map((code): [UpdateStatus, string, KeyPair] => {
          const pair = keyTranslations[code];
          const key = layoutMap.get(code);
          if (key === undefined) {
            return ["NotUpdated", code, pair];
          }
          if (isShiftable(key)) {
            const newPair: KeyPair = [key, key.toUpperCase()];
            return deepEqual(pair, newPair)
              ? ["AlreadyFullyUpdated", code, pair]
              : ["FullyUpdated", code, newPair];
          }
          return key === pair[0]
            ? ["AlreadyPartiallyUpdated", code, pair]
            : ["PartiallyUpdated", code, [key, "?"]];
        })
        .concat(
          newCodes.flatMap((code): Array<[UpdateStatus, string, KeyPair]> => {
            const key = layoutMap.get(code);
            return key === undefined
              ? []
              : isShiftable(key)
              ? [["FullyUpdated", code, [key, key.toUpperCase()]]]
              : [["PartiallyUpdated", code, [key, "?"]]];
          })
        );

      function count(updateStatus: UpdateStatus): number {
        return results.filter(
          ([updateStatus2]) => updateStatus2 === updateStatus
        ).length;
      }

      const newKeyTranslations = Object.fromEntries(
        results.map(([, code, pair]) => [code, pair])
      );

      this.saveOptions({ keyTranslations: newKeyTranslations });
      this.setState({
        keyboardDetect: {
          numReceived: layoutMap.size,
          numFullyUpdated: count("FullyUpdated"),
          numAlreadyFullyUpdated: count("AlreadyFullyUpdated"),
          numPartiallyUpdated: count("PartiallyUpdated"),
          numAlreadyPartiallyUpdated: count("AlreadyPartiallyUpdated"),
          numNotUpdated: count("NotUpdated"),
        },
      });
    } catch (errorAny) {
      const error = errorAny as Error;
      this.setState({ keyboardDetect: error });
    }
  }
}

function wrapMessage(message: FromOptions): ToBackground {
  return {
    type: "FromOptions",
    message,
  };
}

function updateKeyTranslations(
  { code, key, shift }: { code: string; key: string; shift: boolean },
  keyTranslations: KeyTranslations
): KeyTranslations | undefined {
  const previousPair = Object.prototype.hasOwnProperty.call(
    keyTranslations,
    code
  )
    ? keyTranslations[code]
    : undefined;

  const newPair = updatePair({ key, shift }, previousPair);
  const changed =
    previousPair === undefined || !deepEqual(newPair, previousPair);
  return changed ? { ...keyTranslations, [code]: newPair } : undefined;
}

function updatePair(
  { key, shift }: { key: string; shift: boolean },
  previousPair: KeyPair | undefined
): KeyPair {
  if (!shift && key.length === 1 && key.toLowerCase() !== key.toUpperCase()) {
    return [key, key.toUpperCase()];
  }
  if (previousPair !== undefined) {
    const [unshifted, shifted] = previousPair;
    return shift ? [unshifted, key] : [key, shifted];
  }
  return [key, key];
}

function isShiftable(key: string): boolean {
  return key.length === 1 && key !== key.toUpperCase();
}

function makeKeysRowId(code: string): string {
  return `KeysTable-row-${code}`;
}

function ActivateHighlightedKey({
  mac,
  mappings,
  defaultMappings,
}: {
  mac: boolean;
  mappings: Array<KeyboardMapping>;
  defaultMappings: Array<KeyboardMapping>;
}): VNode {
  const first = mappings.find((mapping) => mapping.action === "ActivateHint");

  if (first !== undefined) {
    return <KeyboardShortcut mac={mac} shortcut={first.shortcut} />;
  }

  const firstDefault = defaultMappings.find(
    (mapping) => mapping.action === "ActivateHint"
  );

  const fallback =
    firstDefault !== undefined ? firstDefault.shortcut : { key: "error" };

  return (
    <span>
      <KeyboardShortcut mac={mac} shortcut={fallback} /> (note: you’ve disabled
      that shortcut)
    </span>
  );
}

function saveFile(
  content: string,
  fileName: string,
  contentType: string
): void {
  const a = document.createElement("a");
  const file = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(file);
  a.href = url;
  a.download = fileName;
  a.dispatchEvent(new MouseEvent("click"));
  URL.revokeObjectURL(url);
}

async function selectFile(accept: string): Promise<File> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      input.onchange = null;
      if (input.files !== null) {
        resolve(input.files[0]);
      }
    };
    input.dispatchEvent(new MouseEvent("click"));
  });
}

async function readAsJson(file: File): Promise<unknown> {
  return new Response(file).json();
}

function toISODateString(date: Date): string {
  const pad = (num: number): string => num.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}`;
}
