import { soundKey } from "./storage-keys.mjs";

const tiers = [
  ["🌱", "タップして iine をためよう"], ["👍", "いいな！"], ["👍", "いいな！"],
  ["✨", "すてき！"], ["✨", "すてき！"], ["💖", "ありがとう！"],
  ["🎉", "最高！"], ["🔥", "熱い感謝！"], ["🌟", "きらめき！"],
  ["👑", "大尊敬！"], ["🌾", "黄金の満点！"],
];
export function clampCount(value, remaining = 10) {
  return Math.max(0, Math.min(10, Math.floor(Number(remaining)) || 0, Math.floor(Number(value)) || 0));
}
export function getTier(count) {
  const [emoji, label] = tiers[clampCount(count)];
  return { emoji, label };
}

// Optional browser capabilities must never prevent a gift or create an unhandled rejection.
export function createIineSound(env = globalThis) {
  let context, enabled = true;
  try { enabled = env.localStorage?.getItem(soundKey) !== "off"; } catch {}
  function unlock() {
    if (!enabled) return;
    try {
      const Audio = env.AudioContext || env.webkitAudioContext;
      if (!Audio) return;
      context ||= new Audio();
      if (context.state === "suspended") context.resume()?.catch?.(() => {});
    } catch { context = undefined; }
  }
  function play(kind, count = 1, evolved = false) {
    if (!enabled) return;
    unlock();
    if (!context) return;
    try {
      const scale = [523.25, 587.33, 659.25, 698.46, 783.99, 880, 987.77, 1046.5, 1174.66, 1318.51];
      const base = scale[Math.max(0, clampCount(count) - 1)];
      const notes = kind === "success" ? [523.25, 659.25, 783.99, 1046.5] :
        kind === "bump" ? [130.81, 98] : kind === "reset" ? [392, 261.63] :
        evolved ? [base, base * 1.25, base * 1.5] : [base];
      notes.forEach((frequency, i) => {
        const oscillator = context.createOscillator(), gain = context.createGain();
        const time = context.currentTime + i * (kind === "success" ? .1 : .035);
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, time);
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(.045, time + .01);
        gain.gain.exponentialRampToValueAtTime(.001, time + .19);
        oscillator.connect(gain); gain.connect(context.destination);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        oscillator.start(time); oscillator.stop(time + .2);
      });
    } catch {}
  }
  return { play, unlock, get enabled() { return enabled; }, toggle() {
    enabled = !enabled;
    try { env.localStorage?.setItem(soundKey, enabled ? "on" : "off"); } catch {}
    return enabled;
  } };
}

export function iineStage() {
  return `<div class="iine-stage">
    <img class="send-mascot" src="/v3/ehon/sender.webp" alt="">
    <button type="button" class="tap-button" data-tap aria-label="iineを1つ増やす"><img class="iine-heart" src="/v3/ehon/heart.webp" alt=""></button>
    <img class="receive-mascot" src="/v3/ehon/receiver.webp" alt="">
    <span data-emoji class="visually-hidden" aria-hidden="true"></span><p data-tier class="visually-hidden" role="status"></p>
    <div class="iine-particles" aria-hidden="true"></div>
    <output class="gift-flight" aria-live="polite"></output>
  </div><div class="send-dock"><div class="charge-dots" aria-hidden="true"></div>
    <div class="tap-controls"><button type="button" class="secondary" data-minus aria-label="1つ減らす">−</button>
    <button type="submit" class="send-iine" aria-label="贈る" disabled><strong data-count>0</strong></button>
    <button type="button" class="secondary" data-reset aria-label="0にリセット">↺</button></div>
    <input type="hidden" name="ina" value="0"></div>
    <div class="gift-tools"><button type="button" class="secondary sound-toggle" data-sound aria-label="効果音を切り替える" aria-pressed="true">🔊</button>
    <button type="button" class="secondary" data-open-memo aria-label="ひとことを添える">✎</button><button type="button" class="secondary" data-open-wara aria-label="WARAを贈る">🌾</button></div>`;
}

