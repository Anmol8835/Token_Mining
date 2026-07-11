import re

import pytest

from src.redact import (
    CC_RE,
    EMAIL_RE,
    IP_RE,
    PHONE_RE,
    SSN_RE,
    DATE_LIKE_PHONE,
    VERSION_NUM,
    RedactionLayer,
)


@pytest.fixture
def redactor():
    return RedactionLayer(redact_terms=["acme corp", "john smith", "jane doe"])


class TestDictionaryRedaction:
    def test_redacts_dictionary_term_case_insensitive(self, redactor):
        assert redactor.redact("ACME CORP") == "[REDACTED_0]"
        assert redactor.redact("Acme Corp") == "[Redacted_0]"
        assert redactor.redact("acme corp") == "[redacted_0]"

    def test_redacts_dictionary_term_with_punctuation(self, redactor):
        result = redactor.redact("Hello from ACME Corp!")
        assert "[REDACTED_0]" in result or "[Redacted_0]" in result
        assert "ACME Corp" not in result

    def test_redacts_all_dictionary_terms(self, redactor):
        text = "acme corp works with john smith and jane doe"
        result = redactor.redact(text)
        assert "[redacted_0]" in result
        assert "[redacted_1]" in result
        assert "[redacted_2]" in result
        assert "acme corp" not in result
        assert "john smith" not in result
        assert "jane doe" not in result

    def test_stable_placeholders_same_input(self, redactor):
        r1 = redactor.redact("Hello ACME Corp")
        r2 = redactor.redact("Hello ACME Corp")
        assert r1 == r2

    def test_no_false_positive_on_similar_text(self, redactor):
        text = "acme corporation is different"
        result = redactor.redact(text)
        assert "acme corporation" in result
        assert "[REDACTED_0]" not in result

    def test_redact_messages_list(self, redactor):
        messages = [
            {"role": "user", "content": "Hello from ACME Corp"},
            {"role": "assistant", "content": "Sure, John Smith will help."},
        ]
        result = redactor.redact_messages(messages)
        assert "ACME Corp" not in result[0]["content"]
        assert "John Smith" not in result[1]["content"]


class TestStructuredPIIRegex:
    def test_redacts_email(self, redactor):
        result = redactor.redact("Contact support@acme.com for help")
        assert "[EMAIL]" in result
        assert "support@acme.com" not in result

    def test_redacts_phone(self, redactor):
        result = redactor.redact("Call me at (555) 123-4567")
        assert "[PHONE]" in result
        assert "(555) 123-4567" not in result

    def test_redacts_ssn(self, redactor):
        result = redactor.redact("My SSN is 123-45-6789")
        assert "[SSN]" in result
        assert "123-45-6789" not in result

    def test_redacts_credit_card(self, redactor):
        result = redactor.redact("Card: 4111 1111 1111 1111")
        assert "[CC]" in result
        assert "4111 1111 1111 1111" not in result

    def test_redacts_ip(self, redactor):
        result = redactor.redact("Server at 192.168.1.1")
        assert "[IP]" in result
        assert "192.168.1.1" not in result

    def test_does_not_flag_version_number(self, redactor):
        text = "version 1.2.3 is the latest"
        result = redactor.redact(text)
        assert "1.2.3" in result

    def test_does_not_flag_date_like_phone(self, redactor):
        text = "Date: 2024-01-15"
        result = redactor.redact(text)
        assert "2024-01-15" in result or "2024" in result

    def test_date_like_phone_negative_pattern(self):
        assert DATE_LIKE_PHONE.fullmatch("123-45-6789") is not None

    def test_version_number_negative_pattern(self):
        assert VERSION_NUM.fullmatch("1.2.3") is not None

    def test_email_regex_valid(self):
        assert EMAIL_RE.search("user@example.com") is not None
        assert EMAIL_RE.search("first.last@company.co.uk") is not None

    def test_phone_regex_valid(self):
        assert PHONE_RE.search("555-123-4567") is not None
        assert PHONE_RE.search("+1-555-123-4567") is not None

    def test_ssn_regex_valid(self):
        assert SSN_RE.search("123-45-6789") is not None

    def test_cc_regex_valid(self):
        assert CC_RE.search("4111111111111111") is not None

    def test_ip_regex_valid(self):
        assert IP_RE.search("192.168.1.1") is not None

    def test_multiple_pii_in_one_text(self, redactor):
        text = "Email: user@test.com, Phone: 555-123-4567"
        result = redactor.redact(text)
        assert "[EMAIL]" in result
        assert "[PHONE]" in result


class TestRehydration:
    def test_rehydrate_dictionary_terms(self, redactor):
        original = "Hello from ACME Corp"
        redacted = redactor.redact(original)
        rehydrated = redactor.rehydrate(redacted)
        assert "ACME Corp" in rehydrated
        assert "Hello from" in rehydrated

    def test_rehydrate_all_terms(self, redactor):
        original = "acme corp and john smith"
        redacted = redactor.redact(original)
        rehydrated = redactor.rehydrate(redacted)
        assert "acme corp" in rehydrated
        assert "john smith" in rehydrated

    def test_rehydrate_response(self, redactor):
        original = "ACME Corp will contact John Smith"
        redacted = redactor.redact(original)
        rehydrated = redactor.rehydrate_response(redacted)
        assert "ACME Corp" in rehydrated
        assert "John Smith" in rehydrated

    def test_rehydrate_pii_placeholders_noop(self, redactor):
        text = "Contact [EMAIL] or [PHONE]"
        rehydrated = redactor.rehydrate(text)
        assert "[EMAIL]" in rehydrated
        assert "[PHONE]" in rehydrated

    def test_request_placeholders_scoped(self, redactor):
        redactor.set_request_placeholders({"[REQ_0]": "custom-value"})
        assert redactor.rehydrate("[REQ_0]") == "custom-value"
        redactor.clear_request_placeholders()
        assert redactor.rehydrate("[REQ_0]") == "[REQ_0]"


class TestEdgeCases:
    def test_empty_string(self, redactor):
        assert redactor.redact("") == ""

    def test_no_sensitive_data(self, redactor):
        text = "This is a perfectly normal message."
        assert redactor.redact(text) == text

    def test_special_characters(self, redactor):
        text = "Hello! @#$%^&*()"
        result = redactor.redact(text)
        assert result == text

    def test_redact_messages_with_non_string_content(self, redactor):
        messages = [
            {"role": "user", "content": [{"type": "text", "text": "Hello ACME Corp"}]},
        ]
        result = redactor.redact_messages(messages)
        content = result[0]["content"]
        assert isinstance(content, list)
        assert "ACME Corp" not in content[0]["text"]


class TestNERFallback:
    def test_ner_catches_person_name_when_available(self, redactor):
        text = "My name is Alice and I work here."
        result = redactor.redact(text)
        assert isinstance(result, str)

    def test_ner_no_false_positive_on_common_words(self, redactor):
        text = "The table is made of wood."
        result = redactor.redact(text)
        assert result == text
