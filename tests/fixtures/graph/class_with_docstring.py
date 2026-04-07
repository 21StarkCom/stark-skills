"""Module containing a class with rich docstring metadata."""

import json
from pathlib import Path


class MyService(Path):
    """Service that does things.

    Depends: json, pathlib.Path
    Publishes: MyService.result
    Called by: some.caller
    """

    pass


class NestedOuter:
    """Outer class."""

    class NestedInner:
        """Inner class.

        Depends: json
        """

        pass
