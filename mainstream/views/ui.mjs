export const amount = (s) => {
  if (!/^[1-9][0-9]{0,14}$/.test(s))
    throw Error("1以上の整数で入力してください。");
  return BigInt(s);
};
export const receipt = (sig) =>
  "https://explorer.solana.com/tx/" +
  encodeURIComponent(sig) +
  "?cluster=devnet";
export const short = (s) => s.slice(0, 5) + "…" + s.slice(-5);

export function viewHelpers(content, action, h) {
  const form = (id, fn) => action(content.querySelector("#" + id), fn);
  const btn = (text) => "<button>" + text + "</button>";
  const inp = (name, label, attrs = "") =>
    "<label>" +
    label +
    '<input name="' +
    name +
    '" ' +
    attrs +
    " required></label>";
  const sel = (name, label, list) =>
    "<label>" +
    label +
    '<select required name="' +
    name +
    '">' +
    list +
    "</select></label>";
  const opt = (id, text) =>
    '<option value="' + h(id) + '">' + h(text) + "</option>";
  const link = (path, text) =>
    '<a class="action" href="' + h(path) + '">' + h(text) + "</a>";
  const gid = (id) => "/communities/?id=" + encodeURIComponent(id);
  const register = (g, shop) =>
    "/shop/?" + new URLSearchParams({ group: g, store: shop });
  return { form, btn, inp, sel, opt, link, gid, register };
}
