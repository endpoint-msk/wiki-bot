# wiki-bot

Бот, который стримит логи Outline Endpoint в Telegram-канал: публикации, правки с diff, перемещения, архив и удаления.

```bash
cp .env.example .env
docker compose up -d --build
```

Вебхук в Outline: `http://endpoint-wiki-bot:8080/webhook`, события `revisions.create`, `documents.*` кроме create/update/title_change и прав, `collections` целиком.
