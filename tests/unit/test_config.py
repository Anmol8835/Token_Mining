from src.config import settings


class TestConfig:
    def test_settings_have_defaults(self):
        assert hasattr(settings, "premium_api_key")
        assert settings.premium_model == "gpt-4o"
        assert settings.port == 8080

    def test_settings_from_env(self, monkeypatch):
        monkeypatch.setenv("ACOS_PREMIUM_MODEL", "gpt-4o-mini")
        monkeypatch.setenv("ACOS_PORT", "9090")
        from src.config import Settings

        s = Settings()
        assert s.premium_model == "gpt-4o-mini"
        assert s.port == 9090
