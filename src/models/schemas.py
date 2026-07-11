from pydantic import BaseModel, Field


class ChatCompletionRequest(BaseModel):
    messages: list[dict] = Field(..., min_length=1)
    stream: bool = False
    temperature: float = 0.7
    max_tokens: int = 2048
