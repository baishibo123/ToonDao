import { createContext, memo, useContext, useEffect, useState, type ReactNode } from "react";
import type { RootContent } from "mdast";
import {
  BLOCK_PATH_ATTR,
  LEAF_ATTR,
  SRC_END_ATTR,
  SRC_START_ATTR,
  parseMarkdown,
  type AnnotatedNode,
} from "@/lib/anchor";
import { svgPictureUrl } from "@/lib/svg";
import { katexReady, loadKatex, typeset } from "@/lib/math";
import { CopyButton } from "@/components/CopyButton";

/** The Markdown being rendered, so a block can copy its own source. */
const SourceContext = createContext("");

/**
 * Block-anchored markdown renderer.
 *
 * Walks mdast directly rather than going through remark-rehype → rehype-react.
 * SPEC §7 suggests the hast route; mdast carries the same `position` data with
 * one fewer lossy hop, and the leaf indices are read straight off the tree that
 * anchor.ts annotated, which removes the possibility of the renderer and the
 * resolver disagreeing. Recorded as decision A-10 in docs/decisions.md.
 *
 * Every block carries data-src-start/data-src-end/data-block-path.
 * Every text-bearing leaf carries data-leaf-index.
 * Inline wrappers (code/strong/em/a) carry source ranges too, so a click can
 * expand to the enclosing span (§5.1).
 *
 * Raw HTML in the source is rendered as literal text. Model output is untrusted
 * input; this renderer never injects its HTML. The one HTML put into the page is
 * KaTeX's typesetting of a formula, with every command that could make a link
 * or an attribute turned off (P-48).
 */

interface MarkdownProps {
  source: string;
  className?: string;
}

function srcAttrs(node: AnnotatedNode): Record<string, string | number> {
  const attrs: Record<string, string | number> = {};
  if (node.__srcStart !== undefined) attrs[SRC_START_ATTR] = node.__srcStart;
  if (node.__srcEnd !== undefined) attrs[SRC_END_ATTR] = node.__srcEnd;
  if (node.__blockPath !== undefined) attrs[BLOCK_PATH_ATTR] = node.__blockPath;
  return attrs;
}

function renderChildren(node: { children?: RootContent[] }): ReactNode {
  if (!node.children?.length) return null;
  return node.children.map((child, i) => (
    <Node key={i} node={child as AnnotatedNode} />
  ));
}

