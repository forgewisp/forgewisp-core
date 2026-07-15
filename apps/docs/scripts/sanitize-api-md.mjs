// Sanitize TypeDoc-generated API markdown so Docusaurus's MDX compiler accepts it.
//
// Docusaurus compiles every `.md` file as MDX, which means bare `{...}` in prose
// is parsed as a JS expression and `<X>` as JSX — both blow up the build. The
// package TSDoc also contains 2-space-indented code examples, which are not a
// CommonMark code block (needs 4 spaces) and so reach the prose pipeline. This
// script, run after `typedoc`:
//   1. converts indented code runs into fenced ```ts blocks, and
//   2. escapes `{`, `}`, and `<` in prose (outside fenced + inline code).
//   3. re-creates each api dir's `_category_.json` (typedoc clears its output
//      dir on every run, so a committed one would be wiped; the curated
//      "API Reference" sidebar label must be regenerated here).
// It only ever touches files under docs/**/api/, never the hand-written guides.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['docs/core/api', 'docs/bundled-tools/api', 'docs/mcp/api'];

// typedoc (0.28) clears its output dir on every run (cleanOutputDir defaults to
// true), which would wipe a committed `_category_.json`. Docusaurus's sidebar
// autogeneration needs one in each api dir to show a curated "API Reference"
// label (otherwise it derives "Api" from the folder name). Re-create it here,
// after typedoc runs, so the label survives every `pnpm gen:api` / `predev` /
// `prebuild` without depending on a committed file that gets deleted.
const CATEGORY_JSON = JSON.stringify({ label: 'API Reference', position: 99 }, null, 2) + '\n';

const looksLikeCode = (line) =>
  /[{}();=]|=>|\b(const|let|var|function|return|new |await |import |export |type |interface )\b/.test(
    line,
  );

const escapeProse = (s) =>
  s
    .replace(/(?<!\\)\{/g, '\\{')
    .replace(/(?<!\\)\}/g, '\\}')
    .replace(/</g, '&lt;');

// Protect inline code spans (backticks); escape everything else in the line.
const sanitizeLine = (line) => {
  let out = '';
  let inCode = false;
  let buf = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '`') {
      if (inCode) {
        out += '`' + buf + '`';
        buf = '';
        inCode = false;
      } else {
        out += escapeProse(buf);
        buf = '';
        inCode = true;
      }
    } else {
      buf += c;
    }
  }
  out += inCode ? '`' + buf : escapeProse(buf);
  return out;
};

const listMd = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => join(dir, e.name));
};

const processFile = async (file) => {
  const text = await readFile(file, 'utf8');
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Pass fenced blocks through untouched.
    if (/^```/.test(line)) {
      out.push(line);
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        out.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        out.push(lines[i]);
        i++;
      }
      continue;
    }

    // Convert an indented (>=2 space) run into a fenced ```ts block, but only
    // when it's preceded by a blank line and at least one line looks like code.
    const indent = /^( {2,})\S/.exec(line);
    const prevBlank = out.length === 0 || out[out.length - 1].trim() === '';
    if (indent && prevBlank) {
      const run = [];
      let minIndent = Infinity;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '') {
          run.push(l);
          i++;
          continue;
        }
        const m = /^( {2,})\S/.exec(l);
        if (!m) break;
        minIndent = Math.min(minIndent, m[1].length);
        run.push(l);
        i++;
      }
      while (run.length && run[run.length - 1].trim() === '') run.pop();
      if (run.length && run.some(looksLikeCode)) {
        out.push('```ts');
        for (const l of run) out.push(l.slice(minIndent));
        out.push('```');
        out.push('');
        continue;
      }
      for (const l of run) out.push(sanitizeLine(l));
      continue;
    }

    out.push(sanitizeLine(line));
    i++;
  }
  await writeFile(file, out.join('\n'));
};

for (const dir of DIRS) {
  const absDir = join(root, dir);
  const files = await listMd(absDir);
  await Promise.all(files.map(processFile));
  await mkdir(absDir, { recursive: true });
  await writeFile(join(absDir, '_category_.json'), CATEGORY_JSON);
}

console.log('sanitized API markdown for', DIRS.join(', '));
