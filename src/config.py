from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ACOS_", env_file=".env")

    premium_api_key: str = ""
    premium_api_base: str = "https://api.openai.com/v1"
    premium_model: str = "gpt-4o"
    cheap_api_key: str = ""
    cheap_api_base: str = "https://api.openai.com/v1"
    cheap_model: str = "gpt-4o-mini"
    redact_terms: str = ""
    host: str = "0.0.0.0"
    port: int = 8080
    log_level: str = "info"


settings = Settings()
