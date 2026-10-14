import { readFileSync } from "node:fs";
import { join } from "node:path";

// PrepForge's piece art and board annotation renderer live inside app.js and are not
// exported; slice them out of the source (as the board tests do) rather than copy them.
export function boardKit(webSrc) {
  const src = readFileSync(join(webSrc, "app.js"), "utf8").replace(/\r\n/g, "\n");
  const block = (start, end) => {
    const i = src.indexOf(start);
    const j = src.indexOf(end, i);
    if (i < 0 || j < 0) throw new Error(`board kit: cannot find ${start} in web-src/app.js`);
    return src.slice(i, j + end.length);
  };
  const fsPath = (p) => JSON.stringify("/@fs/" + p.replace(/\\/g, "/").replace(/^\//, ""));
  return [
    `import { html, raw } from ${fsPath(join(webSrc, "html.js"))};`,
    `import { buildArrowHeadPath, buildArrowPath, endsUnder } from ${fsPath(join(webSrc, "board-arrows.js"))};`,
    block('const files = [', ';\n'),
    block("const PIECE_SETS = {", "\n};\n"),
    block("function parseFenBoard(", "\n}\n"),
    block("const PIECE_LABEL_NAMES", "\n}\n"),
    block("function renderAnnotations(", "\n}\n"),
    block("function squareCenter(", "\n}\n"),
    "export { files, PIECE_SETS, parseFenBoard, pieceLabel, renderAnnotations };",
  ].join("\n");
}
