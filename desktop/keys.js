// Turns the global keyboard/mouse hook's numbers into the same names the
// radio page uses in the browser (KeyB, Digit1, F5, ShiftLeft...), so a
// key set in one works in the other.
"use strict";

let names = null;
function hookNames() {
  if (names) return names;
  names = {};
  try {
    const { UiohookKey } = require("uiohook-napi");
    for (const [name, code] of Object.entries(UiohookKey)) if (!(code in names)) names[code] = name;
  } catch {}
  return names;
}

const SAME = new Set(["Backspace", "Tab", "Enter", "CapsLock", "Escape", "Space", "PageUp", "PageDown", "End", "Home",
  "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Insert", "Delete", "NumpadMultiply", "NumpadAdd", "NumpadSubtract",
  "NumpadDecimal", "NumpadDivide", "NumpadEnter", "Semicolon", "Equal", "Comma", "Minus", "Period", "Slash", "Backquote",
  "BracketLeft", "Backslash", "BracketRight", "Quote", "AltRight", "ShiftRight", "MetaRight", "NumLock", "ScrollLock", "PrintScreen"]);
const RENAME = { Ctrl: "ControlLeft", CtrlRight: "ControlRight", Alt: "AltLeft", Shift: "ShiftLeft", Meta: "MetaLeft" };

function nameToCode(name) {
  if (!name) return null;
  if (/^[A-Z]$/.test(name)) return "Key" + name;
  if (/^[0-9]$/.test(name)) return "Digit" + name;
  if (/^F\d{1,2}$/.test(name) || /^Numpad\d$/.test(name)) return name;
  if (RENAME[name]) return RENAME[name];
  if (SAME.has(name)) return name;
  return null;
}

function keyFromHook(keycode, table) {
  const n = (table || hookNames())[keycode];
  return nameToCode(n) || "Hook" + keycode;
}

// Hook buttons: 1 left, 2 right, 3 middle, 4 back (Mouse 4), 5 forward (Mouse 5).
// Browser buttons: 0 left, 1 middle, 2 right, 3 back, 4 forward.
const BUTTONS = { 1: 0, 2: 2, 3: 1, 4: 3, 5: 4 };
function buttonFromHook(b) { return b in BUTTONS ? BUTTONS[b] : (b > 5 ? b - 1 : null); }

module.exports = { keyFromHook, buttonFromHook, nameToCode };
