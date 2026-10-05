import { createI18n } from "./i18n.js";
import { splitLocalReference } from "./files.js";
import { enhanceMermaidCode, MERMAID_LIMITS } from "./mermaid.js";

let katex = null;
const pendingMathContainers = new Set();
export const mathReady = import("./vendor/katex/katex.mjs").then(module => {
  katex = module.default;
  for (const container of pendingMathContainers) {
    const doc = container.ownerDocument;
    if (!container.isConnected) continue;
    try {
      const html = katex.renderToString(container.dataset.latex, {
        displayMode: container.classList.contains("markdown-math-display"), output: "htmlAndMathml",
        throwOnError: true, trust: false, strict: "ignore", maxExpand: 1000, maxSize: 20
      });
      const template = doc.createElement("template");
      template.innerHTML = html;
      container.classList.remove("markdown-math-fallback");
      container.replaceChildren(template.content);
    } catch { /* Keep the readable source for invalid or unsupported math. */ }
  }
  pendingMathContainers.clear();
  return katex;
}).catch(() => { pendingMathContainers.clear(); return null; }); // A stale gateway or failed asset load must not prevent reading the conversation.
const MAX_MATH_SOURCE = 4096;
const MAX_MATH_PER_MESSAGE = 128;
const MAX_DIRECTIVE_SOURCE = 8192;
const MAX_DIRECTIVES_PER_MESSAGE = 128;

const INLINE_URL = /^https?:\/\/[^\s<>]+/i;
const TRAILING_URL_PUNCTUATION = /[.,!?;:，。！？、）\]}]+$/;

