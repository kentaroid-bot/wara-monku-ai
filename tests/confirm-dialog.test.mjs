import test from "node:test";
import assert from "node:assert/strict";
import { confirmDialog } from "../mainstream/confirm-dialog.mjs";

function documentFixture() {
  const doc = { defaultView: new EventTarget() };
  class Element extends EventTarget {
    constructor(tag) { super(); this.tagName = tag; this.children = []; this.attrs = {}; }
    get isConnected() { return this === doc.body || Boolean(this.parent?.isConnected); }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
    setAttribute(name, value) { this.attrs[name] = value; }
    focus() { doc.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatchEvent(new Event("close")); }
    getBoundingClientRect() { return { left: 10, top: 10, right: 110, bottom: 110 }; }
  }
  doc.createElement = tag => new Element(tag);
  doc.body = doc.createElement("body");
  const previous = doc.createElement("button"); doc.body.append(previous); previous.focus();
  return { doc, previous };
}
function open() {
  const { doc, previous } = documentFixture();
  const result = confirmDialog({ title: "お支払い", message: "<b>店名</b>\n2 INA", confirmLabel: "支払う" }, doc);
  const dialog = doc.body.children.at(-1);
  const [cancel, accept] = dialog.children[2].children;
  return { doc, previous, result, dialog, cancel, accept };
}

test("dialog shows plain multiline text, focuses cancel, accepts once and restores focus", async () => {
  const { doc, previous, result, dialog, cancel, accept } = open();
  assert.equal(dialog.children[1].textContent, "<b>店名</b>\n2 INA");
  assert.equal(dialog.attrs["aria-labelledby"], dialog.children[0].id);
  assert.equal(dialog.attrs["aria-describedby"], dialog.children[1].id);
  assert.equal(doc.activeElement, cancel);
  accept.dispatchEvent(new Event("click"));
  cancel.dispatchEvent(new Event("click"));
  assert.equal(await result, true);
  assert.equal(dialog.isConnected, false);
  assert.equal(doc.activeElement, previous);
});
for (const kind of ["button", "escape", "backdrop", "close", "navigation"]) test(`dialog cancels on ${kind}`, async () => {
  const { doc, result, dialog, cancel } = open();
  if (kind === "button") cancel.dispatchEvent(new Event("click"));
  if (kind === "escape") {
    const event = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  }
  if (kind === "backdrop") dialog.dispatchEvent(Object.assign(new Event("click"), { clientX: 0, clientY: 0 }));
  if (kind === "close") dialog.close();
  if (kind === "navigation") doc.defaultView.dispatchEvent(new Event("pagehide"));
  assert.equal(await result, false);
  assert.equal(dialog.isConnected, false);
});
test("clicking the dialog padding does not dismiss it", async () => {
  const { result, dialog, accept } = open();
  dialog.dispatchEvent(Object.assign(new Event("click"), { clientX: 20, clientY: 20 }));
  assert.equal(dialog.open, true);
  accept.dispatchEvent(new Event("click"));
  assert.equal(await result, true);
});
test("absent DOM or unsupported showModal safely cancels", async () => {
  assert.equal(await confirmDialog({}, null), false);
  const { doc } = documentFixture();
  doc.createElement = () => ({});
  assert.equal(await confirmDialog({}, doc), false);
});
test("a showModal failure removes the dialog and resolves false", async () => {
  const { doc } = documentFixture(), create = doc.createElement;
  doc.createElement = tag => {
    const el = create(tag);
    if (tag === "dialog") el.showModal = () => { throw Error("unsupported"); };
    return el;
  };
  assert.equal(await confirmDialog({}, doc), false);
  assert.equal(doc.body.children.length, 1);
});
