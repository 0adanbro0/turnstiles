import { z } from 'zod';
import { config } from './config.js';

/** 1. Асинхронный обработчик ошибок (чтобы не писать try/catch везде) */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/** 2. Фабрика валидации Zod для Express */
export const validate = (schema, source = 'body') => (req, res, next) => {
  const result = schema.safeParse(req[source]);
  if (!result.success) {
    // Форматируем ошибки Zod в читаемый вид
    const errors = result.error.flatten().fieldErrors;
    return res.status(400).json({ 
      error: 'Validation Failed', 
      details: errors 
    });
  }
  // Подменяем req.body/params/query на валидированные данные (без лишних полей)
  req[source] = result.data;
  next();
};

/** 3. API Key Guard — простая защита для админок */
export const requireApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (!apiKey || apiKey !== config.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API Key' });
  }
  next();
};

/** 4. Глобальный обработчик ошибок */
export const errorHandler = (err, req, res, next) => {
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