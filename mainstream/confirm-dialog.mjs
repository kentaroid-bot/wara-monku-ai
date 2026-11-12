let nextId = 0;

// A missing dialog implementation must never silently authorize a payment.
export function confirmDialog({ title, message, confirmLabel = "確定する" }, doc = globalThis.document) {
  if (!doc?.createElement || !doc.body) return Promise.resolve(false);
  const dialog = doc.createElement("dialog");
  if (typeof dialog.showModal !== "function") return Promise.resolve(false);
  const id = "wara-confirm-" + ++nextId;
  dialog.className = "confirm-dialog";
  dialog.setAttribute("aria-labelledby", id + "-title");
  dialog.setAttribute("aria-describedby", id + "-message");
  const heading = doc.createElement("h2"), body = doc.createElement("p"), actions = doc.createElement("div");
  heading.id = id + "-title";
  heading.textContent = title;
  body.id = id + "-message";
  body.className = "confirm-message";
  body.textContent = message;
  actions.className = "confirm-actions";
  const cancel = doc.createElement("button"), accept = doc.createElement("button");
  cancel.type = accept.type = "button";
  cancel.className = "secondary";
  cancel.textContent = "キャンセル";
  cancel.autofocus = true;
  accept.textContent = confirmLabel;
  actions.append(cancel, accept);
  dialog.append(heading, body, actions);
  const previousFocus = doc.activeElement;
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      doc.defaultView?.removeEventListener("pagehide", dismiss);
      if (dialog.open) dialog.close();
      dialog.remove();
      if (previousFocus?.isConnected) previousFocus.focus?.();
      resolve(value);
    };
    const dismiss = () => finish(false);
    const Observer = doc.defaultView?.MutationObserver;
    const observer = Observer ? new Observer(() => {
      if (!dialog.isConnected) dismiss();
    }) : null;
    cancel.addEventListener("click", dismiss);
    accept.addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
    dialog.addEventListener("close", dismiss);
    dialog.addEventListener("click", event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom) dismiss();
    });
    doc.defaultView?.addEventListener("pagehide", dismiss);
    doc.body.append(dialog);
    observer?.observe(doc.body, { childList: true, subtree: true });
    try { dialog.showModal(); cancel.focus(); }
    catch { dismiss(); }
  });
}
