"""Extract workflow graphs from skill markdown files."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import ValidationError

from flow_schema import FlowDiagram, FlowEdge, FlowNode, FlowPosition

logger = logging.getLogger(__name__)

_HEADING_RE = re.compile(r'^(#{2,3})\s+(.+?)\s*$')
_PHASE_RE = re.compile(r'^phase\s+(\d+)(?!\.)\b', re.IGNORECASE)
_STEP_RE = re.compile(r'^step\s+(\d+)(?!\.)\b', re.IGNORECASE)
_SUBSTEP_RE = re.compile(r'^(\d+)(?:\.(\d+))+')
_DIRECTION_RE = re.compile(r'<!--\s*flow-direction:\s*(TB|LR)\s*-->', re.IGNORECASE)
_WORKFLOW_PATH_RE = re.compile(r'^workflow_path:\s*(\S.*?)\s*$')

_RELEVANT_L2_RE = re.compile(
    r'^(phase\s+\d+\b|step\s+\d+\b|workflow\b|steps\b|failure modes\b|start mode\b|end mode\b)',
    re.IGNORECASE,
)
_IGNORE_L2_RE = re.compile(
    r'^(arguments\b|constants\b|observability\b|prerequisites\b|overview\b|what\b|why\b|where\b|how\b|config\b|invocation\b)',
    re.IGNORECASE,
)


@dataclass(frozen=True, slots=True)
class Section:
    heading: str
    body: str
    level: int


def _load_override(override_dir: Path, section: str) -> FlowDiagram | None:
    """Load and validate a flow-override JSON file, returning FlowDiagram or None."""
    override_path = override_dir / f'{section}.flow-override.json'
    if not override_path.exists():
        return None
    try:
        data = json.loads(override_path.read_text(encoding='utf-8'))
        diagram = FlowDiagram.model_validate(data)
        logger.info('Loaded override from %s', override_path)
        return diagram
    except (json.JSONDecodeError, ValidationError) as exc:
        logger.warning('Invalid override file %s: %s', override_path, exc)
        return None


def extract_workflow(
    skill_path: Path,
    *,
    override_dir: Path | None = None,
    section: str = 'usage',
) -> FlowDiagram | None:
    """Read a SKILL.md file and extract a flow diagram when possible.

    If *override_dir* is given (or defaults to skill_path's parent), checks for
    ``<section>.flow-override.json`` first. When found and valid, returns that
    diagram directly without extracting from markdown.
    """
    check_dir = override_dir if override_dir is not None else skill_path.parent
    override = _load_override(check_dir, section)
    if override is not None:
        return override

    content = skill_path.read_text(encoding='utf-8')
    sections = _find_workflow_sections(content)
    if not sections:
        logger.info('No workflow sections found in %s', skill_path)
        return None

    nodes: list[FlowNode] = []
    seen_ids: dict[str, int] = {}
    for index, section in enumerate(sections):
        node_type, category = _classify_node(section.body, section.heading)
        if index == 0:
            node_type = 'start'
            category = None
        elif index == len(sections) - 1:
            node_type = 'end'
            category = None

        node_id = _generate_node_id(section.heading, index)
        if node_id in seen_ids:
            seen_ids[node_id] += 1
            node_id = f'{node_id}_{seen_ids[node_id]}'
        else:
            seen_ids[node_id] = 1

        nodes.append(
            FlowNode(
                id=node_id,
                type=node_type,
                label=_normalize_label(section.heading),
                category=category,
                position=FlowPosition(x=0, y=0),
            )
        )

    return FlowDiagram(
        nodes=nodes,
        edges=_derive_edges(nodes),
        direction=_detect_direction(content),
    )


def _find_workflow_sections(content: str) -> list[Section]:
    """Return relevant workflow sections in document order."""
    lines = content.splitlines()
    headings: list[tuple[int, int, str]] = []
    for line_index, line in enumerate(lines):
        match = _HEADING_RE.match(line)
        if not match:
            continue
        level = len(match.group(1))
        heading = match.group(2).strip()
        headings.append((line_index, level, heading))

    sections: list[Section] = []
    for idx, (start_line, level, heading) in enumerate(headings):
        if not _is_relevant_heading(heading, level):
            continue

        end_line = len(lines)
        for next_line, next_level, _ in headings[idx + 1 :]:
            if next_level <= level:
                end_line = next_line
                break

        body = '\n'.join(lines[start_line + 1 : end_line]).strip()
        sections.append(Section(heading=heading, body=body, level=level))

    return sections


def _classify_node(section_text: str, heading: str) -> tuple[str, str | None]:
    """Classify a workflow section into a flow node."""
    heading_lower = heading.lower()
    text_lower = section_text.lower()
    combined = f'{heading_lower}\n{text_lower}'

    if 'start mode' in heading_lower or heading_lower.startswith('start'):
        return 'start', None
    if 'end mode' in heading_lower or any(word in combined for word in (' complete', 'completed', 'done', 'stop here', 'session complete')):
        return 'end', None

    if 'failure modes' in heading_lower or _has_conditional_line(section_text) or '| failure |' in text_lower:
        return 'decision', None

    if 'spawn_agent' in combined:
        return 'agent', 'worker'

    if any(token in combined for token in ('in parallel', 'simultaneously', 'threadpoolexecutor', 'fan-out')):
        return 'parallel', 'split'
    if any(token in combined for token in ('dispatch ', 'dispatches', 'fork ', 'parallel')):
        return 'parallel', 'split'
    if any(token in combined for token in ('wait for', 'join', 'collect results', 'aggregate', 'combine results', 'persist round')):
        return 'parallel', 'join'

    if any(token in combined for token in ('worker', 'explorer', 'agent', 'sub-agent', 'sub-agents')):
        category = 'explorer' if 'explorer' in combined else 'worker'
        return 'agent', category

    output_category = _detect_output_category(combined)
    if output_category is not None:
        return 'output', output_category

    return 'process', None


def _derive_edges(nodes: list[FlowNode]) -> list[FlowEdge]:
    """Build deterministic edges from classified nodes."""
    edges: list[FlowEdge] = []
    for index, node in enumerate(nodes[:-1]):
        next_node = nodes[index + 1]

        if node.type == 'decision':
            edges.append(_edge(node.id, next_node.id, len(edges), 'Yes'))
            if index + 2 < len(nodes):
                edges.append(_edge(node.id, nodes[index + 2].id, len(edges), 'No'))
            continue

        if node.type == 'parallel' and node.category == 'split':
            fan_targets = _fan_out_targets(nodes, index)
            for target in fan_targets:
                edges.append(_edge(node.id, target.id, len(edges), None))
            continue

        if (
            index > 0
            and nodes[index - 1].type == 'parallel'
            and nodes[index - 1].category == 'split'
            and node.type == 'agent'
            and next_node.type == 'agent'
        ):
            continue

        edges.append(_edge(node.id, next_node.id, len(edges), None))

    return edges


def _generate_node_id(heading: str, index: int) -> str:
    """Generate a deterministic schema-compliant node id."""
    normalized = _normalize_label(heading)

    phase_match = _PHASE_RE.match(normalized)
    if phase_match:
        return f'phase{phase_match.group(1)}'

    step_match = _STEP_RE.match(normalized)
    if step_match:
        return f'step{step_match.group(1)}'

    substep_match = _SUBSTEP_RE.match(normalized)
    if substep_match:
        numbers = re.findall(r'\d+', substep_match.group(0))
        if len(numbers) >= 2:
            return f'phase{numbers[0]}_step{numbers[1]}'

    slug = re.sub(r'[^a-z0-9]+', '_', normalized.lower()).strip('_')
    if not slug:
        slug = f'node_{index + 1}'
    if slug[0].isdigit():
        slug = f'node_{slug}'
    if len(slug) > 72:
        slug = slug[:72].rstrip('_')
    return f'{slug}_{index + 1}'


def _detect_direction(content: str) -> Literal['TB', 'LR']:
    """Read an optional flow-direction override from an HTML comment."""
    match = _DIRECTION_RE.search(content)
    if not match:
        return 'TB'
    return match.group(1).upper()  # type: ignore[return-value]


def resolve_workflow_path(skill_root: Path) -> Path:
    """Return the workflow markdown path for a skill directory.

    Defaults to ``<skill_root>/SKILL.md``. If SKILL.md frontmatter contains
    ``workflow_path:`` (relative to skill_root), returns that path instead.
    """
    skill_md = skill_root / 'SKILL.md'
    if not skill_md.exists():
        return skill_md
    relpath = _read_workflow_path_frontmatter(skill_md)
    if relpath is None:
        return skill_md
    return skill_root / relpath


def extract_skill_workflow(
    skill_root: Path,
    *,
    section: str = 'usage',
) -> FlowDiagram | None:
    """Resolve a skill's workflow path and extract its diagram.

    Override JSON files are always looked up at ``skill_root`` regardless of
    where the workflow markdown actually lives.
    """
    workflow_path = resolve_workflow_path(skill_root)
    if not workflow_path.exists():
        logger.info('Workflow file %s not found for %s', workflow_path, skill_root)
        return None
    return extract_workflow(workflow_path, override_dir=skill_root, section=section)


def extract_all(skill_dir: Path) -> dict[str, FlowDiagram | None]:
    """Extract workflows for every skill directory under skill/."""
    diagrams: dict[str, FlowDiagram | None] = {}
    skill_roots = sorted(p for p in skill_dir.iterdir() if p.is_dir() and (p / 'SKILL.md').exists())
    for skill_root in skill_roots:
        diagrams[skill_root.name] = extract_skill_workflow(skill_root)
    return diagrams


def _read_workflow_path_frontmatter(skill_md: Path) -> str | None:
    """Parse only the ``workflow_path`` key from SKILL.md YAML frontmatter."""
    with skill_md.open(encoding='utf-8') as handle:
        first = handle.readline()
        if first.strip() != '---':
            return None
        for line in handle:
            stripped = line.rstrip('\n')
            if stripped.strip() == '---':
                return None
            match = _WORKFLOW_PATH_RE.match(stripped)
            if match:
                value = match.group(1).strip().strip('"').strip("'")
                return value or None
    return None


def _is_relevant_heading(heading: str, level: int) -> bool:
    if level == 2:
        if _IGNORE_L2_RE.match(heading):
            return False
        return bool(_RELEVANT_L2_RE.match(heading))
    return bool(_SUBSTEP_RE.match(heading))


def _normalize_label(heading: str) -> str:
    text = re.sub(r'^#+\s*', '', heading.strip())
    return re.sub(r'\s+', ' ', text.strip('` ').replace('—', '-').replace('–', '-')).strip()


def _has_conditional_line(section_text: str) -> bool:
    for line in section_text.splitlines():
        stripped = line.strip().lstrip('-*0123456789. ')
        if re.match(r'^(if|when|otherwise|on\s+\w+)', stripped, re.IGNORECASE):
            return True
    return False


def _detect_output_category(combined: str) -> str | None:
    if any(token in combined for token in ('graphql', 'mutation', 'gh api', 'github_projects.', 'pr create', 'pr merge')):
        return 'graphql'
    if any(token in combined for token in ('write ', 'writes ', 'create ', 'creates ', 'copy ', 'generate ', 'emit ', 'commit', '.md', '.json', 'mkdocs.yml')):
        return 'file'
    if any(token in combined for token in ('report', 'summary', 'briefing', 'headline counts')):
        return 'report'
    return None


def _fan_out_targets(nodes: list[FlowNode], index: int) -> list[FlowNode]:
    targets: list[FlowNode] = []
    cursor = index + 1
    while cursor < len(nodes) and nodes[cursor].type == 'agent':
        targets.append(nodes[cursor])
        cursor += 1
    if not targets and index + 1 < len(nodes):
        targets.append(nodes[index + 1])
    return targets


def _edge(source: str, target: str, index: int, label: str | None) -> FlowEdge:
    return FlowEdge(
        id=f'e{index + 1}_{source}_to_{target}',
        source=source,
        target=target,
        label=label,
    )
