/**
 * Left-rail tree. Native `<ul role="tree">` + `<li role="treeitem">`.
 *
 * Keyboard model (plan Phase 5 Task 3 / §9):
 *   - Up/Down: move between visible rows
 *   - Right: expand collapsed item or move to first child
 *   - Left: collapse expanded item or move to parent
 *   - Home/End: first / last visible row
 *   - Enter / Space: select (fires `onSelect`)
 *
 * Roving tabindex: one active row carries `tabIndex=0`, the rest carry
 * `tabIndex=-1` so the tree is reachable via Tab in a single hop.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import type { TreeNode } from "../types";
import { flattenTree, type FlatRow } from "../tree_build";

interface Props {
  roots: TreeNode[];
  selectedId: string | null;
  onSelect(node: TreeNode): void;
}

export function Tree({ roots, selectedId, onSelect }: Props): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const init = new Set<string>();
    function seed(node: TreeNode): void {
      if (node.children.length > 0) init.add(node.id);
      for (const c of node.children) seed(c);
    }
    for (const r of roots) seed(r);
    return init;
  });
  // Tracks every node id we've ever seen so we can auto-expand
  // newly-arrived ancestors (live run data loads asynchronously after
  // first render — without this, repo/branch/PR/run nodes appearing in
  // a later TanStack Query result would stay collapsed and their
  // descendants wouldn't be reachable for keyboard nav or DOM queries).
  // Once an id is in `seen`, subsequent updates don't re-add it to
  // `expanded`, preserving any user collapse.
  const seenRef = useRef<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(
    selectedId ?? (roots[0]?.id ?? null),
  );
  const itemRefs = useRef<Map<string, HTMLLIElement>>(new Map());

  useEffect(() => {
    const newlyExpand: string[] = [];
    function walk(node: TreeNode): void {
      if (!seenRef.current.has(node.id)) {
        seenRef.current.add(node.id);
        if (node.children.length > 0) newlyExpand.push(node.id);
      }
      for (const c of node.children) walk(c);
    }
    for (const r of roots) walk(r);
    if (newlyExpand.length > 0) {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const id of newlyExpand) next.add(id);
        return next;
      });
    }
  }, [roots]);

  const flat = useMemo<FlatRow[]>(
    () => flattenTree(roots, expanded),
    [roots, expanded],
  );

  // If the active id disappears (e.g. its parent collapses), fall back
  // to the first visible row.
  useEffect(() => {
    if (activeId === null) return;
    if (!flat.some((r) => r.node.id === activeId)) {
      setActiveId(flat[0]?.node.id ?? null);
    }
  }, [flat, activeId]);

  const focusItem = useCallback((id: string) => {
    const el = itemRefs.current.get(id);
    el?.focus();
  }, []);

  const toggle = useCallback((id: string, open?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      const isOpen = prev.has(id);
      const target = open === undefined ? !isOpen : open;
      if (target) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLUListElement>, row: FlatRow) => {
      const idx = flat.findIndex((r) => r.node.id === row.node.id);
      if (idx < 0) return;
      const move = (i: number) => {
        const r = flat[Math.max(0, Math.min(flat.length - 1, i))];
        if (r) {
          setActiveId(r.node.id);
          focusItem(r.node.id);
        }
      };
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          move(idx + 1);
          return;
        case "ArrowUp":
          event.preventDefault();
          move(idx - 1);
          return;
        case "Home":
          event.preventDefault();
          move(0);
          return;
        case "End":
          event.preventDefault();
          move(flat.length - 1);
          return;
        case "ArrowRight":
          event.preventDefault();
          if (row.hasChildren && !expanded.has(row.node.id)) {
            toggle(row.node.id, true);
          } else if (row.hasChildren) {
            // already open → move to first child
            const child = flat[idx + 1];
            if (child && child.depth === row.depth + 1) {
              setActiveId(child.node.id);
              focusItem(child.node.id);
            }
          }
          return;
        case "ArrowLeft":
          event.preventDefault();
          if (row.hasChildren && expanded.has(row.node.id)) {
            toggle(row.node.id, false);
          } else if (row.parentIds.length > 0) {
            const parentId = row.parentIds[row.parentIds.length - 1]!;
            setActiveId(parentId);
            focusItem(parentId);
          }
          return;
        case "Enter":
        case " ":
          event.preventDefault();
          onSelect(row.node);
          if (row.hasChildren) toggle(row.node.id);
          return;
        default:
          return;
      }
    },
    [flat, expanded, focusItem, onSelect, toggle],
  );

  // Roving tabindex: exactly one row in the visible set carries
  // tabIndex=0 so the tree is reachable via Tab in a single hop. If
  // activeId is missing from the visible list, fall back to the first
  // visible row.
  const effectiveActiveId =
    activeId !== null && flat.some((r) => r.node.id === activeId)
      ? activeId
      : (flat[0]?.node.id ?? null);

  return (
    <nav aria-label="Runs">
      <ul role="tree" aria-label="Runs tree" className="tree">
        {flat.map((row) => (
          <TreeItem
            key={row.node.id}
            row={row}
            isActive={row.node.id === effectiveActiveId}
            isSelected={row.node.id === selectedId}
            expanded={expanded.has(row.node.id)}
            onKeyDown={onKeyDown}
            onActivate={() => {
              setActiveId(row.node.id);
              onSelect(row.node);
              if (row.hasChildren) toggle(row.node.id);
            }}
            registerRef={(el) => {
              if (el) itemRefs.current.set(row.node.id, el);
              else itemRefs.current.delete(row.node.id);
            }}
          />
        ))}
      </ul>
    </nav>
  );
}

interface ItemProps {
  row: FlatRow;
  isActive: boolean;
  isSelected: boolean;
  expanded: boolean;
  onKeyDown(e: KeyboardEvent<HTMLUListElement>, row: FlatRow): void;
  onActivate(): void;
  registerRef(el: HTMLLIElement | null): void;
}

function TreeItem(props: ItemProps): JSX.Element {
  const { row, isActive, isSelected, expanded, onKeyDown, onActivate, registerRef } = props;
  const { node, depth, hasChildren } = row;
  return (
    <li
      ref={registerRef}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={isSelected}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-label={node.ariaLabel ?? node.label}
      tabIndex={isActive ? 0 : -1}
      className={joinClasses(
        "tree-item",
        `tree-item--${node.kind}`,
        isSelected ? "tree-item--selected" : "",
        isActive ? "tree-item--active" : "",
        node.status ? `tree-item--status-${node.status}` : "",
      )}
      style={{ paddingInlineStart: `${depth * 16 + 8}px` }}
      onClick={(e) => {
        e.stopPropagation();
        onActivate();
      }}
      onKeyDown={(e) => onKeyDown(e as unknown as KeyboardEvent<HTMLUListElement>, row)}
    >
      <span className="tree-item__twisty" aria-hidden="true">
        {hasChildren ? (expanded ? "▾" : "▸") : ""}
      </span>
      <span className="tree-item__label">{node.label}</span>
      {node.isLive ? <Pulse /> : null}
    </li>
  );
}

function Pulse(): JSX.Element {
  return (
    <span
      className="pulse"
      role="img"
      aria-label="streaming"
      title="streaming"
    />
  );
}

function joinClasses(...parts: Array<string | undefined>): string {
  return parts.filter((p) => p !== undefined && p.length > 0).join(" ");
}