function Node({ node }: { node: AnnotatedNode }): ReactNode {
  const attrs = srcAttrs(node);

  switch (node.type) {
    case "text":
    case "html":
      return (
        <span {...{ [LEAF_ATTR]: node.__leafIndex }} {...attrs}>
          {node.value}
        </span>
      );

    case "inlineCode":
      return (
        <code
          className="md-inline-code"
          {...{ [LEAF_ATTR]: node.__leafIndex }}
          {...attrs}
        >
          {node.value}
        </code>
      );

    case "code": {
      const picture = svgPictureUrl(node.lang, node.value);
      return picture ? (
        <SvgBlock node={node} url={picture} attrs={attrs} />
      ) : (
        <CodeBlock node={node} attrs={attrs} />
      );
    }

    // P-48. A formula is not a leaf: a selection inside it finds no leaf and
    // falls back to its source range, so quoting any part of it quotes it all.
    case "math":
    case "inlineMath":
      return <MathTex tex={(node as { value: string }).value} display={node.type === "math"} attrs={attrs} />;

    case "paragraph":
      return <p {...attrs}>{renderChildren(node)}</p>;

    case "heading": {
      const Tag = (`h${Math.min(6, node.depth)}` as "h1");
      return <Tag {...attrs}>{renderChildren(node)}</Tag>;
    }

    case "strong":
      return <strong {...attrs}>{renderChildren(node)}</strong>;

    case "emphasis":
      return <em {...attrs}>{renderChildren(node)}</em>;

    case "delete":
      return <del {...attrs}>{renderChildren(node)}</del>;

    case "link":
      return (
        <a href={node.url} title={node.title ?? undefined} target="_blank" rel="noreferrer noopener" {...attrs}>
          {renderChildren(node)}
        </a>
      );

    case "image":
      return <img src={node.url} alt={node.alt ?? ""} className="md-image" {...attrs} />;

    case "blockquote":
      return <blockquote {...attrs}>{renderChildren(node)}</blockquote>;

    case "list":
      return node.ordered ? (
        <ol start={node.start ?? 1} {...attrs}>
          {renderChildren(node)}
        </ol>
      ) : (
        <ul {...attrs}>{renderChildren(node)}</ul>
      );

    case "listItem":
      return (
        <li className={node.checked === null ? undefined : "md-task"} {...attrs}>
          {node.checked === null || node.checked === undefined ? null : (
            <input type="checkbox" checked={node.checked} readOnly tabIndex={-1} />
          )}
          {renderChildren(node)}
        </li>
      );

    case "thematicBreak":
      return <hr {...attrs} />;

    case "break":
      return <br />;

    case "table":
      return (
        <div className="md-copyable">
          <TableCopy node={node} />
          <div className="md-table-wrap">
            <table {...attrs}>
              <thead>
                <Row node={node.children?.[0] as AnnotatedNode | undefined} head />
              </thead>
              <tbody>
                {(node.children ?? []).slice(1).map((row, i) => (
                  <Row key={i} node={row as AnnotatedNode} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );

    case "footnoteReference":
      return <sup {...attrs}>[{node.label ?? node.identifier}]</sup>;

    case "footnoteDefinition":
      return (
        <div className="md-footnote" {...attrs}>
          <span className="md-footnote-id">[{node.label ?? node.identifier}]</span>
          {renderChildren(node)}
        </div>
      );

    case "definition":
      return null;

    default:
      return renderChildren(node as { children?: RootContent[] });
  }
}

function MathTex({ tex, display, attrs }: { tex: string; display: boolean; attrs: Record<string, string | number> }) {
  const [, setLoaded] = useState(katexReady());
  useEffect(() => {
    if (!katexReady()) void loadKatex().then(() => setLoaded(true));
  }, []);
  const html = typeset(tex, display);
  const className = `md-math${display ? " md-math--display" : ""}`;
  const Tag = display ? "div" : "span";
  // Until KaTeX arrives, the formula reads as its source.
  if (html === null) {
    return (
      <Tag className={`${className} md-math--source`} {...attrs}>
        {display ? `$$${tex}$$` : `$${tex}$`}
      </Tag>
    );
  }
  const formula = <Tag className={className} {...attrs} dangerouslySetInnerHTML={{ __html: html }} />;
  if (!display) return formula;
  return (
    <div className="md-copyable">
      <CopyButton text={tex} title="Copy this formula as TeX" />
      {formula}
    </div>
  );
}

type CodeNode = AnnotatedNode & { lang?: string | null; value: string };

function CodeBlock({ node, attrs }: { node: CodeNode; attrs: Record<string, string | number> }) {
  return (
    <div className="md-copyable">
      <CopyButton text={node.value} title="Copy this code" />
      <pre className="md-pre" {...attrs}>
        {node.lang ? <span className="md-code-lang">{node.lang}</span> : null}
        <code className="md-code">
          <span {...{ [LEAF_ATTR]: node.__leafIndex }}>{node.value}</span>
        </code>
      </pre>
    </div>
  );
}

/** A table copies as the Markdown it was written in, which pastes as a table almost anywhere. */
function TableCopy({ node }: { node: AnnotatedNode }) {
  const source = useContext(SourceContext);
  if (node.__srcStart === undefined || node.__srcEnd === undefined) return null;
  return <CopyButton text={source.slice(node.__srcStart, node.__srcEnd)} title="Copy this table as Markdown" />;
}

/**
 * A finished SVG drawn as a picture (P-42), its source one click away. The
 * figure carries the block's source range, so selecting the picture quotes
 * the whole block; the source stays in the page for selecting part of it. An
 * SVG the browser cannot draw falls back to plain code.
 */
function SvgBlock({
  node,
  url,
  attrs,
}: {
  node: CodeNode;
  url: string;
  attrs: Record<string, string | number>;
}) {
  const [broken, setBroken] = useState(false);
  if (broken) return <CodeBlock node={node} attrs={attrs} />;
  return (
    <figure className="md-svg" {...attrs}>
      <div className="md-svg__paper">
        <img className="md-svg__img" src={url} alt="Drawing from this reply" onError={() => setBroken(true)} />
      </div>
      <details className="md-svg__source">
        <summary>SVG source</summary>
        <CodeBlock node={node} attrs={{}} />
      </details>
    </figure>
  );
}

function Row({ node, head }: { node?: AnnotatedNode; head?: boolean }): ReactNode {
  if (!node) return null;
  const cells = (node as { children?: RootContent[] }).children ?? [];
  return (
    <tr {...srcAttrs(node)}>
      {cells.map((cell, i) =>
        head ? (
          <th key={i} {...srcAttrs(cell as AnnotatedNode)}>
            {renderChildren(cell as { children?: RootContent[] })}
          </th>
        ) : (
          <td key={i} {...srcAttrs(cell as AnnotatedNode)}>
            {renderChildren(cell as { children?: RootContent[] })}
          </td>
        ),
      )}
    </tr>
  );
}

export const Markdown = memo(function Markdown({ source, className }: MarkdownProps) {
  const { root } = parseMarkdown(source);
  return (
    <SourceContext.Provider value={source}>
      <div className={className ? `md ${className}` : "md"}>
        {root.children.map((child, i) => (
          <Node key={i} node={child as AnnotatedNode} />
        ))}
      </div>
    </SourceContext.Provider>
  );
});
