/**
 * Точки входа веб-приложения.
 * Добавлять этот файл, ТОЛЬКО если в проекте ещё нет функций doGet и doPost.
 * Если они уже есть (например, для Telegram-бота), этот файл не нужен:
 * в начало существующего doPost добавляется одна строка (см. README).
 */
function doGet(e) {
  return appDoGet_(e);
}

function doPost(e) {
  return appDoPost_(e);
}