export function safeHref(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function appendText(nodes, value) {
  if (!value) return;
  const last = nodes[nodes.length - 1];
  if (last?.type === "text") last.text += value;
  else nodes.push({ type: "text", text: value });
}

function isEscaped(source, index) {
  let slashes = 0;
  while (index > 0 && source[--index] === "\\") slashes += 1;
  return slashes % 2 === 1;
}
function findUnescaped(source, token, from, limit = source.length) {
  let index = source.indexOf(token, from);
  while (index !== -1 && index < limit && isEscaped(source, index)) index = source.indexOf(token, index + token.length);
  return index >= 0 && index < limit ? index : -1;
}
function mathAt(source, index) {
  if (isEscaped(source, index)) return null;
  const opening = source.startsWith("$$", index) ? "$$" : source.startsWith("\\[", index) ? "\\[" : source.startsWith("\\(", index) ? "\\(" : source[index] === "$" ? "$" : null;
  if (!opening) return null;
  const closing = opening === "\\[" ? "\\]" : opening === "\\(" ? "\\)" : opening;
  const from = index + opening.length;
  if (opening === "$" && (!source[from] || /\s|\$/.test(source[from]))) return null;
  const limit = Math.min(source.length, from + MAX_MATH_SOURCE + closing.length);
  const findClosing = start => {
    while (start < limit) {
      const end = findUnescaped(source, closing, start, limit);
      const code = findUnescaped(source, "`", start, limit);
      if (end < 0 || code < 0 || code > end) return end;
      const codeEnd = findUnescaped(source, "`", code + 1, limit);
      if (codeEnd < 0) return -1;
      start = codeEnd + 1;
    }
    return -1;
  };
  let end = findClosing(from);
  while (end >= 0 && opening === "$" && (source[end + 1] === "$" || source[end - 1] === "$" || /\s/.test(source[end - 1]) || /\d/.test(source[end + 1] || ""))) end = findClosing(end + 1);
  if (end < 0 || !source.slice(from, end).trim() || opening === "$" && source.slice(from, end).includes("\n")) return { literal: opening };
  // Common prices must not absorb later prose/code as an accidental closing delimiter.
  const body = source.slice(from, end);
  if (opening === "$" && findUnescaped(body, "$", 0) >= 0) return { literal: opening };
  if (opening === "$" && /^\d/.test(body) && /\s/.test(body) && !/[=+*/^_{}<>-]|\\[a-z]/i.test(body)) return { literal: opening };
  return { type: "math", text: source.slice(from, end), raw: source.slice(index, end + closing.length), display: opening === "$$" || opening === "\\[", end: end + closing.length };
}

// Attribute values are read as quoted strings; task text never enters an HTML parser.
function directiveAt(source, index) {
  const limit = Math.min(source.length, index + MAX_DIRECTIVE_SOURCE);
  let cursor = index + 7;
  while (cursor < limit && /[a-z-]/.test(source[cursor])) cursor++;
  const name = source.slice(index + 1, cursor);
  let label = "";
  if (source[cursor] === "[") {
    cursor++;
    while (cursor < limit && source[cursor] !== "]" && source[cursor] !== "\n") {
      if (source[cursor] === "\\" && /[\\\]]/.test(source[cursor + 1] || "")) cursor++;
      label += source[cursor++];
    }
    if (source[cursor++] !== "]") return null;
  }
  if (source[cursor++] !== "{") return null;
  const attributes = Object.create(null);
  let valid = true;
  while (cursor < limit) {
    while (cursor < limit && /[ \t]/.test(source[cursor])) cursor++;
    if (source[cursor] === "}") {
      const end = cursor + 1;
      if (!valid) return { end };
      const keys = Object.keys(attributes);
      if (name === "codex-file-citation" && !label && keys.every(key => ["path", "purpose"].includes(key)) && attributes.path) {
        const path = attributes.path;
        const local = !/[\u0000-\u001f\u007f]/.test(path) && !/^[\\/]{2}/.test(path) && splitLocalReference(path);
        if (local && !local.path.startsWith("//")) return { end, node: { type: "file", ...local, image: false, label: [{ type: "text", text: local.path.split("/").at(-1) || "预览文件" }] } };
      }
      if (name === "codex-followup" && label.trim() && label.length <= 512 && !/[\u0000-\u001f\u007f]/.test(label) && keys.length === 1 && attributes.prompt?.trim() && attributes.prompt.length <= 4096 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(attributes.prompt)) {
        return { end, node: { type: "followup", label, prompt: attributes.prompt } };
      }
      return { end };
    }
    const keyStart = cursor;
    while (cursor < limit && /[a-zA-Z]/.test(source[cursor])) cursor++;
    const key = source.slice(keyStart, cursor);
    if (!key || source[cursor++] !== "=" || source[cursor++] !== '"') return null;
    let value = "";
    while (cursor < limit && source[cursor] !== '"' && source[cursor] !== "\n") {
      if (source[cursor] === "\\" && /[\\"]/.test(source[cursor + 1] || "")) cursor++;
      value += source[cursor++];
    }
    if (source[cursor++] !== '"') return null;
    if (Object.hasOwn(attributes, key)) valid = false;
    attributes[key] = value;
    if (source[cursor] !== "}" && !/[ \t]/.test(source[cursor] || "")) return null;
  }
  return null;
}

export function parseInline(source, context = { directives: MAX_DIRECTIVES_PER_MESSAGE }) {
  if (typeof context !== "object" || !context) context = { directives: MAX_DIRECTIVES_PER_MESSAGE };
  const nodes = [];
  let index = 0;
  const literalLine = /(?:^|\n)\s*>/.test(source) || /(?:示例|example|literal|syntax)\s*[:：]/i.test(source);
  while (index < source.length) {
    if (source[index] === "`") {
      let width = 1;
      while (source[index + width] === "`") width++;
      const end = findUnescaped(source, "`".repeat(width), index + width);
      if (end >= index + width) {
        nodes.push({ type: "code", text: source.slice(index + width, end) });
        index = end + width;
        continue;
      }
      appendText(nodes, source.slice(index)); break;
    }

    const quoteClose = { '"': '"', "'": "'", "“": "”", "‘": "’", "「": "」", "『": "』" }[source[index]];
    if (quoteClose) {
      const end = findUnescaped(source, quoteClose, index + 1);
      if (end >= 0 && source.slice(index + 1, end).includes(":codex-")) {
        appendText(nodes, source.slice(index, end + 1)); index = end + 1; continue;
      }
    }
    if (source.startsWith(":codex-", index)) {
      const directive = context.directives > 0 ? directiveAt(source, index) : null;
      context.directives--;
      if (directive) {
        const htmlExample = /<(?:!--|\/?[a-z])/i.test(source.slice(0, index));
        if (directive.node && !literalLine && !htmlExample && !isEscaped(source, index) && context.allowDirectives !== false) nodes.push(directive.node);
        else appendText(nodes, source.slice(index, directive.end));
        index = directive.end; continue;
      }
      // A malformed or oversized directive stays literal, including any embedded links.
      appendText(nodes, source.slice(index)); break;
    }

    const math = mathAt(source, index);
    if (math?.type === "math") {
      const { end, ...node } = math;
      nodes.push(node); index = end; continue;
    }
    if (math?.literal) {
      // Keep unmatched delimiters and their LaTeX readable, without parsing formatting inside them.
      if (math.literal !== "$") { appendText(nodes, source.slice(index)); break; }
      appendText(nodes, math.literal); index += math.literal.length; continue;
    }
    if (source[index] === "\\" && /[$\\()[\]`*_]/.test(source[index + 1] || "")) {
      appendText(nodes, source[index + 1]); index += 2; continue;
    }

    const marker = source.startsWith("**", index) ? "**" : source.startsWith("__", index) ? "__" : null;
    if (marker) {
      const end = findUnescaped(source, marker, index + 2);
      if (end > index + 2) {
        nodes.push({ type: "strong", children: parseInline(source.slice(index + 2, end), context) });
        index = end + 2;
        continue;
      }
    }

    const image = source.startsWith("![", index);
    const labelStart = image ? index + 2 : source[index] === "[" ? index + 1 : -1;
    if (labelStart >= 0) {
      const labelEnd = source.indexOf("](", labelStart);
      if (labelEnd > labelStart) {
        const destinationStart = labelEnd + 2;
        const angleWrapped = source[destinationStart] === "<";
        const encodedWrapped = source.startsWith("&lt;", destinationStart);
        const wrapperWidth = encodedWrapped ? 4 : angleWrapped ? 1 : 0;
        const destinationEnd = wrapperWidth ? source.indexOf(encodedWrapped ? "&gt;" : ">", destinationStart + wrapperWidth) : source.indexOf(")", destinationStart);
        const close = destinationEnd + wrapperWidth;
        const entityWrapper = /^&(?:lt;|amp;lt;|#(?:0*60|x0*3c);)/i.test(source.slice(destinationStart, destinationStart + 24));
        if (entityWrapper && (!encodedWrapped || destinationEnd < 0 || source[close] !== ")")) {
          appendText(nodes, source.slice(index)); break;
        }
        if (destinationEnd > destinationStart + wrapperWidth && source[close] === ")") {
          const label = source.slice(labelStart, labelEnd);
          let destination = source.slice(destinationStart + wrapperWidth, destinationEnd).trim();
          // Native Markdown escapes angle wrappers and ampersands. Decode only this known
          // destination syntax, once; raw paths and the rest of the message stay literal.
          if (encodedWrapped) destination = destination.replaceAll("&amp;", "&");
          const reference = splitLocalReference(destination);
          const encodedNonLocal = encodedWrapped && /^(?:[a-z][a-z\d+.-]*&(?:colon|#0*58|#x0*3a);|&(?:sol|bsol|#0*(?:47|92)|#x0*(?:2f|5c));)/i.test(destination);
          const local = reference && !encodedNonLocal && !reference.path.startsWith("//") && !/[\u0000-\u001f\u007f]/.test(reference.path) ? reference : null;
          const href = safeHref(destination);
          if (local) {
            nodes.push({ type: "file", path: local.path, line: local.line, image, label: parseInline(label, { ...context, allowDirectives: false }) });
            index = close + 1;
            continue;
          }
          if (encodedWrapped) {
            appendText(nodes, source.slice(index, close + 1)); index = close + 1; continue;
          }
          if (href && !image) {
            nodes.push({ type: "link", href, children: parseInline(label, { ...context, allowDirectives: false }) });
            index = close + 1;
            continue;
          }
        }
      }
    }

    const scheme = source.slice(index, index + 8).toLowerCase();
    const match = scheme.startsWith("http://") || scheme.startsWith("https://")
      ? source.slice(index).match(INLINE_URL)
      : null;
    if (match) {
      let candidate = match[0];
      let trailing = "";
      const punctuation = candidate.match(TRAILING_URL_PUNCTUATION);
      if (punctuation) {
        trailing = punctuation[0];
        candidate = candidate.slice(0, -trailing.length);
      }
      const href = safeHref(candidate);
      if (href) {
        nodes.push({ type: "link", href, children: [{ type: "text", text: candidate }] });
        appendText(nodes, trailing);
        index += match[0].length;
        continue;
      }
    }

    appendText(nodes, source[index]);
    index += 1;
  }
  return nodes;
}

function isFence(line) { return /^ {0,3}(?:`{3,}|~{3,})/.test(line); }
function isHeading(line) { return /^ {0,3}#{1,6}\s+/.test(line); }
function isCreatedTask(line) { return /^::created-thread\{(?:threadId|clientThreadId)="[0-9a-f-]{36}"\}\s*$/i.test(line); }
function listMatch(line) { return line.match(/^ {0,3}([-+*]|\d+[.)])\s+(.*)$/); }
function splitCells(line) {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  const cells = []; let cell = "";
  for (let index = 0; index < value.length;) {
    const math = mathAt(value, index);
    if (math?.type === "math") { cell += math.raw; index = math.end; continue; }
    if (value[index] === "`") {
      const end = findUnescaped(value, "`", index + 1);
      if (end >= 0) { cell += value.slice(index, end + 1); index = end + 1; continue; }
    }
    if (value[index] === "|" && !isEscaped(value, index)) { cells.push(cell.trim()); cell = ""; index++; continue; }
    if (value[index] === "\\" && value[index + 1] === "|" && !isEscaped(value, index)) { cell += "|"; index += 2; continue; }
    cell += value[index++];
  }
  cells.push(cell.trim());
  return cells;
}
function isTableSeparator(line) {
  const cells = splitCells(line);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}
function startsBlock(lines, index) {
  const line = lines[index] ?? "";
  return isFence(line) || /^(?:\$\$|\\\[)/.test(line.trimStart()) || isHeading(line) || isCreatedTask(line) || listMatch(line) || (line.includes("|") && isTableSeparator(lines[index + 1] ?? ""));
}

export function parseMarkdown(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let index = 0;
  const context = { directives: MAX_DIRECTIVES_PER_MESSAGE };
  const inline = source => parseInline(source, context);

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    if (isCreatedTask(line)) {
      blocks.push({ type: "paragraph", interfaceKey: "已创建新任务", children: [{ type: "text", text: "已创建新任务" }] });
      index += 1;
      continue;
    }

    if (isFence(line)) {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      const marker = opening[1];
      const language = opening[2].trim().slice(0, 40);
      const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`);
      const body = [];
      index += 1;
      while (index < lines.length && !closing.test(lines[index])) body.push(lines[index++]);
      const incomplete = index === lines.length;
      if (!incomplete) index += 1;
      blocks.push({ type: "codeBlock", language, text: body.join("\n"), ...(/^mermaid$/i.test(language) && incomplete ? { incomplete: true } : {}) });
      continue;
    }

    if (/^(?:\$\$|\\\[)/.test(line.trimStart())) {
      const candidates = lines.slice(index, index + 256);
      const fence = candidates.findIndex((candidate, at) => at > 0 && isFence(candidate));
      const source = (fence >= 0 ? candidates.slice(0, fence) : candidates).join("\n");
      const math = mathAt(source, source.length - source.trimStart().length);
      if (math?.type === "math" && math.display) {
        const consumed = source.slice(0, math.end).split("\n");
        const suffix = lines[index + consumed.length - 1].slice(consumed.at(-1).length);
        blocks.push({ type: "mathBlock", text: math.text, raw: math.raw });
        index += consumed.length;
        if (suffix.trim()) blocks.push({ type: "paragraph", children: inline(suffix) });
        continue;
      }
    }

    const heading = line.match(/^ {0,3}(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, children: inline(heading[2].trim()) });
      index += 1;
      continue;
    }

    if (line.includes("|") && isTableSeparator(lines[index + 1] ?? "")) {
      const headers = splitCells(line).map(inline);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        rows.push(splitCells(lines[index]).map(inline));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    const firstList = listMatch(line);
    if (firstList) {
      const ordered = /^\d/.test(firstList[1]);
      const items = [];
      while (index < lines.length) {
        const item = listMatch(lines[index]);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        items.push(inline(item[2]));
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) paragraph.push(lines[index++]);
    blocks.push({ type: "paragraph", children: inline(paragraph.join("\n")) });
  }
  return blocks;
}

function appendMath(parent, node, doc, budget) {
  const container = doc.createElement("span");
  container.className = node.display ? "markdown-math markdown-math-display" : "markdown-math markdown-math-inline";
  container.dataset.latex = node.text;
  try {
    if (node.text.length > MAX_MATH_SOURCE || budget.remaining-- <= 0) throw new Error("Math rendering unavailable or limited");
    if (!katex) { pendingMathContainers.add(container); throw new Error("Math renderer is loading"); }
    const html = katex.renderToString(node.text, { displayMode: node.display, output: "htmlAndMathml", throwOnError: true, trust: false, strict: "ignore", maxExpand: 1000, maxSize: 20 });
    const template = doc.createElement("template");
    // Only KaTeX output with trust disabled enters this inert template, never raw task HTML.
    template.innerHTML = html;
    container.append(template.content);
  } catch {
    container.classList.add("markdown-math-fallback");
    container.textContent = node.raw;
  }
  parent.append(container);
}

function appendInline(parent, nodes, doc, budget) {
  const i18n = createI18n({ window: doc.defaultView, document: doc }), t = i18n.t;
  for (const node of nodes) {
    if (node.type === "text") parent.append(doc.createTextNode(node.text));
    else if (node.type === "math") appendMath(parent, node, doc, budget);
    else if (node.type === "strong") {
      const strong = doc.createElement("strong");
      appendInline(strong, node.children, doc, budget);
      parent.append(strong);
    } else if (node.type === "code") {
      const code = doc.createElement("code");
      code.textContent = node.text;
      parent.append(code);
    } else if (node.type === "link") {
      const href = safeHref(node.href);
      if (!href) { appendInline(parent, node.children, doc, budget); continue; }
      const link = doc.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      appendInline(link, node.children, doc, budget);
      parent.append(link);
    } else if (node.type === "followup") {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "markdown-followup";
      button.textContent = node.label;
      i18n.attr(button, "aria-label", () => t`使用建议：${node.label}`);
      button.disabled = !budget.allowFollowups;
      if (budget.allowFollowups) {
        button.dataset.codexFollowup = node.prompt;
        button.dataset.followupLabel = node.label;
      }
      parent.append(button);
    } else if (node.type === "file") {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "markdown-file-link";
      button.dataset.localFile = node.path;
      if (node.line) button.dataset.line = node.line.slice(1);
      if (node.image) i18n.attr(button, "aria-label", () => t`预览图片：${node.label.map(child => child.text || "").join("") || node.path}`);
      appendInline(button, node.label, doc, budget);
      if (node.image && !button.textContent.trim()) i18n.text(button, () => t("预览图片"));
      if (node.line) {
        const suffix = doc.createElement("span");
        suffix.className = "markdown-file-line";
        suffix.textContent = ` ${node.line}`;
        button.append(suffix);
      }
      parent.append(button);
    }
  }
}

function appendBlock(parent, block, doc, budget) {
  const i18n = createI18n({ window: doc.defaultView, document: doc }), t = i18n.t;
  if (block.type === "heading") {
    const heading = doc.createElement(`h${block.level}`);
    appendInline(heading, block.children, doc, budget);
    parent.append(heading);
  } else if (block.type === "paragraph") {
    const paragraph = doc.createElement("p");
    paragraph.className = "markdown-paragraph";
    if (block.interfaceKey) i18n.text(paragraph, () => t(block.interfaceKey));
    else appendInline(paragraph, block.children, doc, budget);
    parent.append(paragraph);
  } else if (block.type === "list") {
    const list = doc.createElement(block.ordered ? "ol" : "ul");
    for (const item of block.items) {
      const li = doc.createElement("li");
      appendInline(li, item, doc, budget);
      list.append(li);
    }
    parent.append(list);
  } else if (block.type === "codeBlock") {
    const wrapper = doc.createElement("div");
    wrapper.className = "markdown-code";
    const header = doc.createElement("div");
    header.className = "markdown-code-header";
    const language = doc.createElement("span");
    i18n.text(language, () => block.language || t("代码"));
    const copy = doc.createElement("button");
    copy.type = "button";
    copy.className = "copy-code-button";
    i18n.text(copy, () => t("复制"));
    i18n.attr(copy, "aria-label", () => t("复制代码"));
    copy.addEventListener("click", async () => {
      try {
        await doc.defaultView.navigator.clipboard.writeText(block.text);
        i18n.text(copy, () => t("已复制"));
        setTimeout(() => { i18n.text(copy, () => t("复制")); }, 1400);
      } catch {
        i18n.text(copy, () => t("复制失败"));
      }
    });
    header.append(language, copy);
    const pre = doc.createElement("pre");
    const code = doc.createElement("code");
    code.textContent = block.text;
    pre.append(code);
    wrapper.append(header, pre);
    parent.append(wrapper);
    if (/^mermaid$/i.test(block.language)) enhanceMermaidCode(wrapper, block.text, doc, { incomplete: block.incomplete === true, limited: budget.diagrams-- <= 0 });
  } else if (block.type === "table") {
    const scroll = doc.createElement("div");
    scroll.className = "markdown-table-scroll";
    const table = doc.createElement("table");
    const thead = doc.createElement("thead");
    const headerRow = doc.createElement("tr");
    for (const cells of block.headers) {
      const cell = doc.createElement("th");
        appendInline(cell, cells, doc, budget);
      headerRow.append(cell);
    }
    thead.append(headerRow);
    const tbody = doc.createElement("tbody");
    for (const row of block.rows) {
      const tr = doc.createElement("tr");
      for (let column = 0; column < block.headers.length; column += 1) {
        const cell = doc.createElement("td");
        appendInline(cell, row[column] ?? [], doc, budget);
        tr.append(cell);
      }
      tbody.append(tr);
    }
    table.append(thead, tbody);
    scroll.append(table);
    parent.append(scroll);
  } else if (block.type === "mathBlock") appendMath(parent, { ...block, display: true }, doc, budget);
}

export function appendMarkdown(parent, source, doc = globalThis.document, options = {}) {
  if (!doc?.createElement || !parent?.append) throw new TypeError("A DOM parent and document are required");
  const budget = { remaining: MAX_MATH_PER_MESSAGE, diagrams: MERMAID_LIMITS.perMessage, allowFollowups: options.allowFollowups === true };
  for (const block of parseMarkdown(source)) appendBlock(parent, block, doc, budget);
}

if (typeof window !== "undefined") {
  window.CodexMarkdown = Object.freeze({ appendMarkdown, parseMarkdown, safeHref });
}
