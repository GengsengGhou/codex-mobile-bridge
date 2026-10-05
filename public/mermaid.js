import { createI18n } from "./i18n.js";

export const MERMAID_LIMITS = Object.freeze({ source: 16384, lines: 128, line: 512, edges: 80, perMessage: 4, svg: 524288, elements: 12000 });
const TYPES = /^(?:mindmap|(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)|sequenceDiagram)\s*(?:$|;)/i;
const FONT = 'Arial, "Microsoft YaHei", sans-serif';

export function mermaidSourceIssue(source) {
  if (typeof source !== "string" || source.length > MERMAID_LIMITS.source) return "limit";
  const lines = source.split(/\r?\n/);
  if (lines.length + (source.match(/;/g) || []).length > MERMAID_LIMITS.lines || lines.some(line => line.length > MERMAID_LIMITS.line)
    || (source.match(/(?:<-->|-->|---|==>|-\.->|->>|-->>|--x|--o)/g) || []).length > MERMAID_LIMITS.edges) return "limit";
  // Conversation text cannot change renderer configuration, introduce HTML/resources, or bind actions.
  if (/%%\s*\{|^\s*---\s*$|::icon\s*\(|@\{|<\/?[a-z!]|&(?:lt|#0*60|#x0*3c);|(?:https?|javascript|data|file|vbscript)\s*:|\b(?:themeCSS|securityLevel|htmlLabels)\b/mi.test(source)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source)) return "unsafe";
  const first = lines.map(line => line.trim()).find(line => line && !line.startsWith("%%")) || "";
  if (/^(?:flowchart|graph)\b/i.test(first) && /(?:^|;)\s*(?:click|style|classDef|linkStyle)\b/mi.test(source)) return "unsafe";
  return TYPES.test(first) ? null : "unsupported";
}

function safeCss(value) {
  const withoutKeyframes = value.replace(/@keyframes (?:edge-animation-frame|dash)\{(?:from|to)\{stroke-dashoffset:0;\}\}/g, "");
  if (/@|\\|expression\s*\(|(?:javascript|data|https?|file)\s*:|(?:behavior|-moz-binding)\s*:/i.test(withoutKeyframes)) return false;
  return !/url\s*\(/i.test(value.replace(/url\(\s*["']?#[A-Za-z_][\w:.-]*["']?\s*\)/gi, ""));
}

function inlineStyles(svg, doc) {
  const styles = [...svg.querySelectorAll('style, desc[data-mermaid-css="true"]')];
  if (!styles.length) return;
  const declarations = new Map();
  const greater = (left, right) => !right || left.some((value, at) => value !== right[at] && left.slice(0, at).every((part, index) => part === right[index]) && value > right[at]);
  for (const element of [svg, ...svg.querySelectorAll("*")]) {
    const properties = new Map();
    for (const property of element.style || []) properties.set(property, { value: element.style.getPropertyValue(property), weight: [Number(element.style.getPropertyPriority(property) === "important"), 1, 0, 0, 0, 0] });
    declarations.set(element, properties);
  }
  let order = 0;
  for (const style of styles) {
    if (!safeCss(style.textContent)) throw new Error("Unsafe diagram CSS");
    const sheet = new doc.defaultView.CSSStyleSheet();
    sheet.replaceSync(style.textContent);
    if (sheet.cssRules.length > 1024) throw new Error("Diagram CSS limit");
    for (const rule of sheet.cssRules) {
      if (rule.type === 7) continue; // Known generated dash keyframes; no animations are needed in an image.
      if (rule.type !== 1) throw new Error("Unsupported diagram CSS rule");
      for (const selector of rule.selectorText.split(",")) {
        const ids = (selector.match(/#[\w-]+/g) || []).length;
        const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) || []).length;
        const tags = (selector.match(/(?:^|[\s>+~])(?:[a-zA-Z][\w-]*|::[\w-]+)/g) || []).length;
        const matching = [...(svg.matches(selector) ? [svg] : []), ...svg.querySelectorAll(selector)];
        for (const element of matching) for (const property of rule.style) {
          const weight = [Number(rule.style.getPropertyPriority(property) === "important"), 0, ids, classes, tags, order];
          const properties = declarations.get(element);
          if (greater(weight, properties.get(property)?.weight)) properties.set(property, { value: rule.style.getPropertyValue(property), weight });
        }
        order++;
      }
    }
    style.remove();
  }
  for (const [element, properties] of declarations) for (const [property, { value, weight }] of properties) {
    element.style.setProperty(property, value, weight[0] ? "important" : "");
  }
}

export function sanitizeMermaidSvg(source, doc) {
  if (typeof source !== "string" || source.length > MERMAID_LIMITS.svg || /<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error("Invalid diagram SVG");
  const parsed = new doc.defaultView.DOMParser().parseFromString(source, "image/svg+xml");
  const svg = parsed.documentElement;
  if (svg.localName !== "svg" || svg.namespaceURI !== "http://www.w3.org/2000/svg" || parsed.querySelector("parsererror")) throw new Error("Invalid diagram SVG");
  inlineStyles(svg, doc);
  // Mermaid 12.1 mindmap circle labels use a shared helper whose centering CSS targets a missing class.
  // Rectangular mindmap labels already have their own translated origin, so leave those as generated.
  for (const node of svg.querySelectorAll(".mindmap-node")) {
    if ([...node.children].some(child => child.localName === "circle")) {
      for (const text of node.querySelectorAll(".label text")) text.style.setProperty("text-anchor", "middle");
    }
  }
  const allowed = new Set(["svg", "g", "defs", "marker", "symbol", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "title", "desc", "style", "linearGradient", "radialGradient", "stop", "clipPath", "filter", "feDropShadow"]);
  const elements = [svg, ...svg.querySelectorAll("*")];
  if (elements.length > MERMAID_LIMITS.elements) throw new Error("Diagram SVG limit");
  for (const element of elements) {
    if (!allowed.has(element.localName) || element.namespaceURI !== svg.namespaceURI) throw new Error("Unsupported diagram SVG element");
    for (const attr of [...element.attributes]) {
      if (/^on/i.test(attr.name) || /^(?:src|srcset|formaction|target)$/i.test(attr.name)) throw new Error("Unsafe diagram SVG attribute");
      if (/^(?:href|xlink:href)$/i.test(attr.name) && !/^#[A-Za-z_][\w:.-]*$/.test(attr.value)) throw new Error("Unsafe diagram SVG reference");
      if ((attr.name === "style" || /url\s*\(/i.test(attr.value)) && !safeCss(attr.value)) throw new Error("Unsafe diagram SVG CSS");
      if (attr.namespaceURI && !["http://www.w3.org/2000/xmlns/", "http://www.w3.org/1999/xlink", "http://www.w3.org/XML/1998/namespace"].includes(attr.namespaceURI)) throw new Error("Unsafe diagram SVG namespace");
    }
  }
  const viewBox = (svg.getAttribute("viewBox") || "").trim().split(/[ ,]+/).map(Number);
  if (viewBox.length !== 4 || viewBox.some(value => !Number.isFinite(value)) || viewBox[2] <= 0 || viewBox[3] <= 0
    || viewBox[2] > 12000 || viewBox[3] > 12000 || viewBox[2] * viewBox[3] > 8000000) throw new Error("Diagram dimensions unavailable or limited");
  svg.setAttribute("width", String(viewBox[2])); svg.setAttribute("height", String(viewBox[3]));
  return { svg: new doc.defaultView.XMLSerializer().serializeToString(svg), width: viewBox[2], height: viewBox[3] };
}

function visible(wrapper) {
  if (!wrapper.isConnected) return false;
  for (let node = wrapper.parentElement; node; node = node.parentElement) {
    if (node.hidden || node.tagName === "DETAILS" && !node.open || node.tagName === "DIALOG" && !node.open) return false;
  }
  return true;
}

export function createMermaidRenderer({ load = () => import("./vendor/mermaid/mermaid.mjs") } = {}) {
  const states = new WeakMap(), documents = new WeakMap();
  let library = null, queue = Promise.resolve(), counter = 0;
  const ready = () => library ||= Promise.resolve().then(load).then(module => {
    const mermaid = module.default || module;
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, htmlLabels: false,
      theme: "neutral", look: "classic", fontFamily: FONT, fontSize: 16, maxTextSize: MERMAID_LIMITS.source, maxEdges: MERMAID_LIMITS.edges,
      themeVariables: { fontFamily: FONT, fontSize: "16px" }, flowchart: { htmlLabels: false, useMaxWidth: false }, sequence: { useMaxWidth: false }, mindmap: { useMaxWidth: false } });
    return mermaid;
  });
  function release(state) {
    if (!state.url) return;
    state.doc.defaultView.URL.revokeObjectURL(state.url); state.url = null;
    documents.get(state.doc)?.rendered.delete(state);
  }
  function fallback(state, issue) {
    release(state); state.viewport.querySelector("img")?.remove();
    state.wrapper.dataset.diagramState = "fallback";
    state.status.hidden = false; state.autoSourceOpen = true; state.details.open = true;
    const key = issue === "limit" ? "图表过大，显示源码" : issue === "incomplete" ? "图表尚未完整，显示源码"
      : issue === "unsupported" ? "支持思维导图、流程图和时序图；此图显示源码" : issue === "unsafe" ? "图表包含不支持的内容，显示源码" : "图表暂时无法渲染，显示源码";
    state.i18n.text(state.status, () => state.i18n.t(key));
  }
  async function render(state) {
    const { wrapper, doc } = state;
    const current = () => documents.get(doc)?.active !== false && visible(wrapper);
    if (!current()) { wrapper.dataset.diagramState = "pending"; return; }
    let host;
    try {
      const mermaid = await ready();
      if (!current()) { wrapper.dataset.diagramState = "pending"; return; }
      host = doc.createElement("div"); host.className = "markdown-mermaid-measure"; host.setAttribute("aria-hidden", "true");
      host.style.fontFamily = FONT; host.style.fontSize = "16px";
      doc.body.append(host);
      const result = await mermaid.render(`codex-mermaid-${++counter}`, state.source, host);
      if (!current()) { wrapper.dataset.diagramState = "pending"; return; }
      const clean = sanitizeMermaidSvg(result.svg, doc);
      const url = doc.defaultView.URL.createObjectURL(new doc.defaultView.Blob([clean.svg], { type: "image/svg+xml" }));
      state.url = url; documents.get(doc).rendered.add(state);
      const image = doc.createElement("img"); image.className = "markdown-mermaid-image";
      state.i18n.attr(image, "alt", () => state.i18n.t("Mermaid 图表"));
      image.style.width = `${clean.width / 16}em`; image.width = Math.ceil(clean.width); image.height = Math.ceil(clean.height);
      image.addEventListener("error", () => { if (current() && state.url === url) fallback(state, "render"); });
      image.src = url; state.viewport.append(image);
      state.status.hidden = true; wrapper.dataset.diagramState = "ready";
      if (!state.sourceTouched) { state.autoSourceOpen = false; state.details.open = false; }
      // Never bind Mermaid callbacks, links or event handlers into the conversation.
    } catch {
      if (current()) fallback(state, "render");
      else wrapper.dataset.diagramState = "pending";
    } finally { host?.remove(); }
  }
  function observe(doc) {
    if (documents.has(doc)) return;
    const manager = { rendered: new Set(), scheduled: false, active: true };
    documents.set(doc, manager);
    const scan = () => {
      manager.scheduled = false;
      for (const state of manager.rendered) if (!state.wrapper.isConnected) {
        release(state); state.wrapper.dataset.diagramState = "pending";
        state.viewport.querySelector("img")?.remove();
      }
      if (!manager.active) return;
      for (const wrapper of doc.querySelectorAll('.markdown-mermaid[data-diagram-state="pending"]')) {
        const state = states.get(wrapper);
        if (!state || !visible(wrapper)) continue;
        wrapper.dataset.diagramState = "queued";
        queue = queue.then(() => render(state));
      }
    };
    manager.schedule = () => { if (!manager.scheduled) { manager.scheduled = true; queueMicrotask(scan); } };
    const observer = new doc.defaultView.MutationObserver(manager.schedule);
    observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["open", "hidden"] });
    doc.defaultView.addEventListener("pagehide", () => {
      manager.active = false;
      for (const state of manager.rendered) {
        release(state); state.viewport.querySelector("img")?.remove(); state.wrapper.dataset.diagramState = "pending";
      }
    });
    doc.defaultView.addEventListener("pageshow", () => { manager.active = true; manager.schedule(); });
    manager.schedule();
  }
  return {
    enhance(wrapper, source, doc, { incomplete = false, limited = false } = {}) {
      const i18n = createI18n({ window: doc.defaultView, document: doc });
      wrapper.classList.add("markdown-mermaid"); wrapper.dataset.diagramState = "pending";
      const viewport = doc.createElement("div"); viewport.className = "markdown-mermaid-viewport";
      const status = doc.createElement("p"); status.className = "markdown-mermaid-status"; status.setAttribute("role", "status");
      i18n.text(status, () => i18n.t("正在绘制图表…")); viewport.append(status);
      const details = doc.createElement("details"); details.className = "markdown-mermaid-source"; details.open = true;
      const summary = doc.createElement("summary"); i18n.text(summary, () => i18n.t("查看源码"));
      details.append(summary, wrapper.querySelector("pre")); wrapper.append(viewport, details);
      const state = { wrapper, source, doc, viewport, status, details, i18n, url: null, sourceTouched: false, autoSourceOpen: true };
      summary.addEventListener("click", () => { state.sourceTouched = true; });
      details.addEventListener("toggle", () => { if (details.open !== state.autoSourceOpen) state.sourceTouched = true; });
      states.set(wrapper, state);
      const issue = limited ? "limit" : incomplete ? "incomplete" : mermaidSourceIssue(source);
      if (issue) fallback(state, issue);
      else { observe(doc); documents.get(doc).schedule(); }
    },
  };
}

const renderer = createMermaidRenderer();
export function enhanceMermaidCode(wrapper, source, doc, options) { renderer.enhance(wrapper, source, doc, options); }
