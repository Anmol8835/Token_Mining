import numpy as np
from sklearn.feature_extraction.text import HashingVectorizer

EMBEDDING_DIM = 384


class SimulatedEmbedder:
    def __init__(self, dim: int = EMBEDDING_DIM):
        self.dim = dim
        self._vectorizer = HashingVectorizer(
            n_features=dim,
            norm="l2",
            alternate_sign=False,
            analyzer="char_wb",
            ngram_range=(2, 4),
        )

    def embed(self, text: str) -> np.ndarray:
        return self._vectorizer.transform([text]).toarray()[0].astype(np.float32)

    def embed_batch(self, texts: list[str]) -> np.ndarray:
        return self._vectorizer.transform(texts).toarray().astype(np.float32)

    async def close(self):
        pass


class SentenceTransformerEmbedder:
    dim = EMBEDDING_DIM

    def __init__(self):
        from sentence_transformers import SentenceTransformer

        self._model = SentenceTransformer(
            "sentence-transformers/all-MiniLM-L6-v2",
            device="cpu",
        )

    def embed(self, text: str) -> np.ndarray:
        return self._model.encode(text, normalize_embeddings=True).astype(np.float32)

    def embed_batch(self, texts: list[str]) -> np.ndarray:
        return self._model.encode(texts, normalize_embeddings=True).astype(np.float32)

    async def close(self):
        pass


def create_embedder(use_sentence_transformer: bool = False):
    if use_sentence_transformer:
        return SentenceTransformerEmbedder()
    return SimulatedEmbedder()
