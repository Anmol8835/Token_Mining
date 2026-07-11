import pytest


@pytest.fixture(scope="session")
def real_embedder():
    """Loads the real sentence-transformers model once for the whole test
    session. Loading it costs ~10s of disk I/O; constructing it fresh per
    test (as each caller previously did independently) meant paying that
    cost 5 times per run, which is what made the suite sensitive to
    intermittent slow-disk stalls."""
    try:
        from src.memory.embedder import SentenceTransformerEmbedder
    except ImportError:
        pytest.skip("sentence-transformers not available")
    return SentenceTransformerEmbedder()
