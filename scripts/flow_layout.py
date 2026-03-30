"""Compute FlowDiagram node positions with a dagre subprocess."""

from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path

from flow_schema import FlowDiagram, FlowPosition

logger = logging.getLogger(__name__)

NODE_WIDTH = 220
NODE_HEIGHT = 52
DAGRE_TIMEOUT_SECONDS = 10
DAGRE_JS = Path(__file__).with_name('dagre_layout.js')


def compute_layout(diagram: FlowDiagram) -> FlowDiagram | None:
    """Run dagre layout on a FlowDiagram. Returns positioned diagram or None on failure."""
    payload = {
        'nodes': [
            {
                'id': node.id,
                'width': NODE_WIDTH,
                'height': NODE_HEIGHT,
            }
            for node in diagram.nodes
        ],
        'edges': [
            {
                'source': edge.source,
                'target': edge.target,
            }
            for edge in diagram.edges
        ],
        'config': {
            'rankdir': diagram.direction,
        },
    }
    json_input = json.dumps(payload)

    try:
        result = subprocess.run(
            ['node', str(DAGRE_JS)],
            input=json_input,
            capture_output=True,
            text=True,
            timeout=DAGRE_TIMEOUT_SECONDS,
            cwd=str(DAGRE_JS.parent),
        )
    except subprocess.TimeoutExpired:
        logger.warning('Dagre layout timed out after %ss for diagram with %s nodes', DAGRE_TIMEOUT_SECONDS, len(diagram.nodes))
        return None
    except OSError as exc:
        logger.warning('Failed to start dagre layout subprocess: %s', exc)
        return None

    if result.returncode != 0:
        logger.warning('Dagre layout failed with exit code %s: %s', result.returncode, result.stderr.strip())
        return None

    try:
        output = json.loads(result.stdout)
        positions = {
            node['id']: FlowPosition(x=node['x'], y=node['y'])
            for node in output['nodes']
        }
    except (KeyError, TypeError, ValueError) as exc:
        logger.warning('Dagre layout returned invalid JSON: %s', exc)
        return None

    try:
        for node in diagram.nodes:
            node.position = positions[node.id]
    except KeyError as exc:
        logger.warning('Dagre layout output missing node position for %s', exc.args[0])
        return None

    return diagram
