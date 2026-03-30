"""Tests for FlowDiagram Pydantic model."""

import logging

import pytest
from pydantic import ValidationError

from flow_schema import FlowDiagram, FlowEdge, FlowNode, FlowPosition


def _pos(x=0, y=0):
    return FlowPosition(x=x, y=y)


def _node(id='n1', type='process', label='Node', **kw):
    return FlowNode(id=id, type=type, label=label, position=_pos(), **kw)


def _edge(id='e1', source='n1', target='n2', **kw):
    return FlowEdge(id=id, source=source, target=target, **kw)


class TestValidDiagram:
    def test_minimal_diagram(self):
        d = FlowDiagram(
            nodes=[_node('start', 'start', 'Begin'), _node('end', 'end', 'Done')],
            edges=[_edge('e1', 'start', 'end')],
        )
        assert d.version == 1
        assert d.direction == 'TB'
        assert len(d.nodes) == 2
        assert len(d.edges) == 1

    def test_full_diagram(self):
        d = FlowDiagram(
            nodes=[
                _node('s', 'start', 'Start'),
                _node('p', 'parallel', 'Fork', category='split'),
                _node('a', 'agent', 'Worker', category='worker'),
                _node('o', 'output', 'Report', category='report'),
                _node('e', 'end', 'End'),
            ],
            edges=[
                _edge('e1', 's', 'p'),
                _edge('e2', 'p', 'a'),
                _edge('e3', 'a', 'o'),
                _edge('e4', 'o', 'e'),
            ],
            direction='LR',
        )
        assert d.direction == 'LR'
        assert len(d.nodes) == 5


class TestDuplicateNodeIDs:
    def test_rejected(self):
        with pytest.raises(ValidationError, match='Duplicate node IDs'):
            FlowDiagram(
                nodes=[_node('n1', 'start', 'A'), _node('n1', 'end', 'B')],
                edges=[_edge('e1', 'n1', 'n1')],
            )


class TestEdgeReferencesNonexistent:
    def test_bad_source(self):
        with pytest.raises(ValidationError, match='references nonexistent node'):
            FlowDiagram(
                nodes=[_node('n1', 'start', 'A')],
                edges=[_edge('e1', 'ghost', 'n1')],
            )

    def test_bad_target(self):
        with pytest.raises(ValidationError, match='references nonexistent node'):
            FlowDiagram(
                nodes=[_node('n1', 'start', 'A')],
                edges=[_edge('e1', 'n1', 'ghost')],
            )


class TestUnknownNodeType:
    def test_accepted_with_warning(self, caplog):
        with caplog.at_level(logging.WARNING):
            node = _node('n1', 'custom_widget', 'Custom')
        assert node.type == 'custom_widget'
        assert 'Unknown node type' in caplog.text


class TestInvalidCategory:
    def test_wrong_category_for_parallel(self):
        with pytest.raises(ValidationError, match='Invalid category'):
            _node('n1', 'parallel', 'Fork', category='worker')

    def test_wrong_category_for_agent(self):
        with pytest.raises(ValidationError, match='Invalid category'):
            _node('n1', 'agent', 'Agent', category='split')

    def test_valid_category_passes(self):
        node = _node('n1', 'output', 'Out', category='file')
        assert node.category == 'file'

    def test_category_on_unconstrained_type(self):
        node = _node('n1', 'process', 'Proc', category='anything')
        assert node.category == 'anything'


class TestNodeIDConstraints:
    def test_too_long(self):
        with pytest.raises(ValidationError, match='Node ID must be'):
            _node('x' * 81)

    def test_invalid_chars(self):
        with pytest.raises(ValidationError, match='Node ID must be'):
            _node('no spaces!')

    def test_valid_with_underscore_and_dash(self):
        node = _node('my-node_01')
        assert node.id == 'my-node_01'


class TestLabelLength:
    def test_node_label_too_long(self):
        with pytest.raises(ValidationError, match='Label exceeds 120'):
            _node('n1', 'process', 'x' * 121)

    def test_edge_label_too_long(self):
        with pytest.raises(ValidationError, match='Edge label exceeds 60'):
            _edge('e1', 'n1', 'n2', label='x' * 61)

    def test_edge_label_at_limit(self):
        edge = _edge('e1', 'n1', 'n2', label='x' * 60)
        assert len(edge.label) == 60


class TestExtraFieldsForbidden:
    def test_node_extra(self):
        with pytest.raises(ValidationError, match='Extra inputs are not permitted'):
            FlowNode(id='n1', type='process', label='N', position=_pos(), color='red')

    def test_edge_extra(self):
        with pytest.raises(ValidationError, match='Extra inputs are not permitted'):
            FlowEdge(id='e1', source='n1', target='n2', weight=5)

    def test_diagram_extra(self):
        with pytest.raises(ValidationError, match='Extra inputs are not permitted'):
            FlowDiagram(
                nodes=[_node('n1', 'start', 'A')],
                edges=[],
                metadata={'foo': 'bar'},
            )

    def test_position_extra(self):
        with pytest.raises(ValidationError, match='Extra inputs are not permitted'):
            FlowPosition(x=0, y=0, z=0)


class TestDuplicateEdgeIDs:
    def test_rejected(self):
        with pytest.raises(ValidationError, match='Duplicate edge IDs'):
            FlowDiagram(
                nodes=[_node('n1', 'start', 'A'), _node('n2', 'end', 'B')],
                edges=[_edge('e1', 'n1', 'n2'), _edge('e1', 'n2', 'n1')],
            )


class TestLimits:
    def test_too_many_nodes(self):
        nodes = [_node(f'n{i}', 'process', f'Node {i}') for i in range(101)]
        with pytest.raises(ValidationError, match='Too many nodes'):
            FlowDiagram(nodes=nodes, edges=[])

    def test_too_many_edges(self):
        nodes = [_node('a', 'start', 'A'), _node('b', 'end', 'B')]
        edges = [_edge(f'e{i}', 'a', 'b') for i in range(201)]
        with pytest.raises(ValidationError, match='Too many edges'):
            FlowDiagram(nodes=nodes, edges=edges)
