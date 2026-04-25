"""Tests for workflow extraction from SKILL.md files."""

import json
from pathlib import Path

import pytest

from flow_extractor import (
    _classify_node,
    _derive_edges,
    _detect_direction,
    _generate_node_id,
    _load_override,
    extract_skill_workflow,
    extract_workflow,
    resolve_workflow_path,
)
from flow_schema import FlowNode, FlowPosition


ROOT = Path(__file__).resolve().parent.parent


def _skill_path(name: str) -> Path:
    return ROOT / 'skill' / name / 'SKILL.md'


def _skill_root(name: str) -> Path:
    return ROOT / 'skill' / name


def _node(node_id: str, node_type: str, *, category: str | None = None) -> FlowNode:
    return FlowNode(
        id=node_id,
        type=node_type,
        label=node_id,
        category=category,
        position=FlowPosition(x=0, y=0),
    )


def test_extract_phase_based_skill():
    diagram = extract_skill_workflow(_skill_root('stark-team-review'))

    assert diagram is not None
    assert diagram.direction == 'TB'
    assert len(diagram.nodes) >= 5
    assert diagram.nodes[0].type == 'start'
    assert any(node.id == 'phase1' for node in diagram.nodes)
    assert any(node.id == 'phase2' for node in diagram.nodes)
    assert diagram.nodes[-1].type == 'end'


def test_resolve_workflow_path_uses_frontmatter_override():
    # stark-team-review declares workflow_path: references/workflow.md in frontmatter
    resolved = resolve_workflow_path(_skill_root('stark-team-review'))
    assert resolved == ROOT / 'skill' / 'stark-team-review' / 'references' / 'workflow.md'


def test_resolve_workflow_path_defaults_to_skill_md():
    resolved = resolve_workflow_path(_skill_root('stark-pr-flow'))
    assert resolved == ROOT / 'skill' / 'stark-pr-flow' / 'SKILL.md'


def test_extract_step_based_skill():
    diagram = extract_workflow(_skill_path('stark-pr-flow'))

    assert diagram is not None
    assert diagram.nodes[0].id == 'step1'
    assert any(node.id == 'step2' for node in diagram.nodes)
    assert any(node.type == 'decision' for node in diagram.nodes)
    assert any(node.type == 'output' for node in diagram.nodes)


def test_no_workflow_skill_returns_none(tmp_path):
    """Skill with no workflow AND no override file returns None."""
    # Use empty override_dir to bypass stark-persona's override file
    assert extract_workflow(_skill_path('stark-persona'), override_dir=tmp_path) is None


def test_classify_node_variants():
    assert _classify_node('If auth fails, skip PR info.', 'Failure Modes')[0] == 'decision'
    assert _classify_node('Dispatch 3 agents in parallel.', 'Phase 2')[0:2] == ('parallel', 'split')
    assert _classify_node('Spawn_agent worker to inspect files.', 'Phase 3')[0:2] == ('agent', 'worker')
    assert _classify_node('Write round data to report.json', 'Phase 4')[0:2] == ('output', 'file')


def test_generate_node_id_is_deterministic():
    assert _generate_node_id('### 1.2 Detect repo', 4) == 'phase1_step2'
    assert _generate_node_id('## Step 3: Create PR', 2) == 'step3'
    assert _generate_node_id('## Start Mode', 0) == _generate_node_id('## Start Mode', 0)


def test_detect_direction_override():
    content = '# Skill\n\n<!-- flow-direction: LR -->\n\n## Step 1: Start\n'
    assert _detect_direction(content) == 'LR'
    assert _detect_direction('# Skill\n\n## Step 1: Start\n') == 'TB'


def test_derive_edges_for_sequential_nodes():
    nodes = [
        _node('step1', 'start'),
        _node('step2', 'process'),
        _node('step3', 'end'),
    ]

    edges = _derive_edges(nodes)

    assert [(edge.source, edge.target, edge.label) for edge in edges] == [
        ('step1', 'step2', None),
        ('step2', 'step3', None),
    ]


# --- Override file tests ---


def test_override_file_used_when_present():
    """stark-persona has usage.flow-override.json; extract_workflow should return it."""
    diagram = extract_workflow(_skill_path('stark-persona'))

    assert diagram is not None
    assert len(diagram.nodes) == 3
    assert diagram.nodes[0].id == 'invoke'
    assert diagram.nodes[0].type == 'start'
    assert diagram.nodes[2].id == 'apply'
    assert diagram.nodes[2].type == 'output'
    assert diagram.nodes[2].category == 'file'
    assert len(diagram.edges) == 2


def test_override_file_explicit_override_dir(tmp_path):
    """Override dir can be passed explicitly."""
    override_data = {
        'version': 1,
        'direction': 'LR',
        'nodes': [
            {'id': 'a', 'type': 'start', 'label': 'A', 'position': {'x': 0, 'y': 0}},
            {'id': 'b', 'type': 'end', 'label': 'B', 'position': {'x': 100, 'y': 0}},
        ],
        'edges': [{'id': 'a-b', 'source': 'a', 'target': 'b'}],
    }
    (tmp_path / 'usage.flow-override.json').write_text(json.dumps(override_data))

    diagram = extract_workflow(resolve_workflow_path(_skill_root('stark-team-review')), override_dir=tmp_path)

    assert diagram is not None
    assert diagram.direction == 'LR'
    assert len(diagram.nodes) == 2
    assert diagram.nodes[0].id == 'a'


def test_override_internals_section(tmp_path):
    """section='internals' looks for internals.flow-override.json."""
    override_data = {
        'version': 1,
        'nodes': [
            {'id': 'x', 'type': 'start', 'label': 'X', 'position': {'x': 0, 'y': 0}},
            {'id': 'y', 'type': 'end', 'label': 'Y', 'position': {'x': 0, 'y': 100}},
        ],
        'edges': [{'id': 'x-y', 'source': 'x', 'target': 'y'}],
    }
    (tmp_path / 'internals.flow-override.json').write_text(json.dumps(override_data))

    diagram = extract_workflow(
        resolve_workflow_path(_skill_root('stark-team-review')),
        override_dir=tmp_path,
        section='internals',
    )

    assert diagram is not None
    assert diagram.nodes[0].id == 'x'


def test_override_invalid_json_falls_back(tmp_path):
    """Invalid JSON in override file falls back to extraction."""
    (tmp_path / 'usage.flow-override.json').write_text('{not valid json}')

    diagram = extract_workflow(resolve_workflow_path(_skill_root('stark-team-review')), override_dir=tmp_path)

    # Falls back to markdown extraction, which succeeds for stark-team-review
    assert diagram is not None
    assert len(diagram.nodes) >= 5


def test_override_invalid_schema_falls_back(tmp_path):
    """Override file with valid JSON but invalid schema falls back to extraction."""
    bad_data = {'version': 1, 'nodes': [], 'edges': [{'id': 'e1', 'source': 'missing', 'target': 'also_missing'}]}
    (tmp_path / 'usage.flow-override.json').write_text(json.dumps(bad_data))

    diagram = extract_workflow(resolve_workflow_path(_skill_root('stark-team-review')), override_dir=tmp_path)

    assert diagram is not None
    assert len(diagram.nodes) >= 5


def test_load_override_nonexistent_dir(tmp_path):
    """_load_override returns None when directory has no override file."""
    assert _load_override(tmp_path, 'usage') is None


def test_no_override_falls_through():
    """Without an override JSON, stark-team-review extracts from its workflow markdown."""
    diagram = extract_skill_workflow(_skill_root('stark-team-review'))

    assert diagram is not None
    assert len(diagram.nodes) >= 5
