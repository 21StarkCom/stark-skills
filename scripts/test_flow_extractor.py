"""Tests for workflow extraction from SKILL.md files."""

from pathlib import Path

from flow_extractor import (
    _classify_node,
    _derive_edges,
    _detect_direction,
    _generate_node_id,
    extract_workflow,
)
from flow_schema import FlowNode, FlowPosition


ROOT = Path(__file__).resolve().parent.parent


def _skill_path(name: str) -> Path:
    return ROOT / 'skill' / name / 'SKILL.md'


def _node(node_id: str, node_type: str, *, category: str | None = None) -> FlowNode:
    return FlowNode(
        id=node_id,
        type=node_type,
        label=node_id,
        category=category,
        position=FlowPosition(x=0, y=0),
    )


def test_extract_phase_based_skill():
    diagram = extract_workflow(_skill_path('stark-review'))

    assert diagram is not None
    assert diagram.direction == 'TB'
    assert len(diagram.nodes) >= 5
    assert diagram.nodes[0].type == 'start'
    assert any(node.id == 'phase1' for node in diagram.nodes)
    assert any(node.id == 'phase2' for node in diagram.nodes)
    assert diagram.nodes[-1].type == 'end'


def test_extract_step_based_skill():
    diagram = extract_workflow(_skill_path('stark-pr-flow'))

    assert diagram is not None
    assert diagram.nodes[0].id == 'step1'
    assert any(node.id == 'step2' for node in diagram.nodes)
    assert any(node.type == 'decision' for node in diagram.nodes)
    assert any(node.type == 'output' for node in diagram.nodes)


def test_no_workflow_skill_returns_none():
    assert extract_workflow(_skill_path('stark-persona')) is None


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
