import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';

/** 1. Асинхронный обработчик ошибок (чтобы не писать try/catch везде) */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/** 2. Фабрика валидации Zod для Express */
export const validate = (schema, source = 'body') => (req, res, next) => {
  const result = schema.safeParse(req[source]);
  if (!result.success) {
    // Форматируем ошибки Zod в читаемый вид.
    // fieldErrors - ошибки по полям (как и раньше), formErrors - ошибки всего объекта
    // (например, сообщение из .refine(), которое иначе терялось).
    const { fieldErrors, formErrors } = result.error.flatten();
    return res.status(400).json({
      error: 'Validation Failed',
      details: fieldErrors,
      formErrors,
    });
  }
  // Подменяем req.body/params/query на валидированные данные (без лишних полей)
  req[source] = result.data;
  next();
};

/** Сравнение строк за постоянное время (хэшируем, чтобы длины совпадали и не утекали) */
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

/** 3. API Key Guard — простая защита для админок */
export const requireApiKey = (req, res, next) => {
  // Только заголовок: ключ в query-строке попадает в логи, историю браузера и Referer
  const apiKey = req.get('x-api-key');
  // Если ключ на сервере не настроен, доступ закрыт для всех
  if (!apiKey || !config.ADMIN_API_KEY || !safeEqual(apiKey, config.ADMIN_API_KEY)) {
    return res.status(401).json({ error: 'Invalid or missing API Key' });
  }
  next();
};

/** 4. Глобальный обработчик ошибок */
export const errorHandler = (err, req, res, next) => {
  // Если ответ уже начал уходить, Express должен закрыть соединение сам
  if (res.headersSent) return next(err);

  // Ошибки body-parser (express.json / urlencoded) - это ошибка клиента, а не сервера
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large' });
  }

  console.error('[Global Error]', err?.stack || err);

  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: 'Validation Error', details: err.flatten() });
  }
  if (err.name === 'ValidationError') { // Mongoose
    return res.status(400).json({ error: 'DB Validation Error', details: err.errors });
  }
  if (err.name === 'CastError') { // Mongoose bad ObjectId
    return res.status(400).json({ error: 'Invalid ID format' });
  }
  if (err.code === 11000) { // Mongo Duplicate Key
    return res.status(409).json({ error: 'Duplicate entry', field: err.keyValue });
  }

  res.status(500).json({ error: 'Internal Server Error' });
};