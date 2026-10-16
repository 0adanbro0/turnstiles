// backend/server.js
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config, isDev } from './config.js';
import { connectToMongoDB, User, AccessLog, Device } from './database.js';
import {
  connectToMQTTClient,
  broadcastSystemStatus,
  loadDevices,
  reloadDevice,
  getDevicesSnapshot,
} from './mqtt.js';
import { registerRoutes } from './routes.js';
import { errorHandler, asyncHandler } from './middleware.js';

const app = express();

app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: isDev ? false : undefined,
}));
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    try {
      const url = new URL(origin);
      const hostname = url.hostname;
      const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
      const isPrivateIP = /^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/.test(hostname);
      if (isLocalhost || isPrivateIP) return callback(null, true);
    } catch (e) {}
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: isDev ? 1000 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/health') || req.path.startsWith('/api/connection-to-server'),
});
app.use(limiter);

app.get('/health/live', (req, res) => res.status(200).send('OK'));
app.get('/health/ready', asyncHandler(async (req, res) => {
  if (typeof User.db?.readyState !== 'number' || User.db.readyState !== 1) {
    return res.status(503).json({ status: 'down', db: 'disconnected' });
  }
  res.json({ status: 'up', db: 'connected' });
}));

// --- ИНИЦИАЛИЗАЦИЯ STATE (ОДИН РАЗ) ---
const state = {
  usersLimit: 250,
  counterCurrentUsersNow: 0,
  isLimitWorking: false,
  isEmergencyBool: false,
  isAddingCardBool: false,
  addingCardReaderId: null, // если задан - карты регистрирует только эта читалка

  // Реестр устройств (кэш коллекции Device). Наполняется через loadDevices() ниже.
  // Заменил: currentTimeCard, currentTimeLock, StatusCardModuleConnection,
  // StatusMainLockModuleConnection - теперь статус каждого устройства лежит здесь.
  devices: new Map(),
};

// Делаем доступным для MQTT (broadcast)
global.mqttClient = null; // инициализируется ниже
global.state = state;     // для mqtt.js если он читает оттуда

// --- BOOTSTRAP ---
await connectToMongoDB(config.MONGO_URL);
console.log('[MongoDB] Connected successfully');

// 0. Загружаем известные устройства в память ДО подключения к MQTT
await loadDevices(Device, state);

// 1. MQTT Client (передаем ссылку на state)
global.mqttClient = connectToMQTTClient(config.MQTT_HOST, { User, AccessLog, Device }, state);

// 2. Helpers для роутов
app.locals.broadcastStatus = (emergency, adding) =>
  broadcastSystemStatus(global.mqttClient, emergency, adding, state.devices);
// Вызывать из админки после любого изменения устройства (одобрил, сменил targets, удалил)
app.locals.reloadDevice = (deviceId) => reloadDevice(Device, state, deviceId);
// Список устройств с online-статусом для админки
app.locals.getDevices = () => getDevicesSnapshot(state);

// 3. РОУТЫ (ПЕРЕДАЕМ state ЯВНО)
registerRoutes(app, { User, AccessLog, Device }, state);

// 4. Error Handler
app.use(errorHandler);

const server = app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`🚀 SKUD Backend v2.0 running on port ${config.PORT} (${config.NODE_ENV})`);
  console.log(`🔐 Admin API Key required for mutating endpoints.`);
});

// Graceful Shutdown
const shutdown = async (signal) => {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  server.close(async () => {
    console.log('HTTP server closed.');
    try {
      if (global.mqttClient) await global.mqttClient.endAsync(true);
      console.log('MQTT disconnected.');
      await import('mongoose').then(m => m.default.connection.close());
      console.log('MongoDB disconnected.');
      process.exit(0);
    } catch (e) {
      console.error('Shutdown error:', e);
      process.exit(1);
    }
  });
  setTimeout(() => { console.error('Force exit timeout'); process.exit(1); }, 10000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));