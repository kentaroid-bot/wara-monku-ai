// Keep form controls in their original form when presenting them in a dialog.
export function dialogPanel(parent, title, nodes) {
  const dialog = document.createElement("dialog");
  dialog.className = "paper-card ehon-dialog";
  dialog.setAttribute("aria-label", title);
  const heading = document.createElement("h2"); heading.textContent = title;
  const close = document.createElement("button");
  close.type = "button"; close.className = "secondary"; close.textContent = "閉じる";
  close.onclick = () => dialog.close();
  dialog.append(heading, ...nodes, close); parent.append(dialog);
  return dialog;
}
