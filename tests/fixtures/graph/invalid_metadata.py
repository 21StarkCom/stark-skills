"""Module with invalid metadata values in docstrings."""


class HasInvalidMetadata:
    """Class with bad metadata.

    Depends: valid.dep, invalid dep with spaces, another-bad!val
    Publishes: good.publish
    """

    pass
