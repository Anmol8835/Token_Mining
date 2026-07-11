import uvicorn

from src.config import settings
from src.gateway.server import app


def main():
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level,
    )


if __name__ == "__main__":
    main()
