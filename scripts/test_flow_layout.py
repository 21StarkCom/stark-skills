"""Tests for dagre-based flow layout."""

import shutil
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from flow_layout import compute_layout
from flow_schema import FlowDiagram, FlowEdge, FlowNode, FlowPosition


SCRIPTS_DIR = Path(__file__).resolve().parent
HAS_NODE = shutil.which('node') is not None
HAS_DAGRE = (SCRIPTS_DIR / 'node_modules' / 'dagre').exists()


def _node(node_id: str, label: str) -> FlowNode:
    return FlowNode(
        id=node_id,
        type='process',
        label=label,
        position=FlowPosition(x=0, y=0),
    )


def _diagram() -> FlowDiagram:
    return FlowDiagram(
        nodes=[
            FlowNode(id='start', type='start', label='Start', position=FlowPosition(x=0, y=0)),
            _node('process', 'Process'),
            FlowNode(id='end', type='end', label='End', position=FlowPosition(x=0, y=0)),
        ],
        edges=[
            FlowEdge(id='e1', source='start', target='process'),
            FlowEdge(id='e2', source='process', target='end'),
        ],
    )


@pytest.mark.skipif(not HAS_NODE or not HAS_DAGRE, reason='node and scripts/node_modules/dagre are required')
def test_compute_layout_positions_nodes():
    diagram = _diagram()

    positioned = compute_layout(diagram)

    assert positioned is not None
    assert any(node.position.x != 0 or node.position.y != 0 for node in positioned.nodes)
    assert positioned.nodes[0].position.y < positioned.nodes[1].position.y < positioned.nodes[2].position.y


@patch('flow_layout.subprocess.run')
def test_compute_layout_handles_timeout(mock_run: MagicMock, caplog: pytest.LogCaptureFixture):
    mock_run.side_effect = subprocess.TimeoutExpired(cmd=['node'], timeout=10)

    with caplog.at_level('WARNING'):
        positioned = compute_layout(_diagram())

    assert positioned is None
    assert 'timed out' in caplog.text


@patch('flow_layout.subprocess.run')
def test_compute_layout_handles_nonzero_exit(mock_run: MagicMock, caplog: pytest.LogCaptureFixture):
    mock_run.return_value = MagicMock(returncode=1, stdout='', stderr='dagre failed')

    with caplog.at_level('WARNING'):
        positioned = compute_layout(_diagram())

    assert positioned is None
    assert 'exit code 1' in caplog.text
