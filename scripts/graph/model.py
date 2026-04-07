"""Graph and report models for stark-graph pipeline."""

from __future__ import annotations

from pathlib import Path
from typing import Literal, Optional, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, model_validator


class Node(BaseModel):
    model_config = ConfigDict(extra='forbid')

    id: str
    layer: Literal["module", "class"]
    parent: Optional[str] = None
    depends: list[str] = []
    publishes: list[str] = []
    called_by: list[str] = []
    file_path: str
    line: int


class Edge(BaseModel):
    model_config = ConfigDict(extra='forbid')

    source: str
    target: str
    type: str
    origin: Literal["ast", "docstring"]


class Graph(BaseModel):
    model_config = ConfigDict(extra='forbid')

    schema_version: str
    repo: str
    nodes: list[Node]
    edges: list[Edge]
    partial: bool = False
    skipped_files: list[str] = []

    @model_validator(mode='after')
    def reject_unknown_version(self) -> Graph:
        if self.schema_version != "1.0":
            raise ValueError(
                f"Unsupported schema_version {self.schema_version!r}; expected '1.0'"
            )
        return self


class ValidationReport(BaseModel):
    model_config = ConfigDict(extra='forbid')

    graph_repo: str
    errors: list[str] = []
    warnings: list[str] = []
    dismissed: list[str] = []
    node_count: int = 0
    edge_count: int = 0


class DiffReport(BaseModel):
    model_config = ConfigDict(extra='forbid')

    base_ref: str
    head_ref: str
    added_nodes: list[str] = []
    removed_nodes: list[str] = []
    added_edges: list[str] = []
    removed_edges: list[str] = []
    blast_radius: list[str] = []


@runtime_checkable
class Parser(Protocol):
    def parse(self, paths: list[Path], repo: str) -> "Graph": ...
    def language(self) -> str: ...
    def file_patterns(self) -> list[str]: ...
