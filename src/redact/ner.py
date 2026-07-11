from typing import Optional


class NERRedactor:
    def __init__(self):
        self._nlp: Optional[object] = None

    def _load_model(self):
        if self._nlp is not None:
            return
        try:
            import spacy

            self._nlp = spacy.load("en_core_web_sm")
        except OSError:
            import subprocess
            import sys

            subprocess.check_call([sys.executable, "-m", "spacy", "download", "en_core_web_sm"])
            import spacy

            self._nlp = spacy.load("en_core_web_sm")
        except ImportError:
            self._nlp = None

    def redact_names(self, text: str, placeholders: dict[str, str]) -> str:
        self._load_model()
        if self._nlp is None:
            return text
        doc = self._nlp(text)
        result = list(text)
        offset = 0
        for ent in doc.ents:
            if ent.label_ == "PERSON":
                key = f"[NER_{len(placeholders)}]"
                placeholders[key] = ent.text
                start = ent.start_char + offset
                end = ent.end_char + offset
                orig_len = end - start
                result[start:end] = list(key)
                offset += len(key) - orig_len
        return "".join(result)
