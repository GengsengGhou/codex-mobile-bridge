import { messages } from "./i18n-messages.js";

export const LANGUAGE_KEY = "codex-mobile-language";
const instances = new WeakMap();
const canonical = value => value === "zh-CN" || value === "en" ? value : null;

/** Explicit UI translations. User messages, names, paths and logs never enter this dictionary. */
export function createI18n({ window: win = globalThis.window, document: doc = win?.document } = {}) {
  if (doc && instances.has(doc)) return instances.get(doc);
  let stored;
  try { stored = win?.localStorage.getItem(LANGUAGE_KEY); } catch { /* Session-only preference. */ }
  let language = canonical(stored) || (/^zh\b/i.test(win?.navigator?.language || "") ? "zh-CN" : win ? "en" : "zh-CN");
  const dictionary = { ...messages }, listeners = new Set(), bindings = new Map(), renderedCopy = new Map(), textWhitespace = new WeakMap();
  const englishKeys = new Map(Object.entries(dictionary).map(([key, value]) => [value, key]));
  let cleanupQueued = false;
  let messagePatterns;
  function t(key, params = {}) {
    if (Array.isArray(key) && Object.hasOwn(key, "raw")) {
      const values = [params, ...Array.prototype.slice.call(arguments, 2)];
      const source = key.reduce((result, part, index) => result + part + (index < key.length - 1 ? `{${index}}` : ""), "");
      return t(source, Object.fromEntries(values.map((value, index) => [index, value])));
    }
    const previous = renderedCopy.get(String(key ?? ""));
    let source = previous?.source || englishKeys.get(String(key ?? "")) || String(key ?? "");
    if (previous && !Object.keys(params).length) params = previous.params;
    // Known API errors can arrive already formatted. This is used only at explicit UI-copy calls.
    if (source && !Object.hasOwn(dictionary, source) && !Object.keys(params).length) {
      messagePatterns ??= Object.keys(dictionary).filter(key => /\{\w+\}/.test(key)).flatMap(key => [key, dictionary[key]].map(copy => {
        const names = [...copy.matchAll(/\{(\w+)\}/g)].map(match => match[1]);
        const pattern = copy.split(/\{\w+\}/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("([\\s\\S]*?)");
        return { key, names, pattern: new RegExp(`^${pattern}$`) };
      }));
      for (const candidate of messagePatterns) {
        const match = candidate.pattern.exec(source);
        if (match) { source = candidate.key; params = Object.fromEntries(candidate.names.map((name, index) => [name, match[index + 1]])); break; }
      }
    }
    const result = (language === "en" ? dictionary[source] ?? source : source).replace(/\{([\w]+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name] ?? "") : match);
    if (Object.hasOwn(dictionary, source)) {
      const original = source.replace(/\{([\w]+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name] ?? "") : match);
      const english = dictionary[source].replace(/\{([\w]+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name] ?? "") : match);
      const record = { source, params: { ...params } };
      renderedCopy.set(original, record); renderedCopy.set(english, record);
      while (renderedCopy.size > 1024) renderedCopy.delete(renderedCopy.keys().next().value);
    }
    return result;
  }
  function remember(element, kind, render) {
    let record = bindings.get(element);
    if (!record) bindings.set(element, record = new Map());
    record.set(kind, render);
    if (kind === "text") element.removeAttribute?.("data-i18n");
    else if (kind.startsWith("attr:")) element.removeAttribute?.(`data-i18n-${kind.slice(5)}`);
    render();
    if (!cleanupQueued && doc) {
      cleanupQueued = true;
      queueMicrotask(() => { cleanupQueued = false; for (const element of bindings.keys()) if (!element.isConnected) bindings.delete(element); });
    }
    return element;
  }
  function text(element, render) { return remember(element, "text", () => { const value = String(render() ?? ""); if (element.textContent !== value) element.textContent = value; }); }
  function attr(element, name, render) { return remember(element, `attr:${name}`, () => element.setAttribute(name, render())); }
  function html(element, render) {
    let initialized = false;
    return remember(element, "html", () => {
      const markup = render();
      if (!initialized) { element.innerHTML = markup; initialized = true; return; }
      // Refresh only owned copy in an existing tree. Keep focus, selections, drafts and disclosures.
      const template = doc.createElement("template"); template.innerHTML = markup;
      function patch(current, next) {
        if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) return;
        if (current.nodeType === 3) { if (current.data !== next.data) current.data = next.data; return; }
        for (const name of ["title", "aria-label", "placeholder"]) {
          if (next.hasAttribute?.(name)) current.setAttribute(name, next.getAttribute(name));
        }
        if (current.childNodes.length === next.childNodes.length) [...current.childNodes].forEach((node, index) => patch(node, next.childNodes[index]));
      }
      if (element.childNodes.length === template.content.childNodes.length) [...element.childNodes].forEach((node, index) => patch(node, template.content.childNodes[index]));
    });
  }
  function apply(root = doc) {
    if (!root) return;
    for (const element of root.querySelectorAll("[data-i18n]")) {
      const key = element.getAttribute("data-i18n");
      // An annotation owns one text node, never a container with user content.
      const index = Number(element.getAttribute("data-i18n-node") ?? 0);
      const node = element.childNodes[index];
      if (node?.nodeType === 3) {
        if (!textWhitespace.has(node)) textWhitespace.set(node, { before: node.data.match(/^\s*/)[0], after: node.data.match(/\s*$/)[0] });
        const spacing = textWhitespace.get(node), value = spacing.before + t(key) + spacing.after;
        if (node.data !== value) node.data = value;
      }
    }
    for (const name of ["title", "aria-label", "placeholder", "aria-description"]) {
      for (const element of root.querySelectorAll(`[data-i18n-${name}]`)) element.setAttribute(name, t(element.getAttribute(`data-i18n-${name}`)));
    }
    for (const selector of root.querySelectorAll("[data-language-selector]")) selector.value = language;
    if (doc?.documentElement) doc.documentElement.lang = language;
  }
  function refresh() {
    apply();
    for (const [element, record] of bindings) {
      if (element.isConnected === false) { bindings.delete(element); continue; }
      for (const render of record.values()) render();
    }
    for (const listener of listeners) listener(language);
  }
  function setLanguage(value, persist = true) {
    const next = canonical(value); if (!next) return;
    if (persist) try { win?.localStorage.setItem(LANGUAGE_KEY, next); } catch { /* Works until this page closes. */ }
    if (next === language) return;
    language = next; refresh();
  }
  function option(render, value = "", Option = win?.Option) { const element = new Option("", value); text(element, render); return element; }
  function languagePicker() {
    const element = doc.createElement("select"); element.className = "language-select"; element.setAttribute("data-language-selector", "");
    element.append(new win.Option("中文", "zh-CN"), new win.Option("EN", "en")); element.value = language;
    attr(element, "aria-label", () => t("界面语言")); return element;
  }
  const api = { t, text, attr, html, option, languagePicker, apply, get language() { return language; }, setLanguage, register(values) { Object.assign(dictionary, values); for (const [key, value] of Object.entries(values)) englishKeys.set(value, key); messagePatterns = undefined; }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  if (doc) {
    instances.set(doc, api);
    doc.addEventListener("change", event => { if (event.target.matches?.("[data-language-selector]")) setLanguage(event.target.value); });
    win?.addEventListener("storage", event => { if (event.key === LANGUAGE_KEY && canonical(event.newValue)) setLanguage(event.newValue, false); });
    apply();
  }
  return api;
}
