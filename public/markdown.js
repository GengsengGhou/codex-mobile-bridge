import { splitLocalReference } from "./files.js";

let katex = null;
try { katex = (await import("./vendor/katex/katex.mjs")).default; }
catch { /* A stale gateway or failed asset load must not prevent reading the conversation. */ }
const MAX_MATH_SOURCE = 4096;
const MAX_MATH_PER_MESSAGE = 128;

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

export function parseInline(source) {
  const nodes = [];
  let index = 0;
  while (index < source.length) {
    if (source[index] === "`") {
      const end = findUnescaped(source, "`", index + 1);
      if (end > index + 1) {
        nodes.push({ type: "code", text: source.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
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
        nodes.push({ type: "strong", children: parseInline(source.slice(index + 2, end)) });
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
        const destinationEnd = angleWrapped ? source.indexOf(">", destinationStart + 1) : source.indexOf(")", destinationStart);
        const close = angleWrapped ? destinationEnd + 1 : destinationEnd;
        if (destinationEnd > destinationStart + (angleWrapped ? 1 : 0) && source[close] === ")") {
          const label = source.slice(labelStart, labelEnd);
          const destination = source.slice(destinationStart + (angleWrapped ? 1 : 0), destinationEnd).trim();
          const local = splitLocalReference(destination);
          const href = safeHref(destination);
          if (local) {
            nodes.push({ type: "file", path: local.path, line: local.line, image, label: parseInline(label) });
            index = close + 1;
            continue;
          }
          if (href && !image) {
            nodes.push({ type: "link", href, children: parseInline(label) });
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

function isFence(line) { return /^ {0,3}```/.test(line); }
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

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    if (isCreatedTask(line)) {
      blocks.push({ type: "paragraph", children: [{ type: "text", text: "已创建新任务" }] });
      index += 1;
      continue;
    }

    if (isFence(line)) {
      const opening = line.match(/^ {0,3}```([^`]*)$/);
      const language = (opening?.[1] ?? "").trim().slice(0, 40);
      const body = [];
      index += 1;
      while (index < lines.length && !/^ {0,3}```+\s*$/.test(lines[index])) body.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push({ type: "codeBlock", language, text: body.join("\n") });
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
        if (suffix.trim()) blocks.push({ type: "paragraph", children: parseInline(suffix) });
        continue;
      }
    }

    const heading = line.match(/^ {0,3}(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2].trim()) });
      index += 1;
      continue;
    }

    if (line.includes("|") && isTableSeparator(lines[index + 1] ?? "")) {
      const headers = splitCells(line).map(parseInline);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        rows.push(splitCells(lines[index]).map(parseInline));
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
        items.push(parseInline(item[2]));
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) paragraph.push(lines[index++]);
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
  }
  return blocks;
}

function appendMath(parent, node, doc, budget) {
  const container = doc.createElement("span");
  container.className = node.display ? "markdown-math markdown-math-display" : "markdown-math markdown-math-inline";
  container.dataset.latex = node.text;
  try {
    if (!katex || node.text.length > MAX_MATH_SOURCE || budget.remaining-- <= 0) throw new Error("Math rendering unavailable or limited");
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
    } else if (node.type === "file") {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "markdown-file-link";
      button.dataset.localFile = node.path;
      if (node.line) button.dataset.line = node.line.slice(1);
      if (node.image) button.setAttribute("aria-label", `预览图片：${node.label.map(child => child.text || "").join("") || node.path}`);
      appendInline(button, node.label, doc, budget);
      if (node.image && !button.textContent.trim()) button.textContent = "预览图片";
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
  if (block.type === "heading") {
    const heading = doc.createElement(`h${block.level}`);
    appendInline(heading, block.children, doc, budget);
    parent.append(heading);
  } else if (block.type === "paragraph") {
    const paragraph = doc.createElement("p");
    paragraph.className = "markdown-paragraph";
    appendInline(paragraph, block.children, doc, budget);
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
    language.textContent = block.language || "代码";
    const copy = doc.createElement("button");
    copy.type = "button";
    copy.className = "copy-code-button";
    copy.textContent = "复制";
    copy.setAttribute("aria-label", "复制代码");
    copy.addEventListener("click", async () => {
      try {
        await doc.defaultView.navigator.clipboard.writeText(block.text);
        copy.textContent = "已复制";
        setTimeout(() => { copy.textContent = "复制"; }, 1400);
      } catch {
        copy.textContent = "复制失败";
      }
    });
    header.append(language, copy);
    const pre = doc.createElement("pre");
    const code = doc.createElement("code");
    code.textContent = block.text;
    pre.append(code);
    wrapper.append(header, pre);
    parent.append(wrapper);
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

export function appendMarkdown(parent, source, doc = globalThis.document) {
  if (!doc?.createElement || !parent?.append) throw new TypeError("A DOM parent and document are required");
  const budget = { remaining: MAX_MATH_PER_MESSAGE };
  for (const block of parseMarkdown(source)) appendBlock(parent, block, doc, budget);
}

if (typeof window !== "undefined") {
  window.CodexMarkdown = Object.freeze({ appendMarkdown, parseMarkdown, safeHref });
}
