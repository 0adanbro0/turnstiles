import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';


// 1. Узнаем, где находится текущий файл (config.js)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 2. Выходим на один уровень вверх ('../.env') и подключаем файл
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  
  // Секреты БЕЗ ФОЛЛБЕКОВ — падаем при старте, если нет
  MONGO_URL: z.string().min(1, 'MONGO_URL is required'),
  MQTT_HOST: z.string().min(1, 'MQTT_HOST is required'),
  ADMIN_API_KEY: z.string().min(16, 'ADMIN_API_KEY must be at least 16 chars'),
  
  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
});

// Валидация при импорте — если невалидно, процесс упадет с понятной ошибкой
export const config = EnvSchema.parse(process.env);

export const isDev = config.NODE_ENV === 'development';