import json
import re
from typing import Optional

DEFAULT_REDACT_TERMS = ["acme corp", "john smith", "jane doe"]

# Structured-PII regex patterns
EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
PHONE_RE = re.compile(r"\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b")
SSN_RE = re.compile(r"\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b")
CC_RE = re.compile(r"\b(?:\d[ -]*?){13,19}\b")
IP_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")

# Negative patterns — things that look like PII but aren't
DATE_LIKE_PHONE = re.compile(r"\d{3}[-.]?\d{2}[-.]?\d{4}")  # false pos for dates
VERSION_NUM = re.compile(r"\bv?\d+\.\d+\.\d+\b")


class RedactionLayer:
    def __init__(self, redact_terms: Optional[list[str]] = None):
        self._terms = redact_terms or list(DEFAULT_REDACT_TERMS)
        self._placeholders: dict[str, str] = {}
        self._request_placeholders: dict[str, str] = {}
        self._ner: Optional["NERRedactor"] = None

    def _init_ner(self):
        if self._ner is None:
            try:
                from src.redact.ner import NERRedactor

                self._ner = NERRedactor()
            except Exception:
                self._ner = None

    def redact(self, text: str) -> str:
        result = text

        # Layer 1: Deterministic dictionary
        for i, term in enumerate(self._terms):
            placeholder = f"[REDACTED_{i}]"
            self._placeholders[placeholder] = term
            flags = re.IGNORECASE
            result = re.sub(
                re.escape(term),
                lambda m: self._replace_case(placeholder, m.group(0)),
                result,
                flags=flags,
            )

        # Layer 2: Structured PII regex
        result = self._redact_re(result, EMAIL_RE, "[EMAIL]")
        result = self._redact_re(result, PHONE_RE, "[PHONE]")
        result = self._redact_re(result, SSN_RE, "[SSN]")
        result = self._redact_re(result, CC_RE, "[CC]")
        result = self._redact_re(result, IP_RE, "[IP]")

        # Layer 3: NER (open-source spaCy)
        self._init_ner()
        if self._ner is not None:
            result = self._ner.redact_names(result, self._request_placeholders)

        return result

    def _redact_re(self, text: str, pattern: re.Pattern, placeholder: str) -> str:
        def replacer(m: re.Match) -> str:
            matched = m.group(0)
            if VERSION_NUM.fullmatch(matched) or DATE_LIKE_PHONE.fullmatch(matched):
                return matched
            return placeholder

        return pattern.sub(replacer, text)

    def _replace_case(self, placeholder: str, original: str) -> str:
        if original.isupper():
            return placeholder.upper()
        if original[0].isupper():
            result = list(placeholder.lower())
            for i, ch in enumerate(original):
                if i < len(result) and ch.isupper() and result[i].islower():
                    result[i] = result[i].upper()
            return "".join(result)
        return placeholder.lower()

    def redact_messages(self, messages: list[dict]) -> list[dict]:
        redacted = []
        for m in messages:
            content = m.get("content", "")
            if isinstance(content, str):
                content = self.redact(content)
            elif isinstance(content, list):
                content = [
                    {
                        "type": item["type"],
                        "text": self.redact(item.get("text", "")) if item.get("text") else item,
                    }
                    for item in content
                ]
            redacted.append({**m, "content": content})
        return redacted

    def rehydrate(self, text: str) -> str:
        result = text
        for placeholder, original in sorted(self._placeholders.items(), key=lambda x: -len(x[0])):
            result = result.replace(placeholder, original)
            result = result.replace(placeholder.upper(), original.upper())
            result = result.replace(placeholder.capitalize(), original.capitalize())
        for placeholder, original in sorted(
            self._request_placeholders.items(), key=lambda x: -len(x[0])
        ):
            result = result.replace(placeholder, original)
        return result

    def rehydrate_response(self, content: str) -> str:
        return self.rehydrate(content)

    def set_request_placeholders(self, placeholders: dict[str, str]):
        self._request_placeholders = placeholders

    def clear_request_placeholders(self):
        self._request_placeholders = {}
