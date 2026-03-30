"""FlowDiagram Pydantic model — lightweight copy of stark-data-core canonical schema."""

import logging
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator, model_validator

KNOWN_NODE_TYPES = {'start', 'process', 'decision', 'parallel', 'agent', 'output', 'end'}

ALLOWED_CATEGORIES = {
    'parallel': {'split', 'join'},
    'agent': {'worker', 'explorer'},
    'output': {'file', 'graphql', 'report'},
}


class FlowPosition(BaseModel):
    model_config = ConfigDict(extra='forbid')
    x: float
    y: float


class FlowNode(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str
    type: str
    label: str
    category: str | None = None
    position: FlowPosition

    @field_validator('id')
    @classmethod
    def id_constraints(cls, v):
        if len(v) > 80 or not v.replace('_', '').replace('-', '').isalnum():
            raise ValueError('Node ID must be <=80 chars, alphanumeric with _ and -')
        return v

    @field_validator('type')
    @classmethod
    def check_type(cls, v):
        if v not in KNOWN_NODE_TYPES:
            logging.warning(f'Unknown node type: {v} — will render as process')
        return v

    @field_validator('label')
    @classmethod
    def label_length(cls, v):
        if len(v) > 120:
            raise ValueError('Label exceeds 120 characters')
        return v

    @field_validator('category')
    @classmethod
    def valid_category(cls, v, info):
        if v is None:
            return v
        node_type = info.data.get('type')
        allowed = ALLOWED_CATEGORIES.get(node_type)
        if allowed is None:
            return v
        if v not in allowed:
            raise ValueError(f'Invalid category {v} for type {node_type}; allowed: {allowed}')
        return v


class FlowEdge(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str
    source: str
    target: str
    label: str | None = None

    @field_validator('label')
    @classmethod
    def label_length(cls, v):
        if v is not None and len(v) > 60:
            raise ValueError('Edge label exceeds 60 characters')
        return v


class FlowDiagram(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: Literal[1] = 1
    nodes: list[FlowNode]
    edges: list[FlowEdge]
    direction: Literal['TB', 'LR'] = 'TB'

    @model_validator(mode='after')
    def validate_graph(self):
        ids = [n.id for n in self.nodes]
        if len(ids) != len(set(ids)):
            raise ValueError('Duplicate node IDs')
        edge_ids = [e.id for e in self.edges]
        if len(edge_ids) != len(set(edge_ids)):
            raise ValueError('Duplicate edge IDs')
        node_set = set(ids)
        for e in self.edges:
            if e.source not in node_set:
                raise ValueError(f'Edge source {e.source} references nonexistent node')
            if e.target not in node_set:
                raise ValueError(f'Edge target {e.target} references nonexistent node')
        if len(self.nodes) > 100:
            raise ValueError('Too many nodes (max 100)')
        if len(self.edges) > 200:
            raise ValueError('Too many edges (max 200)')
        return self