let sharedSound;

export function bindIineGame(form, { initial = 0, remaining = 10, member = true, sound = (sharedSound ||= createIineSound()) } = {}) {
  let count = clampCount(initial, remaining);
  const stage = form.querySelector(".iine-stage"), emoji = form.querySelector("[data-emoji]");
  const tap = form.querySelector("[data-tap]"), confirm = form.querySelector('[type="submit"]');
  const reduced = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const animate = (el, frames, duration) => { if (!reduced()) el.animate?.(frames, {duration}); };
  const vibrate = pattern => { try { globalThis.navigator?.vibrate?.(pattern); } catch {} };
  function render() {
    const tier = getTier(count);
    form.elements.ina.value = count;
    form.querySelector("[data-count]").textContent = count;
    emoji.textContent = tier.emoji;
    form.querySelector("[data-tier]").textContent = !member ? "コミュニティに参加すると贈れます。" : Number(remaining) === 0 ? "今日のiineは使い切りました。" : tier.label;
    stage.style.setProperty("--heart-scale", String(0.45 + count * 0.06));
    stage.dataset.empty = String(Number(remaining) === 0 || !member);
    const left = form.querySelector("[data-remaining]");
    if (left) left.textContent = String(Number(remaining) - count);
    if (form.elements.reaction) {
      form.elements.reaction.value = count ? tier.emoji : "";
      for (const button of form.querySelectorAll("[data-reaction]"))
        button.setAttribute("aria-pressed", String(button.dataset.reaction === form.elements.reaction.value));
    }
    form.querySelector(".charge-dots").innerHTML = '<i class="red-dot selected"></i>'.repeat(count);
    if (confirm) confirm.disabled = !member || count === 0;
    tap.disabled = !member || Number(remaining) === 0;
    form.querySelector("[data-minus]").disabled = count === 0;
    form.querySelector("[data-reset]").disabled = count === 0;
  }
  const soundButton = form.querySelector("[data-sound]");
  function renderSound() {
    soundButton.textContent = sound.enabled ? "🔊" : "🔇";
    soundButton.setAttribute("aria-pressed", String(sound.enabled));
  }
  soundButton.onclick = () => { sound.toggle(); renderSound(); sound.play("tap"); };
  tap.onclick = () => {
    if (form.dataset.busy || !member) return;
    const next = clampCount(count + 1, remaining);
    if (next === count) {
      sound.play("bump"); vibrate([20, 25, 20]);
      animate(stage, [{transform:"translateX(0)"},{transform:"translateX(-5px)"},{transform:"translateX(5px)"},{transform:"translateX(0)"}], 180);
      return;
    }
    const previous = getTier(count).emoji;
    count = next; render();
    sound.play("tap", count, previous !== getTier(count).emoji); vibrate(12);
    animate(tap, [{transform:"scale(.85)"},{transform:"scale(1.22)"},{transform:"scale(1)"}], 220);
    if (!reduced()) {
      const particle = document.createElement("span"); particle.textContent = getTier(count).emoji;
      particle.style.left = (25 + Math.random() * 50) + "%";
      const layer = form.querySelector(".iine-particles");
      if (layer.childElementCount >= 12) layer.firstElementChild.remove();
      layer.append(particle); setTimeout(() => particle.remove(), 750);
    }
  };
  function adjust(reset) {
    if (form.dataset.busy) return;
    count = reset ? 0 : clampCount(count - 1, remaining); render(); sound.play("reset");
  }
  form.querySelector("[data-minus]").onclick = () => adjust(false);
  form.querySelector("[data-reset]").onclick = () => adjust(true);
  render(); renderSound();
  return { unlock: sound.unlock, success: async () => {
    sound.play("success");
    const flight = form.querySelector(".gift-flight"); flight.textContent = "+" + count * 100;
    stage.classList.add("sending");
    if (!reduced()) await new Promise(resolve => setTimeout(resolve, 1300));
  } };
}
