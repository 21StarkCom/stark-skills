"""Pytest config: adds scripts/ to sys.path so `import multi_review` works."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))


@pytest.fixture(autouse=True)
def _clear_config_cache():
    """Reset config_loader's lru_cache between tests to prevent cross-test leaks."""
    import config_loader
    config_loader.load_config.cache_clear()
    yield
    config_loader.load_config.cache_clear()
