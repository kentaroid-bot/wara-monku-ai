export const shopIcons = ["🏪", "☕", "🍙", "🥐", "🛠️", "🌾", "🎨", "🌷", "📚", "🍴"];

export function shopFields(input) {
  const title = input.title?.trim(), caption = input.caption?.trim();
  if (!title || typeof caption !== "string" || [...title].length > 40 || [...caption].length > 140 ||
      /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(title + caption) ||
      !shopIcons.includes(input.icon) || typeof input.is_test !== "boolean")
    throw Error("店舗名（40文字以内）、一言紹介（140文字以内）、アイコンを確認してください。");
  return {title, caption, icon:input.icon, is_test:input.is_test};
}
