import fs from "node:fs";
import path from "node:path";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><svg id='holder'></svg></body></html>", {
  url: "https://example.org",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});

// DOMPurify must be created AFTER `window` exists: its CJS build captures the
// global at module-eval time (`var purify = createDOMPurify()`).
const { default: createDOMPurify } = await import("dompurify");
globalThis.DOMPurify = createDOMPurify(dom.window);

const { default: mermaid } = await import("mermaid");
mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });

const root = ".";
const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".vitepress" || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".md")) files.push(p);
  }
}
walk(root);

let ok = 0, fail = 0;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const blocks = [...src.matchAll(/```mermaid\n([\s\S]*?)```/g)];
  for (const m of blocks) {
    try {
      await mermaid.parse(m[1]);
      ok++;
    } catch (err) {
      fail++;
      console.log(`FAIL ${f}: ${String(err.message).split("\n")[0]}`);
    }
  }
}
console.log(`mermaid blocks: ${ok} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
