import { Fragment, type ReactNode } from "react";

/**
 * A small, safe markdown renderer for assistant replies: paragraphs, headings,
 * bullet/numbered lists, simple tables, **bold**, *italic*, `code`, and evidence
 * citations like [E3] (rendered as buttons). It never injects HTML.
 */
export function Markdown({ text, renderCitation }: { text: string; renderCitation: (id: string, key: string) => ReactNode }) {
  const blocks = text.replace(/\r/g, "").split(/\n{2,}/);
  return <div className="space-y-2.5 [&_strong]:font-semibold [&_strong]:text-fg">{blocks.map((b, i) => <Block key={i} src={b} k={`b${i}`} cite={renderCitation} />)}</div>;
}

function Block({ src, k, cite }: { src: string; k: string; cite: (id: string, key: string) => ReactNode }) {
  const lines = src.split("\n").filter((l) => l.trim() !== "");
  if (!lines.length) return null;
  const inl = (s: string, key: string) => inline(s, key, cite);

  if (lines.every((l) => l.trim().startsWith("|"))) {
    const rows = lines.filter((l) => !/^[\s|:-]+$/.test(l)).map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    const [head, ...body] = rows;
    return (
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-left text-[13px] tabular-nums">
          <thead className="bg-white/[0.03] text-subtle"><tr>{head!.map((c, i) => <th key={i} className="px-2.5 py-1.5 font-medium">{inl(c, `${k}h${i}`)}</th>)}</tr></thead>
          <tbody>{body.map((r, ri) => <tr key={ri} className="border-t border-line">{r.map((c, ci) => <td key={ci} className="px-2.5 py-1.5">{inl(c, `${k}r${ri}c${ci}`)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
  if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
    const ordered = /^\s*\d/.test(lines[0]!);
    const items = lines.map((l) => l.replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
    const List = ordered ? "ol" : "ul";
    return <List className={ordered ? "list-decimal space-y-1 pl-5" : "list-disc space-y-1 pl-5 marker:text-subtle"}>{items.map((it, i) => <li key={i}>{inl(it, `${k}l${i}`)}</li>)}</List>;
  }
  const h = /^(#{1,4})\s+(.*)$/.exec(lines[0]!);
  if (h && lines.length === 1) return <p className="font-display text-[15px] font-semibold text-fg">{inl(h[2]!, `${k}h`)}</p>;
  return <p>{lines.map((l, i) => <Fragment key={i}>{i > 0 && <br />}{inl(l, `${k}p${i}`)}</Fragment>)}</p>;
}

const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|\[(E\d+)(?:\s*,\s*E\d+)*\]|(?<![\w*])[*_][^*_\s][^*_]*[*_](?![\w*]))/g;

function inline(s: string, key: string, cite: (id: string, key: string) => ReactNode): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of s.matchAll(TOKEN)) {
    if (m.index! > last) out.push(s.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${m.index}`;
    if (t.startsWith("**")) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={k} className="rounded bg-white/[0.06] px-1 py-0.5 text-[12.5px]">{t.slice(1, -1)}</code>);
    else if (t.startsWith("[")) out.push(<Fragment key={k}>{[...t.matchAll(/E\d+/g)].map((c) => cite(c[0], `${k}-${c[0]}`))}</Fragment>);
    else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = m.index! + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
