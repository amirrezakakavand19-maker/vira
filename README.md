# Vira Render Server

این سرور برای نسخه فعلی فایل Vira ساخته شده است و APIهایی را که فایل HTML استفاده می‌کند فراهم می‌کند:
- GET /api/health
- POST /api/register
- POST /api/login
- GET /api/kv/:key
- GET /api/kv?prefix=...
- PUT /api/kv/:key
- DELETE /api/kv/:key

## استقرار در Render
1. این پوشه را در یک GitHub repository قرار دهید.
2. در Render یک Blueprint یا Web Service بسازید و `render.yaml` را انتخاب کنید.
3. مقدار `ADMIN_USERNAME` و `ADMIN_PASSWORD` را در Environment تنظیم کنید.
4. بعد از Deploy، آدرس سرویس را بردارید؛ مثل `https://vira-social-server.onrender.com`.
5. در فایل HTML مقدار `window.VIRA_SERVER` را همان آدرس قرار دهید.

PostgreSQL برای ماندگاری اطلاعات در نظر گرفته شده است. اگر DATABASE_URL نباشد، سرور به حافظه موقت برمی‌گردد و برای تولید مناسب نیست.
