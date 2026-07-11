import numpy as np
import pytest

from src.memory.embedder import EMBEDDING_DIM, SimulatedEmbedder


@pytest.fixture
def embedder():
    return SimulatedEmbedder()


class TestSimulatedEmbedder:
    def test_deterministic(self, embedder):
        v1 = embedder.embed("hello world")
        v2 = embedder.embed("hello world")
        np.testing.assert_array_equal(v1, v2)

    def test_dimension(self, embedder):
        v = embedder.embed("test")
        assert v.shape == (EMBEDDING_DIM,)

    def test_normalized(self, embedder):
        v = embedder.embed("some text")
        norm = np.linalg.norm(v)
        assert abs(norm - 1.0) < 1e-5

    def test_different_inputs_different_vectors(self, embedder):
        v1 = embedder.embed("hello")
        v2 = embedder.embed("world")
        sim = float(v1 @ v2)
        assert sim < 0.95

    def test_batch_embedding(self, embedder):
        texts = ["hello", "world", "test"]
        vectors = embedder.embed_batch(texts)
        assert vectors.shape == (3, EMBEDDING_DIM)

    def test_similar_texts_have_higher_similarity(self, embedder):
        v1 = embedder.embed("FastAPI framework for building APIs")
        v2 = embedder.embed("FastAPI is a web framework for APIs")
        v3 = embedder.embed("the weather is nice today")
        sim_similar = float(v1 @ v2)
        sim_different = float(v1 @ v3)
        assert sim_similar > sim_different


class TestSentenceTransformerEmbedder:
    @pytest.fixture
    def st_embedder(self, real_embedder):
        return real_embedder

    def test_deterministic(self, st_embedder):
        v1 = st_embedder.embed("hello world")
        v2 = st_embedder.embed("hello world")
        np.testing.assert_array_almost_equal(v1, v2, decimal=5)

    def test_dimension(self, st_embedder):
        v = st_embedder.embed("test")
        assert v.shape == (EMBEDDING_DIM,)

    def test_normalized(self, st_embedder):
        v = st_embedder.embed("some text")
        norm = np.linalg.norm(v)
        assert abs(norm - 1.0) < 1e-5
