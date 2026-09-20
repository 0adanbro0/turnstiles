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
  MQTT_HOST: z.string().regex(
    /^(mqtts?|wss?):\/\//,
    'MQTT_HOST must start with mqtt://, mqtts://, ws:// or wss://'
  ),
  ADMIN_API_KEY: z.string().min(16, 'ADMIN_API_KEY must be at least 16 chars'),

  // Логин/пароль бекенда на брокере. В dev можно без них, в production обязательны (см. ниже)
  MQTT_USER: z.string().optional(),
  MQTT_PASS: z.string().optional(),

  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production') {
    for (const key of ['MQTT_USER', 'MQTT_PASS']) {
      if (!env[key]) {
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required in production` });
      }
    }
  }
});

// Валидация при импорте — если невалидно, печатаем список проблем и выходим
const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;

export const isDev = config.NODE_ENV === 'development';